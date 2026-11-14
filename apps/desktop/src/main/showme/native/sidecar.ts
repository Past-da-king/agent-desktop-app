/**
 * The `agent-screen` helper process (tools/agent-screen, C# on Windows UI Automation) and the JSON lines it
 * speaks: one request line in, one answer line out, plus event lines (input, move). This file starts it, finds
 * it, and keeps the calls straight; what the calls mean is in ./windows.ts.
 *
 * It is started on the first call and stopped after a quiet spell, so it costs nothing while nobody is being
 * shown anything. It also exits by itself when this process dies (it watches its parent and its stdin).
 */
import { spawn as nodeSpawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface SpawnLike {
  (command: string, args: string[], options: SpawnOptions): ChildProcess
}

export interface ScreenSidecarLookup {
  /** `process.resourcesPath` in a packaged Electron app. */
  resourcesPath?: string
  /** More folders to look in (the repo in development). */
  dirs?: string[]
  env?: NodeJS.ProcessEnv
  platform?: string
  arch?: string
  exists?: (path: string) => boolean
}

/**
 * Where the helper is: AGENT_SCREEN_PATH, then `<resources>/agent-screen/agent-screen.exe` (electron-builder
 * extraResources), then `tools/agent-screen/bin/win-<arch>/` under each folder in `dirs`. Windows only.
 */
export function findScreenSidecar(lookup: ScreenSidecarLookup = {}): string | null {
  const env = lookup.env ?? process.env
  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  if (platform !== 'win32') return null
  const arch = (lookup.arch ?? process.arch) === 'arm64' ? 'arm64' : 'x64'
  const candidates: string[] = []
  const fromEnv = env['AGENT_SCREEN_PATH']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim())
  if (lookup.resourcesPath !== undefined && lookup.resourcesPath !== '') candidates.push(join(lookup.resourcesPath, 'agent-screen', 'agent-screen.exe'))
  for (const dir of lookup.dirs ?? []) {
    candidates.push(join(dir, 'agent-screen.exe'))
    candidates.push(join(dir, 'tools', 'agent-screen', 'bin', `win-${arch}`, 'agent-screen.exe'))
    // An x64 build runs on Windows on Arm too.
    if (arch !== 'x64') candidates.push(join(dir, 'tools', 'agent-screen', 'bin', 'win-x64', 'agent-screen.exe'))
  }
  return candidates.find((path) => exists(path)) ?? null
}

/** A refusal the caller can act on: `code` says which ('elevated', 'timeout', 'no_window', 'gone', 'unavailable', 'failed'). */
export class ScreenReadError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ScreenReadError'
    this.code = code
  }
}

export type SidecarEvent = Record<string, unknown> & { event: string }

export interface ScreenSidecarDeps {
  binary: () => string | null
  spawn?: SpawnLike
  /** Called for every event line (not answers). */
  onEvent: (event: SidecarEvent) => void
  /** The helper stopped without being asked (a crash): everything it was following is gone. */
  onLost: () => void
  /** True while something still needs the helper (a watch, an input listener): it is then never stopped for being quiet. */
  busy: () => boolean
  log?: (message: string, detail?: Record<string, unknown>) => void
  /** Stop the helper after this long without a call, ms. */
  idleMs?: number
  /** How long one call may take, ms. */
  callTimeoutMs?: number
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** One answer line or event line, checked; null for anything else (it never throws). */
export function parseSidecarLine(line: string): Record<string, unknown> | null {
  if (line.length === 0 || line[0] !== '{') return null
  try {
    const value: unknown = JSON.parse(line)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

export class ScreenSidecar {
  private deps: ScreenSidecarDeps
  private child: ChildProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 0
  private buffer = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** How many times it was started; a caller that kept state in the helper compares this to know it was lost. */
  generation = 0

  constructor(deps: ScreenSidecarDeps) {
    this.deps = deps
  }

  running(): boolean {
    return this.child !== null
  }

  /** Why the helper cannot run here, or null when it can. */
  unavailableReason(): string | null {
    if (process.platform !== 'win32' && this.deps.spawn === undefined) return 'Showing steps on other windows works on Windows only for now.'
    if (this.deps.binary() === null) return 'The screen helper (agent-screen.exe) is missing from this install.'
    return null
  }

  private start(): ChildProcess {
    if (this.child !== null) return this.child
    const binary = this.deps.binary()
    if (binary === null) throw new ScreenReadError('unavailable', this.unavailableReason() ?? 'The screen helper is missing.')
    const spawn = this.deps.spawn ?? nodeSpawn
    const child = spawn(binary, ['--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    this.child = child
    this.generation += 1
    this.buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.onData(chunk))
    child.stdin?.on('error', () => undefined)
    const ended = (why: string): void => {
      if (this.child !== child) return
      this.child = null
      const lost = [...this.pending.values()]
      this.pending.clear()
      for (const call of lost) {
        clearTimeout(call.timer)
        call.reject(new ScreenReadError('unavailable', 'The screen helper stopped.'))
      }
      if (!this.disposed) {
        this.deps.log?.('showme: the screen helper stopped', { why })
        this.deps.onLost()
      }
    }
    child.once('exit', (code) => ended(`exit ${String(code)}`))
    child.once('error', (error) => ended(error.message))
    return child
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const at = this.buffer.indexOf('\n')
      if (at < 0) break
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      const message = parseSidecarLine(line)
      if (message === null) continue
      if (typeof message['event'] === 'string') {
        try {
          this.deps.onEvent(message as SidecarEvent)
        } catch {
          // A listener's own error must not stop the reader.
        }
        continue
      }
      const id = message['id']
      if (typeof id !== 'number') continue
      const call = this.pending.get(id)
      if (call === undefined) continue
      this.pending.delete(id)
      clearTimeout(call.timer)
      if (message['ok'] === true) call.resolve(message['result'])
      else call.reject(new ScreenReadError(typeof message['code'] === 'string' ? message['code'] : 'failed', typeof message['error'] === 'string' ? message['error'] : 'The screen could not be read.'))
    }
  }

  /** One request; resolves with its result, rejects with a ScreenReadError. */
  call(op: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    if (this.disposed) return Promise.reject(new ScreenReadError('unavailable', 'The screen reader was closed.'))
    let child: ChildProcess
    try {
      child = this.start()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new ScreenReadError('unavailable', String(error)))
    }
    this.touch()
    const id = ++this.nextId
    const limit = timeoutMs ?? this.deps.callTimeoutMs ?? 10_000
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new ScreenReadError('timeout', 'That window did not answer in time.'))
      }, limit)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin?.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  /** Restart the quiet-spell clock; when it runs out and nothing needs the helper, the helper is stopped. */
  touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    const idleMs = this.deps.idleMs ?? 120_000
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.deps.busy() || this.pending.size > 0) this.touch()
      else this.stop()
    }, idleMs)
    this.idleTimer.unref?.()
  }

  /** Stop the helper now (it starts again on the next call). */
  stop(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer)
    this.idleTimer = null
    const child = this.child
    if (child === null) return
    this.child = null
    for (const call of this.pending.values()) {
      clearTimeout(call.timer)
      call.reject(new ScreenReadError('unavailable', 'The screen helper stopped.'))
    }
    this.pending.clear()
    try {
      child.stdin?.end(`${JSON.stringify({ op: 'quit' })}\n`)
    } catch {
      // Already gone.
    }
    const killer = setTimeout(() => {
      if (child.exitCode === null) child.kill()
    }, 1_500)
    killer.unref?.()
    child.once('exit', () => clearTimeout(killer))
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }
}
