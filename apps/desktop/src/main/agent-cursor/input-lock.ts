/**
 * The input lock (11 Nov 2026): the ONLY path to real input (SendInput, SetCursorPos, mouse_event, keybd_event, SendKeys,
 * SetForegroundWindow on his desktop). The agent's normal way is screen_act, which reaches one window without his
 * pointer or focus. Real input is the last resort, and only on these terms:
 *
 *  - a notice to him first, saying what will happen to which window and for how long, with Not now;
 *  - only when he has been idle for inputLockIdleSeconds (default 10), re-checked right before the first event;
 *  - it never starts while he is typing: his activity restarts the wait, and the wait gives up after a limit;
 *  - it aborts the moment he touches the mouse or keyboard (the sidecar's hooks tell his input from ours by the
 *    injected flags) and then stays off for a cool-down, because he is back;
 *  - it puts his pointer and his foreground window back afterwards, and says whether that worked.
 *
 * One request at a time. Not covered here, on purpose: his own actions (dictation pasting into his own window,
 * handing the keyboard back to the window he was in). Those are his, not the agent's.
 *
 * The native half is the sidecar's "inject" op (tools/agent-screen/src/Act.cs), which also enforces idle, abort and
 * restore itself; this module decides WHETHER it may run and tells him first.
 */

export interface InjectStep {
  do: 'click' | 'double_click' | 'right_click' | 'move' | 'scroll' | 'type' | 'key'
  /** Pixels from the window's top left. */
  x?: number
  y?: number
  text?: string
  key?: string
  dy?: number
  waitMs?: number
}

export interface InjectRequest {
  hwnd: string
  pid: number
  steps: InjectStep[]
  /** The sidecar refuses unless he has been idle at least this long. */
  minIdleMs: number
}

export interface InjectResult {
  done: number
  of: number
  aborted: boolean
  why?: string
  cursorRestored: boolean
  foregroundRestored: boolean
}

/** The native injector: in the app, the sidecar's "inject" op. A test passes a stub. */
export interface InputInjector {
  inject(request: InjectRequest, signal: AbortSignal): Promise<InjectResult>
}

/** How long he has not touched the mouse or keyboard, ms; -1 when unknown (treated as active). */
export interface LockPresence {
  idleMs(): Promise<number>
}

/** The notice. Resolves 'go' when the grace time passed with no Not now, 'not_now' when he pressed it. */
export interface LockNotice {
  ask(notice: { text: string; graceMs: number; owner: string }, signal: AbortSignal): Promise<'go' | 'not_now'>
}

export interface InputLockSettings {
  /** Seconds he must have been idle. Default 10. */
  inputLockIdleSeconds: number
}

export interface InputLockDeps {
  settings: () => InputLockSettings
  presence: LockPresence
  notice: LockNotice
  injector: InputInjector
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** How long the wait for idle may last before giving up, ms. Default 30 000. */
  waitMaxMs?: number
  /** How often idle is read while waiting, ms. Default 250. */
  pollMs?: number
  /** How long he has to say Not now, ms. Default 4000. */
  graceMs?: number
  /** After an abort, no real input for this long, ms. Default 60 000. */
  coolDownMs?: number
}

export interface InputRequest {
  hwnd: string
  pid: number
  /** Plain words for the notice: "click Save in Notepad". */
  what: string
  /** The window's name for the notice. */
  windowTitle: string
  steps: InjectStep[]
  /** Who is asking (a helper's name); shown in the notice. */
  owner: string
  signal?: AbortSignal
}

export type InputOutcome =
  | { ok: true; result: InjectResult; restored: boolean }
  | { ok: false; code: 'not_now' | 'busy' | 'aborted' | 'cooling_down' | 'cancelled' | 'unavailable'; message: string; result?: InjectResult }

export const DEFAULT_IDLE_SECONDS = 10

/** How long the steps will take, ms: a plain estimate for the notice. */
export function estimateMs(steps: InjectStep[]): number {
  let total = 300
  for (const step of steps) {
    total += Math.max(20, Math.min(2000, step.waitMs ?? 90))
    if (step.do === 'type') total += (step.text?.length ?? 0) * 8
    if (step.do === 'click' || step.do === 'double_click' || step.do === 'right_click' || step.do === 'move') total += 60
  }
  return total
}

export function noticeText(request: InputRequest, ms: number, idleSeconds: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000))
  return (
    request.owner + ' needs to ' + request.what + ' in ' + request.windowTitle + ' with your mouse and keyboard, for about ' + seconds + ' second' + (seconds === 1 ? '' : 's') +
    '. It starts once you have been still for ' + idleSeconds + ' seconds, and stops the moment you touch either one. Press Not now to refuse.'
  )
}

export class InputLock {
  private deps: InputLockDeps
  private busy: Promise<unknown> = Promise.resolve()
  private coolUntil = 0

  constructor(deps: InputLockDeps) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((wait: number) => new Promise<void>((resolve) => setTimeout(resolve, wait))))(ms)
  }

  /** Ask to use real input. Requests run one at a time. */
  request(request: InputRequest): Promise<InputOutcome> {
    const run = this.busy.then(
      () => this.run(request),
      () => this.run(request),
    )
    this.busy = run.catch(() => undefined)
    return run
  }

  private async run(request: InputRequest): Promise<InputOutcome> {
    const signal = request.signal ?? new AbortController().signal
    if (request.steps.length === 0) return { ok: false, code: 'unavailable', message: 'No steps to send.' }
    if (this.now() < this.coolUntil) {
      return { ok: false, code: 'cooling_down', message: 'He touched the mouse or keyboard a moment ago, so real input is off for a little while. Try screen_act, or ask again later.' }
    }
    const idleSeconds = Math.max(1, Math.floor(this.deps.settings().inputLockIdleSeconds || DEFAULT_IDLE_SECONDS))
    const need = idleSeconds * 1000
    const estimate = estimateMs(request.steps)

    // 1. Tell him, with Not now.
    const verdict = await this.deps.notice.ask({ text: noticeText(request, estimate, idleSeconds), graceMs: this.deps.graceMs ?? 4000, owner: request.owner }, signal)
    if (verdict === 'not_now') return { ok: false, code: 'not_now', message: 'He pressed Not now. Do not ask again for this; use screen_act or tell him what needs doing.' }
    if (signal.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled.' }

    // 2. Wait until he has been idle for long enough. His activity restarts the count (he is typing).
    const pollMs = this.deps.pollMs ?? 250
    const until = this.now() + (this.deps.waitMaxMs ?? 30_000)
    for (;;) {
      if (signal.aborted) return { ok: false, code: 'cancelled', message: 'Cancelled.' }
      const idle = await this.deps.presence.idleMs()
      if (idle >= need) break
      if (this.now() >= until) return { ok: false, code: 'busy', message: 'He kept using the mouse or keyboard, so nothing was sent.' }
      await this.sleep(pollMs)
    }

    // 3. Check again right before the first event: a person may have started typing since.
    const again = await this.deps.presence.idleMs()
    if (again < need) return { ok: false, code: 'busy', message: 'He started typing just then, so nothing was sent.' }

    // 4. Send. The injector watches for his input and stops at once.
    let result: InjectResult
    try {
      result = await this.deps.injector.inject({ hwnd: request.hwnd, pid: request.pid, steps: request.steps, minIdleMs: need }, signal)
    } catch (error) {
      return { ok: false, code: 'unavailable', message: error instanceof Error ? error.message : String(error) }
    }
    if (result.aborted) {
      this.coolUntil = this.now() + (this.deps.coolDownMs ?? 60_000)
      return { ok: false, code: 'aborted', message: 'He touched the mouse or keyboard, so it stopped' + (result.why ? ' (' + result.why + ')' : '') + '. ' + result.done + ' of ' + result.of + ' steps were sent.', result }
    }
    return { ok: true, result, restored: result.cursorRestored && result.foregroundRestored }
  }
}
