/**
 * Helpers: the worker agents the main agent hands its real work to.
 *
 * Ported from startHelper / runHelper / steerHelper / pushHelper / stopHelper / deliver /
 * helpersReport in reference/phone/AgentRuntime.kt. Each helper is its own AgentLoop on its own
 * thread, with the HELPER system prompt, the worker toolset and its own transcript. When it finishes,
 * its result comes back to the main agent as a new main turn.
 *
 * One deliberate difference from the phone: ids are the chat row's string id (a cid) rather than an
 * integer, because every row in this app is identified by a cid.
 */
import { randomUUID } from 'node:crypto'

import {
  AgentLoop,
  MAIN_CHAT,
  PROVIDERS,
  msgFromJson,
  msgToJson,
  repair,
  userMsg,
  type AgentEvent,
  type ChatEvent,
  type Decision,
  type LlmProvider,
  type Msg,
  type AgentProfileInfo,
  type Tool,
  type ToolContext,
} from '@agent/core'

import type { DataStore } from './data'
import type { CliHost } from './cli-host'
import { buildSystemPrompt } from './prompt'
import { finishRun, runStarted } from './run-detail'
import { redactSecrets } from '../logger'
import {
  describeCall,
  friendlyError,
  type ProviderFactory,
  type SecretsView,
  type SettingsView,
} from './runner'

export type HelperState = 'working' | 'done' | 'failed' | 'stopped'

export interface HelperTask {
  label: string
  brief: string
  /** Accepted so an old brief still parses; in v1 there is one model on the roster. */
  model?: string
  /** The profile it works in, by name or id. None named: General, which has none of the person's accounts. */
  profile?: string
}

/** What the helper manager needs from the profiles: finding one by name or id, and General. */
export interface ProfileLookup {
  find(ref: string): AgentProfileInfo | null
  general(): AgentProfileInfo
  all(): AgentProfileInfo[]
}

/** What the main agent's tools need from the manager. */
/** Where a helper was started from: the chat its result and cards go back to. */
export interface HelperOrigin {
  chat?: string
}

/** A different job the person sent while a chat was busy: it runs on its own and leaves a summary block. */
export interface AlongsideJob {
  chat: string
  /** The person's message as the model should read it (attached file text included). */
  text: string
  images: string[]
  /** What the chat was busy with, so the run knows not to touch it. */
  goal: string
  /** The person's chat row this run answers. */
  userItem: string
}

export interface HelperHost {
  delegate(tasks: HelperTask[], together?: boolean, origin?: HelperOrigin): Promise<string>
  /** Start a separate run for a different job sent while a chat was busy. The helper id, or null when none can start. */
  alongside?(job: AlongsideJob): Promise<string | null>
  steer(id: string, message: string): Promise<string>
  push(id: string, message: string): Promise<string>
  status(): Promise<string>
  stop(id: string): Promise<boolean>
  stopAll(): Promise<number>
  live(): HelperLive[]
  /** A helper's question or approval card, answered by the person. False when it was not ours. */
  answer?(itemId: string, answer: string): Promise<boolean>
  decide?(itemId: string, decision: Decision): Promise<boolean>
  /** A fresh process has no live helpers: mark the ones left working as failed. */
  restore?(): Promise<void>
}

/** One helper as the main prompt and the UI see it. */
export interface HelperLive {
  id: string
  label: string
  brief: string
  state: HelperState
  startedAt: number
  /** The name of the profile it works in. */
  profile?: string
  /** The chat it was started from (absent for the first chat). */
  chat?: string
  /** True for a separate run started from a message sent while the chat was busy. */
  side?: boolean
}

export interface HelperManagerDeps {
  store: DataStore
  settings: SettingsView
  secrets: SecretsView
  providerFactory: ProviderFactory
  /** Everything that acts: the worker toolset, without delegate and helper_*. */
  workerTools: Tool[]
  /** A finished helper's result, handed to the main agent of the chat that started it as a new turn. */
  deliver: (text: string, chat?: string) => Promise<void> | void
  /** A separate run (alongside) finished: its summary block is in the chat; the chat's agent hears it next turn. */
  alongsideDone?: (chat: string, helperId: string) => Promise<void> | void
  /** `process.platform`, so the helper prompt names the computer's system. */
  platform?: string
  timeZone?: string
  now?: () => number
  /** Four at a time; the rest wait their turn. */
  maxConcurrent?: number
  /** A helper may take many steps, but not forever. */
  maxSteps?: number
  emit?: (event: ChatEvent) => void
  notify?: (title: string, body: string) => void
  /** On the person's own plan, every helper is its own Claude Agent SDK / Codex SDK session. */
  cli?: CliHost | null
  /** Every helper works inside one profile. Without this, every helper is in General. */
  profiles?: ProfileLookup
  /** Learned app id -> name, for the helper's YOUR PROFILE line. */
  learnedNames?: () => Record<string, string>
}

interface Ready {
  provider: LlmProvider
  model: string
}

interface HelperRun {
  id: string
  label: string
  /** The profile it works in: it may use only that profile's accounts and browser sign-ins. */
  profileId: string
  brief: string
  model: string
  pushes: number
  startedAt: number
  controller: AbortController | null
  /** The conversation to carry on with, for a pushed helper. Null for a fresh brief. */
  initialHistory: Msg[] | null
  /** On a plan: the message a pushed helper carries on with (its SDK session holds the history). */
  pushMessage?: string
  /** The chat it belongs to. */
  chat: string
  /** A separate run for a message sent while the chat was busy: its result is a summary block, not a new turn. */
  side?: boolean
  /** Pictures for its first message. */
  images?: string[]
}

interface Batch {
  results: Map<string, string>
}

/** Words a helper uses when it gives up. Usually it can do it; it needs sending back. */
export const GAVE_UP =
  /(^\s*(unable|couldn't|could not|can't|cannot|failed)\b)|\b(I|we)\s+(can't|cannot|can not|couldn't|could not|was unable|were unable|am unable|wasn't able|weren't able|am not able|don't have access|do not have access|have no access|wasn't allowed|got blocked|was blocked)\b/i

const MAX_CONCURRENT = 4
const MAX_HELPER_STEPS = 120
const MAX_TASKS = 5
const MAX_RESULT_CHARS = 12_000
const MAX_META_RESULT_CHARS = 6_000

export class HelperManager implements HelperHost {
  private readonly store: DataStore
  private readonly settings: SettingsView
  private readonly secrets: SecretsView
  private readonly providerFactory: ProviderFactory
  private readonly cli: CliHost | null
  private readonly profiles: ProfileLookup | null
  private readonly learnedNames: () => Record<string, string>
  private readonly workerTools: Tool[]
  private readonly deliver: (text: string, chat?: string) => Promise<void> | void
  private readonly alongsideDone: (chat: string, helperId: string) => Promise<void> | void
  private readonly platform: string
  private readonly timeZone: string | undefined
  private readonly now: () => number
  private readonly maxConcurrent: number
  private readonly maxSteps: number
  private readonly emit: (event: ChatEvent) => void
  private readonly notifyUser: (title: string, body: string) => void

  private readonly runs = new Map<string, HelperRun>()
  private readonly queue: string[] = []
  private readonly active = new Set<string>()
  private readonly inbox = new Map<string, string[]>()
  private readonly batches = new Map<string, Batch>()
  private readonly batchOf = new Map<string, string>()
  private readonly askWaiters = new Map<string, (answer: string | null) => void>()
  private readonly decisionWaiters = new Map<string, (approved: boolean) => void>()
  private readonly activityIds = new Map<number, string>()
  /** When each tool call started, for how long a run took. */
  private readonly runStarts = new Map<string, number>()
  private activitySeq = 0

  constructor(deps: HelperManagerDeps) {
    this.store = deps.store
    this.settings = deps.settings
    this.secrets = deps.secrets
    this.providerFactory = deps.providerFactory
    this.cli = deps.cli ?? null
    this.profiles = deps.profiles ?? null
    this.learnedNames = deps.learnedNames ?? (() => ({}))
    this.workerTools = deps.workerTools
    this.deliver = deps.deliver
    this.alongsideDone = deps.alongsideDone ?? (() => undefined)
    this.platform = deps.platform ?? process.platform
    this.timeZone = deps.timeZone
    this.now = deps.now ?? Date.now
    this.maxConcurrent = deps.maxConcurrent ?? MAX_CONCURRENT
    this.maxSteps = deps.maxSteps ?? MAX_HELPER_STEPS
    this.emit = deps.emit ?? (() => undefined)
    this.notifyUser = deps.notify ?? (() => undefined)
  }

  // ---- the main agent's side ---------------------------------------------------------------

  async delegate(tasks: HelperTask[], together = false, origin: HelperOrigin = {}): Promise<string> {
    const chat = origin.chat ?? MAIN_CHAT
    // On the person's plan every helper is its own SDK session: no API key or provider is needed.
    const ready = this.onPlan() ? { model: this.settings.get().cliModel.trim() } : this.ready()
    if (typeof ready === 'string') return ready

    const clean = tasks.filter((task) => task.brief.trim() !== '').slice(0, MAX_TASKS)
    if (clean.length === 0) return 'No tasks given.'

    // Every helper works inside exactly one profile; with none named it gets General. An unknown name
    // stops the whole call before anything starts, so the main agent can fix it and send them again.
    // Started from a project chat: helpers work in the project's profile unless the brief names another.
    const projectProfile = chat === MAIN_CHAT ? '' : await this.projectProfileOf(chat)
    const chosen: AgentProfileInfo[] = []
    for (const task of clean) {
      const wanted = (task.profile ?? '').trim() || projectProfile
      const found = wanted === '' ? this.generalProfile() : (this.profiles?.find(wanted) ?? null)
      if (found === null) {
        const names = (this.profiles?.all() ?? []).map((p) => p.name).join(', ')
        return `No profile called "${wanted}". The user's profiles: ${names === '' ? 'none yet' : names}. Pick one, or make one with profile_create, then delegate again. Nothing was started.`
      }
      chosen.push(found)
    }

    const batch = together && clean.length > 1 ? `b${randomUUID().replace(/-/g, '').slice(0, 8)}` : null
    if (batch !== null) this.batches.set(batch, { results: new Map() })

    const started: Array<{ id: string; label: string }> = []
    for (const [index, task] of clean.entries()) {
      const label = (task.label.trim() || labelFromBrief(task.brief)).slice(0, 40)
      const profile = chosen[index] ?? this.generalProfile()
      const id = await this.createHelperRow(label, task.brief, ready.model, batch, profile, chat)
      this.runs.set(id, {
        chat,
        id,
        label,
        profileId: profile.id,
        brief: task.brief,
        model: this.modelFor(ready.model, task.model),
        pushes: 0,
        startedAt: this.now(),
        controller: null,
        initialHistory: null,
      })
      if (batch !== null) this.batchOf.set(id, batch)
      this.queue.push(id)
      started.push({ id, label })
    }

    this.pump()

    const list = started
      .map((entry, index) => `#${entry.id} ${entry.label}${chosen[index] === undefined ? '' : ` (in ${chosen[index]?.name})`}`)
      .join(', ')
    return (
      `Started: ${list}. They run in the background and ` +
      (batch === null
        ? 'each result will arrive as a message. '
        : 'their results will arrive TOGETHER as one message once all are done. ') +
      'Tell the user in one short line what you set going, then end your turn. Do not wait or poll.'
    )
  }

  async steer(id: string, message: string): Promise<string> {
    const run = this.runs.get(id)
    if (run === undefined) return this.push(id, message)
    if (this.onPlan()) {
      // An SDK session cannot read a note mid-turn: stop it where it is and send it back with the note.
      await this.stop(id)
      for (let i = 0; i < 50 && this.runs.has(id); i += 1) await new Promise((resolve) => setTimeout(resolve, 100))
      return this.push(id, message)
    }
    const notes = this.inbox.get(id) ?? []
    notes.push(message)
    this.inbox.set(id, notes)
    await this.addActivity(id, run.label, `Told it: ${clip(message, 140)}`)
    return `Helper #${id} gets your message before its next step and keeps going.`
  }

  async push(id: string, message: string): Promise<string> {
    if (this.runs.has(id)) return `Helper #${id} is still working. Wait for its result.`
    const row = await this.store.get('chat_item', id)
    if (row === null || row.kind !== 'helper') return `No helper #${id}.`

    const ready = this.ready()
    if (typeof ready === 'string') return ready

    const meta = parseMeta(row.meta)
    const label = stringField(meta['label']) || 'Helper'
    const chat = stringField(meta['chat']) || MAIN_CHAT
    const side = meta['side'] === true
    const pushes = numberField(meta['pushes']) + 1
    if (this.onPlan()) {
      await this.updateMeta(id, { state: 'working', summary: 'Back on it', pushes, startedAt: this.now() })
      this.runs.set(id, {
        chat,
        side,
        id,
        label,
        profileId: this.profileIdFrom(meta),
        brief: row.text,
        model: '',
        pushes,
        startedAt: this.now(),
        controller: null,
        initialHistory: null,
        pushMessage: message,
      })
      await this.addActivity(id, label, `Sent back: ${clip(message, 140)}`)
      this.queue.push(id)
      this.pump()
      return `Helper #${id} is back on it. Its new result will arrive as a message.`
    }
    const history = await this.loadHistory(id)
    if (history.length === 0) history.push(userMsg(row.text))
    history.push(userMsg(message))
    await this.appendTurn(id, userMsg(message))

    await this.updateMeta(id, {
      state: 'working',
      summary: 'Back on it',
      pushes,
      startedAt: this.now(),
    })
    this.runs.set(id, {
      chat,
      side,
      id,
      label,
      profileId: this.profileIdFrom(meta),
      brief: row.text,
      model: this.modelFor(ready.model, stringField(meta['model'])),
      pushes,
      startedAt: this.now(),
      controller: null,
      initialHistory: history,
    })
    await this.addActivity(id, label, `Sent back: ${clip(message, 140)}`)
    this.queue.push(id)
    this.pump()
    return `Helper #${id} is back on it. Its new result will arrive as a message.`
  }

  async status(): Promise<string> {
    const all = await this.store.list('chat_item')
    const helpers = all.filter((row) => row.kind === 'helper').slice(-10)
    if (helpers.length === 0) return 'No helpers have run yet.'

    const activities = all.filter((row) => row.kind === 'activity')
    const nowMs = this.now()
    return helpers
      .sort((a, b) => {
        const left = parseMeta(a.meta)['state'] === 'working' ? 0 : 1
        const right = parseMeta(b.meta)['state'] === 'working' ? 0 : 1
        return left - right
      })
      .map((row) => {
        const meta = parseMeta(row.meta)
        const state = stringField(meta['state']) || 'failed'
        const startedAt = numberField(meta['startedAt']) || row.createdAt
        const endedAt = numberField(meta['endedAt'])
        const minutes = Math.max(0, Math.floor(((endedAt > 0 ? endedAt : nowMs) - startedAt) / 60_000))
        const steps = activities
          .filter((activity) => stringField(parseMeta(activity.meta)['helper']) === row.id)
          .slice(-5)
          .map((activity) => activity.text)
          .join('; ')
        const head = `#${row.id} ${stringField(meta['label'])} [${state}${meta['queued'] === true ? ', queued' : ''}, ${minutes}m]\nBrief: ${clip(row.text, 240)}`
        if (state !== 'working') {
          return `${head}\nResult: ${clip(stringField(meta['result']), 500)}`
        }
        return `${head}\nNow: ${stringField(meta['summary']) || 'thinking'}${steps === '' ? '' : `\nRecent steps: ${steps}`}`
      })
      .join('\n\n')
  }

  async stop(id: string): Promise<boolean> {
    const run = this.runs.get(id)
    if (run === undefined) return false
    const at = this.queue.indexOf(id)
    if (at >= 0) {
      this.queue.splice(at, 1)
      this.runs.delete(id)
      this.dropFromBatch(id)
      await this.updateMeta(id, {
        state: 'stopped',
        summary: 'Stopped before it started.',
        endedAt: this.now(),
        queued: false,
      })
      this.emit({ type: 'chat_changed' })
      return true
    }
    run.controller?.abort()
    return true
  }

  async stopAll(): Promise<number> {
    const ids = [...this.runs.keys()]
    this.queue.length = 0
    for (const id of ids) {
      const run = this.runs.get(id)
      if (run === undefined) continue
      if (run.controller === null) {
        this.runs.delete(id)
        this.dropFromBatch(id)
        await this.updateMeta(id, {
          state: 'stopped',
          summary: 'Stopped before it started.',
          endedAt: this.now(),
          queued: false,
        })
      } else {
        run.controller.abort()
      }
    }
    if (ids.length > 0) this.emit({ type: 'chat_changed' })
    return ids.length
  }

  live(): HelperLive[] {
    return [...this.runs.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .map((run) => ({
        id: run.id,
        label: run.label,
        brief: run.brief,
        state: 'working',
        startedAt: run.startedAt,
        profile: this.profiles?.find(run.profileId)?.name ?? this.generalProfile().name,
        ...(run.chat === MAIN_CHAT ? {} : { chat: run.chat }),
        ...(run.side === true ? { side: true } : {}),
      }))
  }

  /**
   * A different job the person sent while the chat was busy, as its own run. It uses the helper machinery (its
   * own loop, transcript, cards and Stop), but its result is not handed to the chat's agent as a new turn: the
   * helper row itself is the summary block in the chat, and the chat's agent hears about it on its next turn.
   */
  async alongside(job: AlongsideJob): Promise<string | null> {
    const ready = this.onPlan() ? { model: this.settings.get().cliModel.trim() } : this.ready()
    if (typeof ready === 'string') return null
    const brief = job.text
    const label = labelFromBrief(job.text.split('\n').filter((line) => !line.startsWith('[')).join(' ') || job.text).slice(0, 40)
    const profile = this.generalProfile()
    const id = await this.createHelperRow(label, brief, ready.model, null, profile, job.chat, {
      side: true,
      ask: job.userItem,
      goal: clip(job.goal, 200),
    })
    this.runs.set(id, {
      chat: job.chat,
      side: true,
      images: job.images,
      id,
      label,
      profileId: profile.id,
      brief,
      model: this.modelFor(ready.model, undefined),
      pushes: 0,
      startedAt: this.now(),
      controller: null,
      initialHistory: null,
    })
    this.queue.push(id)
    this.pump()
    return id
  }

  // ---- cards -------------------------------------------------------------------------------

  async answer(itemId: string, answer: string): Promise<boolean> {
    const waiter = this.askWaiters.get(itemId)
    if (waiter === undefined) return false
    const row = await this.store.get('chat_item', itemId)
    if (row === null) return false
    const meta = parseMeta(row.meta)
    await this.store.upsert('chat_item', {
      id: row.id,
      kind: row.kind,
      text: row.text,
      meta: JSON.stringify({ ...meta, answer }),
    })
    this.askWaiters.delete(itemId)
    this.emit({ type: 'chat_changed' })
    waiter(answer)
    return true
  }

  async decide(itemId: string, decision: Decision): Promise<boolean> {
    const waiter = this.decisionWaiters.get(itemId)
    if (waiter === undefined) return false
    const row = await this.store.get('chat_item', itemId)
    if (row === null) return false
    const meta = parseMeta(row.meta)
    await this.store.upsert('chat_item', {
      id: row.id,
      kind: row.kind,
      text: row.text,
      meta: JSON.stringify({ ...meta, decision }),
    })
    this.decisionWaiters.delete(itemId)
    this.emit({ type: 'chat_changed' })
    waiter(decision === 'approve')
    return true
  }

  // ---- startup -----------------------------------------------------------------------------

  async restore(): Promise<void> {
    const rows = await this.store.list('chat_item')
    for (const row of rows) {
      if (row.kind !== 'helper') continue
      const meta = parseMeta(row.meta)
      if (meta['state'] !== 'working') continue
      await this.updateMeta(row.id, {
        state: 'failed',
        summary: 'Interrupted when the app closed.',
        result: 'Interrupted when the app closed.',
        endedAt: this.now(),
        queued: false,
      })
    }
    this.runs.clear()
    this.queue.length = 0
    this.active.clear()
    this.inbox.clear()
    this.batches.clear()
    this.batchOf.clear()
  }

  // ---- running a helper --------------------------------------------------------------------

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()
      if (id === undefined) return
      const run = this.runs.get(id)
      if (run === undefined) continue
      this.active.add(id)
      void this.runHelper(run)
    }
  }

  private async runHelper(run: HelperRun): Promise<void> {
    if (this.onPlan()) {
      await this.runOnPlan(run)
      return
    }
    const ready = this.ready()
    if (typeof ready === 'string') {
      await this.finish(run, 'failed', ready)
      return
    }

    const controller = new AbortController()
    run.controller = controller
    const starting = run.initialHistory
    const history: Msg[] = starting ?? [userMsg(run.brief, run.images ?? [])]
    if (starting === null) await this.appendTurn(run.id, history[0] as Msg)
    await this.updateMeta(run.id, { state: 'working', summary: 'Thinking', queued: false })

    let state: HelperState = 'failed'
    let result = ''
    try {
      const system = await this.buildHelperPrompt(run)
      const loop = new AgentLoop({
        provider: ready.provider,
        model: run.model === '' ? ready.model : run.model,
        tools: this.workerTools,
        maxSteps: this.maxSteps,
      })
      const out = await loop.run(system, history, this.context(run, controller.signal), {
        onEvent: (event) => this.onEvent(run, event),
        onAppend: (message) => this.appendTurn(run.id, message),
        incoming: () => {
          const notes = this.inbox.get(run.id)
          return notes === undefined ? [] : notes.splice(0)
        },
        signal: controller.signal,
      })
      if (controller.signal.aborted) {
        state = 'stopped'
        result = 'Stopped before it finished.'
      } else {
        state = 'done'
        result = out
      }
    } catch (error) {
      if (controller.signal.aborted) {
        state = 'stopped'
        result = 'Stopped before it finished.'
      } else {
        state = 'failed'
        result = friendlyError(error)
      }
    }

    await this.finish(run, state, result)
  }

  private async finish(run: HelperRun, state: HelperState, result: string): Promise<void> {
    this.runs.delete(run.id)
    this.active.delete(run.id)
    this.inbox.delete(run.id)

    await this.updateMeta(run.id, {
      state,
      summary: summarise(result, state),
      result: clip(result, MAX_META_RESULT_CHARS),
      endedAt: this.now(),
      queued: false,
    })
    this.emit({ type: 'chat_changed' })
    this.pump()

    // The user stopped it: there is nothing to report back.
    if (state === 'stopped') {
      this.dropFromBatch(run.id)
      return
    }

    if (run.side === true) {
      try {
        await this.alongsideDone(run.chat, run.id)
      } catch {
        // The summary block is already in the chat; the agent hearing about it is a nicety.
      }
      return
    }

    const note = this.resultNote(run, state, result)
    const batch = this.batchOf.get(run.id)
    if (batch === undefined) {
      await this.handOver(note, run.chat)
      return
    }

    this.batchOf.delete(run.id)
    const group = this.batches.get(batch)
    if (group === undefined) {
      await this.handOver(note, run.chat)
      return
    }
    group.results.set(run.id, note)
    if ([...this.batchOf.values()].includes(batch)) return

    this.batches.delete(batch)
    const all = [...group.results.values()]
    await this.handOver(
      `[Helpers finished: all ${all.length} you started together are done. Give the user ONE packed answer.]\n\n${all.join('\n\n')}`,
      run.chat,
    )
  }

  /** A delivery failing must not take the manager down with it. */
  private async handOver(note: string, chat: string = MAIN_CHAT): Promise<void> {
    try {
      await this.deliver(note, chat)
    } catch {
      // The result is already saved on the helper's card; the person can read it there.
    }
  }

  private dropFromBatch(id: string): void {
    const batch = this.batchOf.get(id)
    if (batch === undefined) return
    this.batchOf.delete(id)
    const group = this.batches.get(batch)
    if (group !== undefined) group.results.delete(id)
    if (![...this.batchOf.values()].includes(batch)) this.batches.delete(batch)
  }

  /** Ported from the note runHelper hands back to the main agent. */
  private resultNote(run: HelperRun, state: HelperState, result: string): string {
    const first = result.trim().split(/(?<=[.!?])\s+|\n/)[0]?.slice(0, 300) ?? ''
    const gaveUp = GAVE_UP.test(first)
    const pushed = run.pushes > 0 ? ` (after ${run.pushes} push${run.pushes > 1 ? 'es' : ''})` : ''
    const nudge =
      (state === 'failed' || gaveUp) && run.pushes < 2
        ? `\n\n(It says it couldn't do all of it${run.pushes > 0 ? `, after ${run.pushes} push${run.pushes > 1 ? 'es' : ''}` : ''}. Helpers usually can. Unless it's truly impossible, send it back with helper_push: name a concrete next thing to try and tell it you believe it can do it. Push at least twice before you accept it or tell the user.)`
        : ''
    const outcome = state === 'done' ? 'finished' : 'failed'
    const body = clip(result.trim(), MAX_RESULT_CHARS) || '(no result text)'
    return `[Helper #${run.id} "${run.label}" ${outcome}${pushed}]\n${body}${nudge}`
  }

  private async onEvent(run: HelperRun, event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'thinking':
        await this.updateMeta(run.id, { summary: 'Thinking' })
        return
      case 'said': {
        const line = event.text.trim().split('\n')[0] ?? ''
        if (line !== '') await this.updateMeta(run.id, { summary: clip(line, 160) })
        return
      }
      case 'tool_started': {
        const summary = describeCall(event.call)
        const started = runStarted(event.call)
        this.runStarts.set(event.call.id, Date.now())
        const row = await this.store.upsert('chat_item', {
          kind: 'activity',
          text: summary,
          meta: JSON.stringify({
            tool: event.call.name,
            status: 'running',
            summary,
            ...(started === null ? {} : { run: started }),
            helper: run.id,
            by: run.label,
            ...chatTag(run.chat),
          }),
        })
        await this.updateMeta(run.id, { summary })
        this.emit({ type: 'chat_changed' })
        return
      }
      case 'tool_finished': {
        const isError = event.isError
        const summary = isError
          ? clip(redactSecrets(event.result.split('\n')[0] ?? event.result), 160)
          : describeCall(event.call)
        const existing = await this.findRunningActivity(run.id, event.call.name)
        const started = this.runStarts.get(event.call.id) ?? Date.now()
        this.runStarts.delete(event.call.id)
        const record = await finishRun(event.call, event.result, isError, started)
        if (existing !== null) {
          await this.store.upsert('chat_item', {
            id: existing,
            kind: 'activity',
            text: isError ? `${summary} failed` : summary,
            meta: JSON.stringify({
              tool: event.call.name,
              status: isError ? 'error' : 'done',
              summary,
              helper: run.id,
              by: run.label,
              ...chatTag(run.chat),
              ...(record === null ? {} : { run: record }),
            }),
          })
        }
        await this.updateMeta(run.id, { summary })
        this.emit({ type: 'chat_changed' })
        return
      }
    }
  }

  private async findRunningActivity(helperId: string, tool: string): Promise<string | null> {
    const rows = await this.store.list('chat_item')
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (row === undefined || row.kind !== 'activity') continue
      const meta = parseMeta(row.meta)
      if (stringField(meta['helper']) !== helperId) continue
      if (stringField(meta['tool']) !== tool) continue
      if (meta['status'] !== 'running') continue
      return row.id
    }
    return null
  }

  private context(run: HelperRun, signal: AbortSignal): ToolContext {
    return {
      agentLabel: run.label,
      owner: `helper:${run.id}`,
      chat: run.chat,
      profile: run.profileId,
      activity: async (text, meta) => {
        const id = ++this.activitySeq
        const row = await this.store.upsert('chat_item', {
          kind: 'activity',
          text,
          meta: JSON.stringify({
            ...(meta ?? {}),
            status: 'running',
            helper: run.id,
            by: run.label,
            ...chatTag(run.chat),
          }),
        })
        this.activityIds.set(id, row.id)
        this.emit({ type: 'chat_changed' })
        return id
      },
      updateActivity: async (id, text, meta) => {
        const rowId = this.activityIds.get(id)
        if (rowId === undefined) return
        await this.store.upsert('chat_item', {
          id: rowId,
          kind: 'activity',
          text,
          meta: JSON.stringify({
            ...(meta ?? {}),
            status: 'done',
            helper: run.id,
            by: run.label,
            ...chatTag(run.chat),
          }),
        })
        this.emit({ type: 'chat_changed' })
      },
      ask: (question, options) => this.ask(run, question, options, signal),
      approve: (summary, details, scope) => this.approve(run, summary, details, signal, scope),
      notify: async (title, body) => {
        if (!this.settings.get().notifications) return
        try {
          this.notifyUser(title, body)
        } catch {
          // A notification failing must never take a helper down with it.
        }
      },
      signal,
    }
  }

  private async ask(
    run: HelperRun,
    question: string,
    options: string[],
    signal: AbortSignal,
  ): Promise<string | null> {
    const row = await this.store.upsert('chat_item', {
      kind: 'question',
      text: question,
      meta: JSON.stringify({
        options,
        answer: '',
        helper: run.id,
        by: run.label,
        ...chatTag(run.chat),
      }),
    })
    return new Promise<string | null>((resolve) => {
      let settled = false
      const finish = (answer: string | null): void => {
        if (settled) return
        settled = true
        this.askWaiters.delete(row.id)
        signal.removeEventListener('abort', onAbort)
        resolve(answer)
      }
      const onAbort = (): void => finish(null)
      if (signal.aborted) {
        finish(null)
        return
      }
      this.askWaiters.set(row.id, finish)
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'chat_changed', ...chatTag(run.chat) })
      this.emit({ type: 'needs_you', itemId: row.id, ...chatTag(run.chat) })
    })
  }

  private async approve(
    run: HelperRun,
    summary: string,
    details: string | undefined,
    signal: AbortSignal,
    scope?: 'computer',
  ): Promise<boolean> {
    const row = await this.store.upsert('chat_item', {
      kind: 'approval',
      text: summary,
      meta: JSON.stringify({
        summary,
        details: details ?? '',
        decision: '',
        ...(scope === undefined ? {} : { scope }),
        helper: run.id,
        by: run.label,
        ...chatTag(run.chat),
      }),
    })
    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (approved: boolean): void => {
        if (settled) return
        settled = true
        this.decisionWaiters.delete(row.id)
        signal.removeEventListener('abort', onAbort)
        resolve(approved)
      }
      const onAbort = (): void => finish(false)
      if (signal.aborted) {
        finish(false)
        return
      }
      this.decisionWaiters.set(row.id, finish)
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'chat_changed', ...chatTag(run.chat) })
      this.emit({ type: 'needs_you', itemId: row.id, ...chatTag(run.chat) })
    })
  }

  private async addActivity(helperId: string, label: string, text: string): Promise<void> {
    const chat = this.runs.get(helperId)?.chat ?? MAIN_CHAT
    await this.store.upsert('chat_item', {
      kind: 'activity',
      text,
      meta: JSON.stringify({ tool: 'agent', by: label, helper: helperId, status: 'done', summary: text, ...chatTag(chat) }),
    })
    this.emit({ type: 'chat_changed' })
  }

  // ---- rows and prompts --------------------------------------------------------------------

  private async createHelperRow(
    label: string,
    brief: string,
    model: string,
    batch: string | null,
    profile: AgentProfileInfo,
    chat: string = MAIN_CHAT,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await this.store.upsert('chat_item', {
      kind: 'helper',
      text: brief,
      meta: JSON.stringify({
        id: '',
        label,
        state: 'working',
        summary: 'Waiting its turn',
        queued: true,
        startedAt: this.now(),
        model,
        profile: profile.name,
        profileId: profile.id,
        profileColor: profile.color,
        ...(batch === null ? {} : { batch }),
        ...chatTag(chat),
        ...extra,
      }),
    })
    await this.updateMeta(row.id, { id: row.id })
    this.emit({ type: 'chat_changed' })
    return row.id
  }

  private async updateMeta(id: string, patch: Record<string, unknown>): Promise<void> {
    const row = await this.store.get('chat_item', id)
    if (row === null) return
    await this.store.upsert('chat_item', {
      id: row.id,
      kind: row.kind,
      text: row.text,
      meta: JSON.stringify({ ...parseMeta(row.meta), ...patch }),
    })
  }

  private async appendTurn(thread: string, message: Msg): Promise<void> {
    await this.store.upsert('turn', { thread, json: JSON.stringify(msgToJson(message)) })
  }

  private async loadHistory(thread: string): Promise<Msg[]> {
    const rows = await this.store.list('turn')
    const messages: Msg[] = []
    for (const row of rows) {
      if (row.thread !== thread) continue
      try {
        messages.push(msgFromJson(JSON.parse(row.json) as unknown))
      } catch {
        // A half-written row must not block a helper coming back to work.
      }
    }
    const fixed = repair(messages)
    while (fixed.length > 0) {
      const first = fixed[0]
      if (first !== undefined && first.role === 'USER' && first.blocks.some((block) => block.t === 'text')) break
      fixed.shift()
    }
    return fixed
  }

  private async buildHelperPrompt(run: HelperRun): Promise<string> {
    const [memories, goals, tasks, projects] = await Promise.all([
      this.store.list('memory'),
      this.store.list('goal'),
      this.store.list('task'),
      run.chat === MAIN_CHAT ? Promise.resolve([]) : this.store.list('project').catch(() => []),
    ])
    // Started from a project chat: it works for that project, reads its memory first and keeps it.
    const project = projects.find((each) => each.chats.includes(run.chat))
    return buildSystemPrompt({
      settings: this.settings.get(),
      now: new Date(this.now()),
      platform: this.platform,
      memories,
      goals,
      tasks,
      latestUserText: run.brief,
      role: 'helper',
      helper: { label: run.label, brief: run.brief },
      profile: this.profiles?.find(run.profileId) ?? this.generalProfile(),
      ...(project === undefined
        ? {}
        : { project: { id: project.id, name: project.name, description: project.description, path: project.path, profile: this.profiles?.find(project.profile)?.name ?? 'General' } }),
      learnedNames: this.learnedNames(),
      ...(this.timeZone === undefined ? {} : { timeZone: this.timeZone }),
    })
  }

  private generalProfile(): AgentProfileInfo {
    return (
      this.profiles?.general() ?? {
        id: 'general',
        name: 'General',
        color: 'graphite',
        accounts: [],
        learned: [],
        browser: '',
        general: true,
      }
    )
  }

  /** A helper sent back keeps the profile it started in (General when that profile is gone). */
  private profileIdFrom(meta: Record<string, unknown>): string {
    const id = stringField(meta['profileId'])
    return (id !== '' ? this.profiles?.find(id)?.id : undefined) ?? this.generalProfile().id
  }

  private onPlan(): boolean {
    return this.cli !== null && this.settings.get().mode === 'subscription'
  }

  /** One helper turn as its own SDK session on the person's plan; a pushed helper resumes its session. */
  private async runOnPlan(run: HelperRun): Promise<void> {
    const cli = this.cli
    if (cli === null) return
    const current = this.settings.get()
    const controller = new AbortController()
    run.controller = controller
    if (run.pushMessage === undefined) cli.forget(`helper:${run.id}`)
    await this.updateMeta(run.id, { state: 'working', summary: 'Thinking', queued: false })

    let state: HelperState = 'failed'
    let result = ''
    try {
      const outcome = await cli.turn({
        cli: current.cli === '' ? 'claude' : current.cli,
        thread: `helper:${run.id}`,
        tools: this.workerTools,
        system: await this.buildHelperPrompt(run),
        prompt: run.pushMessage ?? run.brief,
        ...(run.pushMessage === undefined && (run.images ?? []).length > 0 ? { images: run.images } : {}),
        ...(current.cliModel.trim() === '' ? {} : { model: current.cliModel.trim() }),
        context: this.context(run, controller.signal),
        signal: controller.signal,
        onEvent: (event) => this.onEvent(run, event),
        onCall: (call) => this.onEvent(run, { type: 'tool_started', call: { t: 'call', id: call.id, name: call.name, input: call.input } }),
        onResult: (call, text, isError) =>
          this.onEvent(run, {
            type: 'tool_finished',
            call: { t: 'call', id: call.id, name: call.name, input: call.input },
            result: text,
            isError,
          }),
      })
      if (controller.signal.aborted) {
        state = 'stopped'
        result = 'Stopped before it finished.'
      } else if (outcome.error !== undefined) {
        state = 'failed'
        result = outcome.error
      } else {
        state = 'done'
        result = outcome.text
      }
    } catch (error) {
      state = controller.signal.aborted ? 'stopped' : 'failed'
      result = controller.signal.aborted ? 'Stopped before it finished.' : friendlyError(error)
    }
    await this.finish(run, state, result)
  }

  /** The provider and model for a helper, or a plain-words reason there is none. */
  private ready(): Ready | string {
    const current = this.settings.get()
    if (current.mode === 'subscription') {
      return 'Subscriptions are coming soon. Add an AI key in Settings to start.'
    }
    const key = (this.secrets.get('apiKey') ?? '').trim()
    if (!current.hasKey || key === '') {
      return 'No AI is set up for helpers yet. Add a key in Settings.'
    }
    const model =
      current.model.trim() ||
      PROVIDERS.find((provider) => provider.id === current.provider)?.defaultModel ||
      ''
    if (model === '') return 'Choose a model in Settings first.'
    if (current.provider === 'custom' && current.baseUrl.trim() === '') {
      return 'Add the server address for this provider in Settings.'
    }

    let provider: LlmProvider | null = null
    try {
      provider = this.providerFactory(current, key)
    } catch {
      provider = null
    }
    if (provider === null) return 'No AI is set up for helpers yet. Add a key in Settings.'
    return { provider, model }
  }

  /** The profile id of the project a chat belongs to, '' when it is in none or the project uses General. */
  private async projectProfileOf(chat: string): Promise<string> {
    try {
      const project = (await this.store.list('project')).find((each) => each.chats.includes(chat))
      return project === undefined || this.profiles?.find(project.profile) == null ? '' : project.profile
    } catch {
      return ''
    }
  }

  /** One model on the roster in v1: the user's chosen one. A requested name falls back to it. */
  private modelFor(defaultModel: string, wanted: string | undefined): string {
    const requested = (wanted ?? '').trim()
    if (requested === '') return defaultModel
    if (requested.toLowerCase() === defaultModel.toLowerCase()) return defaultModel
    if (requested.toLowerCase() === defaultModel.split('/').at(-1)?.toLowerCase()) return defaultModel
    return defaultModel
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small shapes
// ---------------------------------------------------------------------------------------------------------------

/** The chat field a row carries: nothing for the first chat, so its rows look as they always did. */
function chatTag(chat: string): { chat?: string } {
  return chat === MAIN_CHAT ? {} : { chat }
}

function labelFromBrief(brief: string): string {
  const first = brief.trim().split(/\s+/).slice(0, 4).join(' ')
  return first === '' ? 'Helper' : first
}

function summarise(result: string, state: HelperState): string {
  if (state === 'stopped') return 'Stopped'
  const line = result.trim().split('\n').find((part) => part.trim() !== '') ?? ''
  if (line === '') return state === 'failed' ? 'Failed' : 'Done'
  return clip(line.trim(), 160)
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`
}
