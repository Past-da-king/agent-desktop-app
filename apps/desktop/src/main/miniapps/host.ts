/**
 * The bridge's far end (docs/plans/mini-apps.md): every message a mini-app sends through agent.js lands here, is
 * checked against the app's own permissions, and runs through the SAME tools agents use (their account rules and
 * approval cards included). An app reads what its permissions grant; anything that changes something asks him first
 * on a card, unless he allowed that one thing for that app in the window. Nothing else is reachable.
 *
 * Each app is one plugin on the PluginHost (plugin-host.ts): its open sessions, their subscriptions and refresh
 * timers are effects of it, so an edit (reload) or a delete (unload) takes them all away. Nothing runs for an app
 * that is not open: no background data use.
 */
import type { JsonObject, MiniAppRow } from '@agent/core'

import { checkCall, lintMiniApp, MINIAPP_RATE, topicAllowed } from '../../shared/miniapps'
import type { MiniAppStore } from './store'
import { createPluginHost, type PluginHost, type Scope } from './plugin-host'

export type SessionMode = 'window' | 'check' | 'device'

/** A message from the app (agent.js). */
export interface BridgeMessage {
  op?: unknown
  id?: unknown
  tool?: unknown
  args?: unknown
  topic?: unknown
  key?: unknown
  value?: unknown
  text?: unknown
}

export interface BridgeReply {
  op: 'reply'
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

export type Push = (message: { op: 'event'; topic: string; data: unknown } | { op: 'theme'; dark: boolean; accent: string }) => void

export interface MiniAppHostDeps {
  apps: MiniAppStore
  /** Row changes in the local store (db.ts Store.onChange). */
  onRowsChange: (listener: (change?: { entity?: string; id?: string; deleted?: boolean; reset?: boolean }) => void) => () => void
  /** Runs one tool as the app (its profile's accounts), the same tool agents call. */
  runTool: (app: MiniAppRow, tool: string, args: JsonObject, signal: AbortSignal) => Promise<string>
  /** An approval card in his chat; resolves with his decision. */
  approve: (app: MiniAppRow, summary: string, details: string, signal: AbortSignal) => Promise<boolean>
  /**
   * Whether a granted call only reads, when its name alone cannot tell: a learned app's tool says so itself
   * (webapp_run of a read_only tool). null: not known, so it counts as a change and asks.
   */
  reads?: (tool: string, args: JsonObject) => boolean | null
  /** Hands a line from the app to his agent (agent.ask). */
  ask?: (app: MiniAppRow, text: string) => Promise<void>
  /** His calendars changed (presence/calendar.ts CalendarCache.onChange). */
  onCalendarChange?: (listener: () => void) => () => void
  /** A background worker emitted an event. */
  onWorkerEvent?: (listener: (worker: string, event: unknown) => void) => () => void
  host?: PluginHost
  now?: () => number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

interface Session {
  id: string
  app: string
  mode: SessionMode
  push: Push
  scope: Scope
  stopSession: () => void
  topics: Map<string, () => void>
  /** Check sessions: what the app logged as errors, and calls it could not make. */
  errors: string[]
  refused: string[]
  calls: number
  /** Check sessions keep agent.store writes in memory only. */
  scratch: Map<string, string | null>
  controller: AbortController
}

interface Plugin {
  app: MiniAppRow
  scope: Scope
  sessions: Set<Session>
}

const DATA_TOPICS: Record<string, string> = { 'data.task': 'task', 'data.goal': 'goal', 'data.trigger': 'trigger', 'data.memory': 'memory' }

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export class MiniAppHost {
  readonly engine: PluginHost
  private readonly deps: MiniAppHostDeps
  private readonly now: () => number
  private readonly log: (message: string, detail?: Record<string, unknown>) => void
  private readonly plugins = new Map<string, Plugin>()
  private readonly sessions = new Map<string, Session>()
  private readonly calls = new Map<string, number[]>()
  private offRows: (() => void) | null = null
  private seq = 0

  constructor(deps: MiniAppHostDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (() => undefined)
    this.engine = deps.host ?? createPluginHost(this.log)
    // Host services the plugins inject (the plain engine hands them over the same way).
    this.engine.provide('miniappStore', deps.apps)
  }

  /** Loads every saved app and follows their rows: a new version reloads its plugin, a deleted row unloads it. */
  async start(): Promise<void> {
    for (const app of await this.deps.apps.list()) this.load(app)
    this.offRows = this.deps.onRowsChange((change) => {
      if (change === undefined || change.entity === 'miniapp' || change.reset === true) void this.sync()
    })
  }

  async stop(): Promise<void> {
    this.offRows?.()
    this.offRows = null
    for (const plugin of [...this.plugins.values()]) await plugin.scope.dispose()
    this.plugins.clear()
    this.sessions.clear()
    await this.engine.dispose()
  }

  /** What is loaded now (tests and the Apps page's "running" line). */
  loaded(): Array<{ id: string; version: number; sessions: number }> {
    return [...this.plugins.values()].map((plugin) => ({ id: plugin.app.id, version: plugin.app.version, sessions: plugin.sessions.size }))
  }

  private async sync(): Promise<void> {
    const rows = await this.deps.apps.list()
    const ids = new Set(rows.map((app) => app.id))
    for (const [id, plugin] of this.plugins) if (!ids.has(id)) await this.unload(id, plugin, 'app.deleted')
    for (const app of rows) {
      const plugin = this.plugins.get(app.id)
      if (plugin === undefined) this.load(app)
      else if (plugin.app.version !== app.version || JSON.stringify(plugin.app.permissions) !== JSON.stringify(app.permissions) || JSON.stringify(plugin.app.subscribe) !== JSON.stringify(app.subscribe)) {
        await this.unload(app.id, plugin, 'app.changed')
        this.load(app)
      } else {
        // Same code: keep it loaded, but read pins, allowed tools and data from the row as it is now.
        plugin.app = app
      }
    }
  }

  private load(app: MiniAppRow): void {
    if (this.plugins.has(app.id)) return
    // Whatever wrote the row (an older build, another device, a hand edit), an app that fails the checks never runs.
    const findings = lintMiniApp(app)
    if (findings.length > 0) {
      this.log('Mini-app not loaded: it does not pass the checks', { app: app.id, first: findings[0]?.text ?? '' })
      return
    }
    const plugin: Plugin = { app, scope: null as unknown as Scope, sessions: new Set() }
    plugin.scope = this.engine.load(`miniapp:${app.id}`, ['miniappStore'], (scope) => {
      // The plugin's one standing effect: it is in the registry while it is loaded, and leaves it when unloaded.
      scope.effect(() => {
        this.plugins.set(app.id, plugin)
        return () => {
          if (this.plugins.get(app.id) === plugin) this.plugins.delete(app.id)
        }
      }, 'registry')
    })
  }

  private async unload(id: string, plugin: Plugin, why: 'app.changed' | 'app.deleted'): Promise<void> {
    for (const session of [...plugin.sessions]) {
      try {
        session.push({ op: 'event', topic: why, data: { id } })
      } catch {
        // A closed frame cannot be told; it is going anyway.
      }
    }
    await plugin.scope.dispose()
    this.plugins.delete(id)
  }

  /**
   * Makes sure this version of the app is loaded now (a save is followed at once by its look check, before the row
   * change has reached the host): loads it, or reloads an older loaded version.
   */
  async ensure(app: MiniAppRow): Promise<void> {
    const plugin = this.plugins.get(app.id)
    if (plugin !== undefined && plugin.app.version === app.version) {
      plugin.app = app
      return
    }
    if (plugin !== undefined) await this.unload(app.id, plugin, 'app.changed')
    this.load(app)
  }

  /** A frame opened the app. Null when there is no such app. */
  openSession(appId: string, push: Push, mode: SessionMode): string | null {
    const plugin = this.plugins.get(appId)
    if (plugin === undefined || !plugin.scope.active) return null
    this.seq += 1
    const id = `s${this.now().toString(36)}${this.seq}`
    const session: Session = {
      id,
      app: appId,
      mode,
      push,
      scope: plugin.scope,
      stopSession: () => undefined,
      topics: new Map(),
      errors: [],
      refused: [],
      calls: 0,
      scratch: new Map(),
      controller: new AbortController(),
    }
    session.stopSession = plugin.scope.effect(() => {
      plugin.sessions.add(session)
      this.sessions.set(id, session)
      // Refresh while open only: every refreshMinutes, the app hears "refresh".
      const minutes = plugin.app.refreshMinutes
      const timer = minutes > 0 ? setInterval(() => this.emit(session, 'refresh', { at: this.now() }), minutes * 60_000) : null
      timer?.unref?.()
      return () => {
        if (timer !== null) clearInterval(timer)
        for (const off of session.topics.values()) off()
        session.topics.clear()
        session.controller.abort()
        plugin.sessions.delete(session)
        this.sessions.delete(id)
      }
    }, `session ${id}`)
    if (mode !== 'check') void this.deps.apps.opened(appId)
    return id
  }

  closeSession(sessionId: string): void {
    this.sessions.get(sessionId)?.stopSession()
  }

  /** What a check session saw (errors the app threw, calls refused). */
  sessionReport(sessionId: string): { errors: string[]; refused: string[]; calls: number } | null {
    const session = this.sessions.get(sessionId)
    return session === undefined ? null : { errors: [...session.errors], refused: [...session.refused], calls: session.calls }
  }

  private emit(session: Session, topic: string, data: unknown): void {
    try {
      session.push({ op: 'event', topic, data })
    } catch (error) {
      this.log('Mini-app event not delivered', { app: session.app, topic, message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** One message from the app. Returns the reply to send back, or null when the message wants none. */
  async handle(sessionId: string, raw: BridgeMessage): Promise<BridgeReply | null> {
    const session = this.sessions.get(sessionId)
    const op = str(raw.op)
    const id = typeof raw.id === 'number' ? raw.id : 0
    const fail = (error: string): BridgeReply => ({ op: 'reply', id, ok: false, error })
    if (session === undefined) return id === 0 ? null : fail('This app is closed.')
    const plugin = this.plugins.get(session.app)
    if (plugin === undefined) return id === 0 ? null : fail('This app is gone.')
    const app = plugin.app
    switch (op) {
      case 'hello':
        return null
      case 'ready':
        // The app drew its first data (agent.ready()): the look check takes its screenshot now.
        return null
      case 'error':
        if (session.errors.length < 20) session.errors.push(str(raw.text).slice(0, 300))
        return null
      case 'subscribe': {
        const topic = str(raw.topic)
        if (!topicAllowed(app, topic) || (topic !== 'refresh' && !app.subscribe.includes(topic))) {
          session.refused.push(`subscribe ${topic}`)
          this.emit(session, 'error', { topic, why: `Not allowed to listen to ${topic} (it must be in subscribe, with its read permission).` })
          return null
        }
        if (topic === 'refresh' || session.topics.has(topic)) return null
        const off = this.listen(session, topic)
        if (off !== null) session.topics.set(topic, session.scope.effect(() => off, `listen ${topic}`))
        return null
      }
      case 'unsubscribe': {
        const topic = str(raw.topic)
        session.topics.get(topic)?.()
        session.topics.delete(topic)
        return null
      }
      case 'call':
        return this.call(session, app, id, str(raw.tool), typeof raw.args === 'object' && raw.args !== null && !Array.isArray(raw.args) ? (raw.args as JsonObject) : {})
      case 'store.get': {
        const key = str(raw.key)
        if (session.mode === 'check' && session.scratch.has(key)) return { op: 'reply', id, ok: true, result: session.scratch.get(key) ?? null }
        return { op: 'reply', id, ok: true, result: app.data[key] ?? null }
      }
      case 'store.keys': {
        const keys = new Set(Object.keys(app.data))
        if (session.mode === 'check') for (const [key, value] of session.scratch) value === null ? keys.delete(key) : keys.add(key)
        return { op: 'reply', id, ok: true, result: [...keys] }
      }
      case 'store.set':
      case 'store.remove': {
        const key = str(raw.key)
        const value = op === 'store.remove' ? null : str(raw.value)
        if (session.mode === 'check') {
          session.scratch.set(key, value)
          return { op: 'reply', id, ok: true, result: true }
        }
        const done = await this.deps.apps.dataSet(app.id, key, value)
        if (done.ok) {
          // Read it back into the loaded copy at once, so the next get sees it before the row change arrives.
          const data = { ...plugin.app.data }
          if (value === null) delete data[key]
          else data[key] = value
          plugin.app = { ...plugin.app, data }
        }
        return done.ok ? { op: 'reply', id, ok: true, result: true } : fail(done.why ?? 'Not saved.')
      }
      case 'ask': {
        const text = str(raw.text).trim().slice(0, 2000)
        if (session.mode === 'check') return { op: 'reply', id, ok: true, result: 'Not sent during the check.' }
        if (text === '' || this.deps.ask === undefined) return fail('Nothing to ask.')
        await this.deps.ask(app, text)
        return { op: 'reply', id, ok: true, result: 'Sent to your agent.' }
      }
      default:
        return id === 0 ? null : fail(`Unknown request ${op}.`)
    }
  }

  private listen(session: Session, topic: string): (() => void) | null {
    const entity = DATA_TOPICS[topic]
    if (entity !== undefined) {
      let timer: ReturnType<typeof setTimeout> | null = null
      const off = this.deps.onRowsChange((change) => {
        if (change !== undefined && change.reset !== true && change.entity !== entity) return
        if (timer !== null) return
        // A burst of writes (a sync) is one event.
        timer = setTimeout(() => {
          timer = null
          this.emit(session, topic, { entity })
        }, 250)
      })
      return () => {
        if (timer !== null) clearTimeout(timer)
        off()
      }
    }
    if (topic === 'calendar.changed') return this.deps.onCalendarChange?.(() => this.emit(session, topic, {})) ?? null
    if (topic.startsWith('worker.')) {
      const worker = topic.slice('worker.'.length)
      return this.deps.onWorkerEvent?.((from, event) => {
        if (from === worker) this.emit(session, topic, event)
      }) ?? null
    }
    return null
  }

  private rateOk(appId: string): boolean {
    const now = this.now()
    const recent = (this.calls.get(appId) ?? []).filter((at) => now - at < MINIAPP_RATE.perMs)
    if (recent.length >= MINIAPP_RATE.calls) {
      this.calls.set(appId, recent)
      return false
    }
    recent.push(now)
    this.calls.set(appId, recent)
    return true
  }

  private async call(session: Session, app: MiniAppRow, id: number, tool: string, args: JsonObject): Promise<BridgeReply> {
    const fail = (error: string): BridgeReply => {
      if (session.refused.length < 20) session.refused.push(`${tool}: ${error}`)
      return { op: 'reply', id, ok: false, error }
    }
    session.calls += 1
    const verdict = checkCall(app, tool, args)
    if (!verdict.ok) {
      this.log('Mini-app call refused', { app: app.id, tool, why: verdict.why })
      return fail(verdict.why)
    }
    if (!this.rateOk(app.id)) return fail(`Too many calls: at most ${MINIAPP_RATE.calls} in ${MINIAPP_RATE.perMs / 1000} s.`)
    const reads = verdict.reads || this.deps.reads?.(tool, args) === true
    if (!reads) {
      if (session.mode === 'check') return { op: 'reply', id, ok: false, error: 'Not run during the check (it changes something).' }
      if (!app.allowed.includes(verdict.key)) {
        const yes = await this.deps.approve(app, `The app "${app.name}" wants to run ${verdict.key}`, JSON.stringify(args, null, 2).slice(0, 2000), session.controller.signal)
        if (!yes) return { op: 'reply', id, ok: false, error: 'He said no.' }
      }
    }
    try {
      const result = await this.deps.runTool(app, tool, args, session.controller.signal)
      return { op: 'reply', id, ok: true, result }
    } catch (error) {
      return { op: 'reply', id, ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

let current: MiniAppHost | null = null

/** The running host (tools and the window reach it here, like getWakeups). */
export function getMiniAppHost(): MiniAppHost | null {
  return current
}

export function setMiniAppHost(host: MiniAppHost | null): void {
  current = host
}
