/**
 * The Supervisor (docs/workers-and-triggers.md, section 4): starts every enabled worker when the app opens, reads its
 * lines, stores its events, restarts it with backoff when it dies or stops answering, gives up visibly after too many
 * failures (the Needs-you card), and stops it cleanly when the app quits. It knows nothing about any source.
 */
import { WORKER_SECRET_NAME, parseWorkerLine, type WorkerEvent, type WorkerInfo, type WorkerLogLine, type WorkerManifest, type WorkerState } from '@agent/core'

import type { WorkerStore } from './store'

/** The parts of a child process the supervisor uses. Tests hand in a fake. */
export interface ChildLike {
  pid?: number | undefined
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  stdin: NodeJS.WritableStream | null
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: string): boolean
}

export type WorkerSpawn = (start: { manifest: WorkerManifest; dir: string; env: NodeJS.ProcessEnv }) => ChildLike

export interface WorkerSecrets {
  get(name: string): string | null
  set(name: string, value: string): void
  delete?(name: string): void
}

export interface SupervisorDeps {
  store: WorkerStore
  spawn: WorkerSpawn
  secrets: WorkerSecrets
  /** A new (not duplicate) event was stored. */
  onEvent?: (event: WorkerEvent) => void
  /** A worker failed too often; the app stops retrying and the person must see it. */
  onFailing?: (worker: WorkerInfo) => void
  /** Anything the Workers page shows changed. */
  onChange?: () => void
  killTree?: (pid: number | undefined) => void
  killLeftover?: (pid: number) => boolean
  baseEnv?: NodeJS.ProcessEnv
  now?: () => number
  heartbeatMs?: number
  graceMs?: number
  failLimit?: number
  failWindowMs?: number
  backoffMaxMs?: number
  /** How often hung workers are looked for. */
  checkEveryMs?: number
}

export const HEARTBEAT_MS = 90_000
export const GRACE_MS = 5_000
export const FAIL_LIMIT = 5
export const FAIL_WINDOW_MS = 10 * 60_000
export const BACKOFF_MAX_MS = 5 * 60_000
/** Events in the first two minutes after a start count as catching up on the gap. */
const CATCH_UP_MS = 120_000
const LINE_SAVE_MS = 30_000

interface Live {
  child: ChildLike | null
  state: WorkerState
  upSince: number | null
  lastLineAt: number | null
  lineSavedAt: number
  failures: number[]
  timer: NodeJS.Timeout | null
  nextRunAt: number | null
  stopping: boolean
  hung: boolean
  lastStderr: string
  gap: { from: number; to: number } | null
}

export interface TestRun {
  events: Array<{ source: string; event: string; dedupeKey: string; payload: unknown }>
  logs: WorkerLogLine[]
  cursor: string | null
  exitCode: number | null
  ranMs: number
}

export class Supervisor {
  private readonly store: WorkerStore
  private readonly spawn: WorkerSpawn
  private readonly secrets: WorkerSecrets
  private readonly onEvent: (event: WorkerEvent) => void
  private readonly onFailing: (worker: WorkerInfo) => void
  private readonly onChange: () => void
  private readonly killTree: (pid: number | undefined) => void
  private readonly killLeftover: (pid: number) => boolean
  private readonly baseEnv: NodeJS.ProcessEnv
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly graceMs: number
  private readonly failLimit: number
  private readonly failWindowMs: number
  private readonly backoffMaxMs: number
  private readonly checkEveryMs: number
  private readonly live = new Map<string, Live>()
  private checker: NodeJS.Timeout | null = null
  private closed = false

  constructor(deps: SupervisorDeps) {
    this.store = deps.store
    this.spawn = deps.spawn
    this.secrets = deps.secrets
    this.onEvent = deps.onEvent ?? (() => undefined)
    this.onFailing = deps.onFailing ?? (() => undefined)
    this.onChange = deps.onChange ?? (() => undefined)
    this.killTree = deps.killTree ?? (() => undefined)
    this.killLeftover = deps.killLeftover ?? (() => false)
    this.baseEnv = deps.baseEnv ?? process.env
    this.now = deps.now ?? Date.now
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS
    this.graceMs = deps.graceMs ?? GRACE_MS
    this.failLimit = deps.failLimit ?? FAIL_LIMIT
    this.failWindowMs = deps.failWindowMs ?? FAIL_WINDOW_MS
    this.backoffMaxMs = deps.backoffMaxMs ?? BACKOFF_MAX_MS
    this.checkEveryMs = deps.checkEveryMs ?? 15_000
  }

  /** App open: bring every enabled worker back. Safe to call more than once. */
  start(): void {
    this.closed = false
    for (const { manifest } of this.store.manifests()) {
      if (manifest === null || !manifest.enabled) continue
      const pid = this.store.state(manifest.id).pid
      if (pid !== null && pid > 0) this.killLeftover(pid)
      this.launch(manifest.id, true)
    }
    if (this.checker === null) {
      this.checker = setInterval(() => this.checkHung(), this.checkEveryMs)
      this.checker.unref?.()
    }
    this.store.prune()
  }

  /** The computer woke up: anything that went quiet while it slept is restarted now. */
  resume(): void {
    this.checkHung()
  }

  /** Start (or start again) one worker. A manual start clears a failing state and switches it on. */
  startWorker(id: string): void {
    const manifest = this.store.manifest(id)
    if (manifest === null) throw new Error(`No worker ${id}.`)
    if (!manifest.enabled) this.store.setEnabled(id, true)
    const live = this.live.get(id)
    if (live !== undefined) {
      live.failures = []
      if (live.child !== null) return
      if (live.timer !== null) clearTimeout(live.timer)
      live.timer = null
    }
    this.launch(id, false)
  }

  /** Stop one worker and switch it off, so it stays off after the app restarts. */
  async stopWorker(id: string): Promise<void> {
    this.store.setEnabled(id, false)
    await this.halt(id, 'stopped')
  }

  async restart(id: string): Promise<void> {
    await this.halt(id, 'stopped')
    this.startWorker(id)
  }

  async remove(id: string): Promise<void> {
    await this.halt(id, 'stopped')
    this.live.delete(id)
    const manifest = this.store.manifest(id)
    for (const name of manifest?.secrets ?? []) {
      if (this.secrets.delete !== undefined) this.secrets.delete(secretKey(id, name))
      else this.secrets.set(secretKey(id, name), '')
    }
    this.store.remove(id)
    this.onChange()
  }

  /** App quit: every worker is told to stop, then its process tree is ended. Its stop time is saved first. */
  stopAll(): void {
    this.closed = true
    if (this.checker !== null) clearInterval(this.checker)
    this.checker = null
    for (const [id, live] of this.live) {
      if (live.timer !== null) clearTimeout(live.timer)
      live.timer = null
      live.stopping = true
      this.store.patchState(id, { stoppedAt: this.now(), pid: null, ...(live.lastLineAt === null ? {} : { lastLineAt: live.lastLineAt }) })
      const child = live.child
      if (child === null) continue
      try {
        child.stdin?.write('{"type":"stop"}\n')
      } catch {
        // Already gone.
      }
      // The app is quitting: no time for the grace period, the tree goes now.
      this.killTree(child.pid)
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
  }

  setSecret(id: string, name: string, value: string): void {
    if (!WORKER_SECRET_NAME.test(name)) throw new Error('Secret names are CAPITALS_AND_UNDERSCORES.')
    this.secrets.set(secretKey(id, name), value)
    this.onChange()
  }

  info(): WorkerInfo[] {
    const out: WorkerInfo[] = []
    for (const { manifest, id, problem } of this.store.manifests()) {
      const live = this.live.get(id)
      const saved = this.store.state(id)
      const base: WorkerManifest = manifest ?? {
        id,
        name: id,
        about: `worker.json has a problem: ${problem}`,
        entry: '',
        runtime: 'node',
        args: [],
        mode: 'stay',
        everyMinutes: null,
        secrets: [],
        enabled: false,
        createdAt: 0,
        updatedAt: 0,
      }
      out.push({
        ...base,
        dir: this.store.dirOf(id),
        state: live?.state ?? 'stopped',
        pid: live?.child?.pid ?? null,
        upSince: live?.upSince ?? null,
        lastEventAt: saved.lastEventAt,
        lastLineAt: live?.lastLineAt ?? saved.lastLineAt,
        eventsToday: saved.eventsToday,
        restartsToday: saved.restartsToday,
        lastError: problem !== '' ? problem : saved.lastError,
        downSince: live?.child != null ? null : (saved.stoppedAt ?? null),
        lastGap: saved.lastGap,
        secretsSet: base.secrets.filter((name) => (this.secrets.get(secretKey(id, name)) ?? '') !== ''),
        nextRunAt: live?.nextRunAt ?? null,
      })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Run a worker once, for up to `seconds`, and hand back what it printed. Nothing is stored or routed: this is how
   * an agent checks its script before (or after) saving it.
   */
  test(manifest: WorkerManifest, dir: string, seconds: number): Promise<TestRun> {
    const started = this.now()
    const run: TestRun = { events: [], logs: [], cursor: null, exitCode: null, ranMs: 0 }
    return new Promise<TestRun>((resolve) => {
      let child: ChildLike
      try {
        child = this.spawn({ manifest, dir, env: this.envFor(manifest, { cursor: this.store.state(manifest.id).cursor, downSince: null, test: true }) })
      } catch (error) {
        run.logs.push({ at: this.now(), level: 'error', text: `Could not start: ${message(error)}` })
        resolve(run)
        return
      }
      let done = false
      const finish = (code: number | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        run.exitCode = code
        run.ranMs = this.now() - started
        resolve(run)
      }
      const timer = setTimeout(() => {
        run.logs.push({ at: this.now(), level: 'info', text: `Stopped after ${seconds} s (test run).` })
        try {
          child.stdin?.write('{"type":"stop"}\n')
        } catch {
          // Gone.
        }
        this.killTree(child.pid)
        try {
          child.kill()
        } catch {
          // Gone.
        }
        finish(null)
      }, Math.max(1, Math.min(seconds, 120)) * 1000)
      readLines(child.stdout, (line) => {
        const parsed = parseWorkerLine(line)
        if (parsed === null) return
        if (parsed.type === 'event') run.events.push({ source: parsed.event.source, event: parsed.event.event, dedupeKey: parsed.event.dedupeKey, payload: parsed.event.payload })
        else if (parsed.type === 'cursor') run.cursor = parsed.value
        else if (parsed.type === 'log') run.logs.push({ at: this.now(), level: parsed.level, text: parsed.text })
        else run.logs.push({ at: this.now(), level: 'info', text: parsed.type })
        if (run.events.length >= 200) finish(null)
      })
      readLines(child.stderr, (line) => run.logs.push({ at: this.now(), level: 'warn', text: line }))
      child.on('error', (error) => {
        run.logs.push({ at: this.now(), level: 'error', text: message(error) })
        finish(null)
      })
      child.on('exit', (code) => finish(code))
    })
  }

  // ---- internals ----

  private launch(id: string, appStart: boolean): void {
    if (this.closed) return
    const manifest = this.store.manifest(id)
    if (manifest === null) return
    let live = this.live.get(id)
    if (live === undefined) {
      live = { child: null, state: 'stopped', upSince: null, lastLineAt: null, lineSavedAt: 0, failures: [], timer: null, nextRunAt: null, stopping: false, hung: false, lastStderr: '', gap: null }
      this.live.set(id, live)
    }
    if (live.child !== null) return
    for (const [name, value] of Object.entries(this.store.takeSecretDrop(id))) {
      if (WORKER_SECRET_NAME.test(name)) this.secrets.set(secretKey(id, name), value)
    }
    const saved = this.store.state(id)
    const downSince = maxOf(saved.stoppedAt, saved.lastLineAt)
    const startedAt = this.now()
    live.stopping = false
    live.hung = false
    live.lastStderr = ''
    live.nextRunAt = null
    live.state = 'starting'
    live.gap = downSince === null || manifest.mode === 'every' ? null : { from: downSince, to: startedAt }

    let child: ChildLike
    try {
      child = this.spawn({ manifest, dir: this.store.dirOf(id), env: this.envFor(manifest, { cursor: saved.cursor, downSince, test: false }) })
    } catch (error) {
      this.log(id, 'error', `Could not start: ${message(error)}`)
      this.failed(id, live, `Could not start: ${message(error)}`)
      return
    }
    live.child = child
    live.upSince = startedAt
    live.lastLineAt = startedAt
    this.store.patchState(id, {
      ...(live.gap === null ? {} : { lastGap: { ...live.gap, caughtUp: 0 } }),
      pid: child.pid ?? null,
    })
    this.log(id, 'info', appStart && live.gap !== null ? `Started; catching up from ${new Date(live.gap.from).toISOString()}` : 'Started')
    this.onChange()

    const current = live
    readLines(child.stdout, (line) => this.onLine(id, current, child, line))
    readLines(child.stderr, (line) => {
      if (current.child !== child) return
      current.lastStderr = line.slice(0, 400)
      current.lastLineAt = this.now()
      this.log(id, 'warn', line)
    })
    child.on('error', (error) => {
      if (current.child !== child) return
      this.log(id, 'error', message(error))
      current.lastStderr = message(error)
    })
    child.on('exit', (code, signal) => this.onExit(id, current, child, code, signal))
  }

  private onLine(id: string, live: Live, child: ChildLike, line: string): void {
    if (live.child !== child || this.closed) return
    const parsed = parseWorkerLine(line)
    if (parsed === null) return
    const at = this.now()
    live.lastLineAt = at
    if (live.state === 'starting') {
      live.state = 'running'
      this.onChange()
    }
    if (at - live.lineSavedAt > LINE_SAVE_MS) {
      live.lineSavedAt = at
      this.store.patchState(id, { lastLineAt: at })
    }
    switch (parsed.type) {
      case 'ready':
        // Connected again: an old error no longer describes it.
        if (this.store.state(id).lastError !== '') {
          this.store.patchState(id, { lastError: '' })
          this.onChange()
        }
        return
      case 'alive':
        return
      case 'log':
        this.log(id, parsed.level, parsed.text)
        return
      case 'cursor':
        this.store.patchState(id, { cursor: parsed.value })
        return
      case 'event': {
        const stored = this.store.addEvent(id, parsed.event)
        if (stored === null) return
        const state = this.store.state(id)
        const gap = live.gap !== null && at - (live.upSince ?? at) < CATCH_UP_MS ? { ...live.gap, caughtUp: (state.lastGap?.caughtUp ?? 0) + 1 } : state.lastGap
        this.store.patchState(id, { lastEventAt: at, eventsToday: state.eventsToday + 1, lastGap: gap })
        try {
          this.onEvent(stored)
        } catch {
          // Routing failing must never take the worker down; the event is stored as new and routed later.
        }
        this.onChange()
        return
      }
    }
  }

  private onExit(id: string, live: Live, child: ChildLike, code: number | null, signal: string | null): void {
    if (live.child !== child) return
    live.child = null
    live.upSince = null
    // The app is quitting: stopAll already saved when it stopped, and the store may be closed by now.
    if (this.closed) {
      live.state = 'stopped'
      return
    }
    const at = this.now()
    this.store.patchState(id, { stoppedAt: at, lastLineAt: live.lastLineAt, pid: null })
    if (live.stopping) {
      live.state = 'stopped'
      this.log(id, 'info', 'Stopped')
      this.onChange()
      return
    }
    const manifest = this.store.manifest(id)
    if (manifest !== null && manifest.mode === 'every' && code === 0) {
      live.state = 'waiting'
      live.nextRunAt = at + (manifest.everyMinutes ?? 5) * 60_000
      this.log(id, 'info', `Finished; next run ${new Date(live.nextRunAt).toISOString()}`)
      live.timer = setTimeout(() => {
        live.timer = null
        this.launch(id, false)
      }, live.nextRunAt - at)
      live.timer.unref?.()
      this.onChange()
      return
    }
    const why = live.hung
      ? `Stopped answering (no line for ${Math.round(this.heartbeatMs / 1000)} s)`
      : live.lastStderr !== ''
        ? `Exited (${code ?? signal ?? 'killed'}): ${live.lastStderr}`
        : `Exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}`
    this.log(id, 'error', why)
    this.failed(id, live, why)
  }

  /** A start that failed or a process that died: back off and try again, or give up visibly. */
  private failed(id: string, live: Live, why: string): void {
    const at = this.now()
    live.child = null
    live.failures = [...live.failures.filter((t) => at - t < this.failWindowMs), at]
    const state = this.store.patchState(id, { lastError: why.slice(0, 400), stoppedAt: at })
    if (live.failures.length >= this.failLimit) {
      live.state = 'failing'
      this.log(id, 'error', `Failed ${live.failures.length} times in ${Math.round(this.failWindowMs / 60_000)} minutes; not retrying until it is restarted.`)
      this.onChange()
      const info = this.info().find((w) => w.id === id)
      if (info !== undefined) this.onFailing(info)
      return
    }
    const delay = Math.min(1000 * 2 ** (live.failures.length - 1), this.backoffMaxMs)
    live.state = 'backoff'
    live.nextRunAt = at + delay
    this.store.patchState(id, { restartsToday: state.restartsToday + 1 })
    live.timer = setTimeout(() => {
      live.timer = null
      this.launch(id, false)
    }, delay)
    live.timer.unref?.()
    this.onChange()
  }

  private async halt(id: string, state: WorkerState): Promise<void> {
    const live = this.live.get(id)
    if (live === undefined) return
    if (live.timer !== null) clearTimeout(live.timer)
    live.timer = null
    live.nextRunAt = null
    const child = live.child
    if (child === null) {
      live.state = state
      this.onChange()
      return
    }
    live.stopping = true
    await new Promise<void>((resolve) => {
      let finished = false
      const done = (): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve()
      }
      child.on('exit', done)
      try {
        child.stdin?.write('{"type":"stop"}\n')
      } catch {
        // Gone already.
      }
      const timer = setTimeout(() => {
        this.killTree(child.pid)
        try {
          child.kill()
        } catch {
          // Gone already.
        }
        setTimeout(done, 1000)
      }, this.graceMs)
    })
    live.state = state
    this.onChange()
  }

  private checkHung(): void {
    const at = this.now()
    for (const [id, live] of this.live) {
      const child = live.child
      if (child === null || live.lastLineAt === null) continue
      const manifest = this.store.manifest(id)
      if (manifest === null || manifest.mode !== 'stay') continue
      if (at - live.lastLineAt <= this.heartbeatMs) continue
      live.hung = true
      this.log(id, 'warn', `No line for ${Math.round((at - live.lastLineAt) / 1000)} s; restarting.`)
      this.killTree(child.pid)
      try {
        child.kill()
      } catch {
        // Gone already; its exit handler restarts it.
      }
    }
  }

  private envFor(manifest: WorkerManifest, run: { cursor: string; downSince: number | null; test: boolean }): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv }
    // Nothing of the app's own keys leaks into a worker: only what it declared.
    for (const key of Object.keys(env)) if (/^(AGENT_|ELECTRON_)/.test(key)) delete env[key]
    env['AGENT_WORKER_ID'] = manifest.id
    env['AGENT_WORKER_DIR'] = this.store.dirOf(manifest.id)
    env['AGENT_WORKER_CURSOR'] = run.cursor
    env['AGENT_WORKER_DOWN_SINCE'] = run.downSince === null ? '' : String(run.downSince)
    env['AGENT_WORKER_TEST'] = run.test ? '1' : ''
    for (const name of manifest.secrets) env[name] = this.secrets.get(secretKey(manifest.id, name)) ?? ''
    return env
  }

  private log(id: string, level: WorkerLogLine['level'], text: string): void {
    this.store.log(id, { at: this.now(), level, text: text.slice(0, 2000) })
  }
}

/** The app's secret store takes letters, digits, _ and - only. */
export function secretKey(id: string, name: string): string {
  return `worker-${id}-${name}`
}

function readLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (stream === null) return
  let buffer = ''
  stream.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.trim() !== '') onLine(line)
      index = buffer.indexOf('\n')
    }
    if (buffer.length > 1_000_000) buffer = ''
  })
  stream.on('end', () => {
    if (buffer.trim() !== '') onLine(buffer)
    buffer = ''
  })
}

function maxOf(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
