/**
 * The agent's browser never leaves him without the keyboard (11 Nov 2026, 0.2.128; measured, see docs/agent-cursor.md
 * "Browser focus").
 *
 * The agent's pages are <webview>s inside the app window, in the same focus tree as the chat box. Measured on Electron 44
 * in a real window, with page focus emulation already on: Chromium moves the keyboard to the page (the chat box loses
 * its caret and every key he types goes into the agent's page) for exactly two kinds of debugger command: a mouse, touch
 * or tap press (Input.dispatchMouseEvent mousePressed, Input.dispatchTouchEvent, Input.synthesizeTapGesture; hover,
 * wheel and mouse move do not), and a Tab key (focus traversal). Everything else leaves it alone: a page script's
 * el.focus(), Input.insertText, Enter, Space, arrows, screenshots, snapshots, reads, evals. Chromium offers no switch
 * for it (the focus is taken inside the browser process by the input injector), so the fix is in three parts:
 *
 *   1. prevention: the agent no longer uses a press where none is needed. Typing focuses the field by script and
 *      inserts the text; tick boxes and radios are toggled with Space on the focused element; Tab moves focus by script
 *      (browser.ts, snapshot.ts). Only a real click (button, link, custom control, point on a screenshot, double or right
 *      click, hold, drag) still presses.
 *   2. this guard, for what is left: every Input command goes through the page's one debugger (guardDebugger), so no
 *      caller (browser tools, Vault fill, guide) can forget it. While one runs, and for SETTLE_MS after the last one,
 *      it asks the app's own page every TICK_MS whether the keyboard is still there and, the first time it is not, gives
 *      it back to the exact element he was typing in (webContents.focus(), then element.focus() with his caret and
 *      selection untouched). It never runs when the app is not the window he is in, so it cannot bring the app forward.
 *   3. it logs every time it had to give the keyboard back, so a path that still takes it shows up in the log.
 */
export interface FocusProbe {
  /** Is the app window the window he is using now (the operating system's foreground)? */
  appFocused(): boolean
  /** Does the app window's OWN page (not a guest) hold the keyboard? Asked of the page itself: its document has focus. */
  hostHasKeyboard(): Promise<boolean>
  /** Remembers which element of the app's page has focus (the message box). */
  saveActive(): Promise<void>
  /** Gives the keyboard back to the app's page and that element, with the caret where it was. */
  restoreHost(): Promise<void>
  /** Forgets the remembered element. */
  forgetActive(): Promise<void>
  /** Types keys he pressed while the page held the keyboard into the chat box, once it has it back. */
  replay?(keys: HeldKey[]): Promise<void>
  /** One line for the log when the keyboard had to be given back. */
  note?(what: string, detail: Record<string, unknown>): void
}

/** A real key he pressed while a click of the agent held the keyboard in the page (from Electron's before-input-event). */
export interface HeldKey {
  type: 'keyDown' | 'keyUp'
  key: string
  shift: boolean
  control: boolean
  alt: boolean
  meta: boolean
}

export interface SentKey {
  type: 'keyDown' | 'char' | 'keyUp'
  keyCode: string
  modifiers: Array<'shift' | 'control' | 'alt' | 'meta'>
}

const NAMED: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Enter',
  ' ': 'Space',
  Escape: 'Escape',
}

/** What to send into the chat box to type that key: a printable key is a keyDown and a char, as a keyboard makes them. */
export function keyToEvents(k: HeldKey): SentKey[] {
  const modifiers: SentKey['modifiers'] = []
  if (k.shift) modifiers.push('shift')
  if (k.control) modifiers.push('control')
  if (k.alt) modifiers.push('alt')
  if (k.meta) modifiers.push('meta')
  const keyCode = NAMED[k.key] ?? k.key
  if (k.type === 'keyUp') return [{ type: 'keyUp', keyCode, modifiers }]
  const out: SentKey[] = [{ type: 'keyDown', keyCode, modifiers }]
  if (k.key.length === 1 && !k.control && !k.alt && !k.meta) out.push({ type: 'char', keyCode: k.key, modifiers })
  return out
}

export interface GuardTiming {
  /** How often the page is asked while a command runs and just after. */
  tickMs?: number
  /** How long after the last command it keeps asking (Chromium tells the page a moment after the command returns). */
  settleMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export const TICK_MS = 6
export const SETTLE_MS = 150

export class FocusGuard {
  /** How many times the keyboard had to be given back (the safety net firing). */
  fired = 0
  /** Keys of his kept from the page, and typed into the chat box once it had the keyboard back. */
  swallowed = 0
  replayed = 0
  private depth = 0
  /** Bursts running now: the page holds the keyboard on purpose until the last one ends. */
  private holds = 0
  /** Bursts whose grab has been made: the page really holds the keyboard now. */
  private grabbed = 0
  /** Bursts that send keys of their own now: a key arriving then is the agent's, never his. */
  private keyBursts = 0
  private held: HeldKey[] = []
  private had = false
  private watching = false
  private lastEnd = 0
  private label = ''
  private readonly tick: number
  private readonly settle: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(
    private readonly probe: FocusProbe,
    timing: GuardTiming = {},
  ) {
    this.tick = timing.tickMs ?? TICK_MS
    this.settle = timing.settleMs ?? SETTLE_MS
    this.sleep = timing.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = timing.now ?? Date.now
  }

  /** Runs one agent action that may move the keyboard, and gives it back the moment it is taken. */
  async around<T>(run: () => Promise<T>, label = ''): Promise<T> {
    this.depth += 1
    this.label = label
    try {
      if (!this.watching) await this.begin()
      return await run()
    } finally {
      this.depth -= 1
      this.lastEnd = this.now()
    }
  }

  /**
   * One burst of input the agent needs the page to RECEIVE: a click (the press takes the keyboard by itself) or a key
   * (the debugger sends keys to whoever holds the keyboard in the window, which is the chat box unless the page was
   * given it first, so `grab` gives it to the page, then the keys go in). The keyboard goes back to the exact element he
   * was typing in the moment the burst ends, never in the middle of it, so a key can never land in his message.
   */
  async burst<T>(grab: () => void, run: () => Promise<T>, label = '', options: { keys?: boolean } = {}): Promise<T> {
    this.depth += 1
    this.holds += 1
    if (options.keys === true) this.keyBursts += 1
    this.label = label
    try {
      if (!this.watching) await this.begin()
      try {
        grab()
      } catch {
        // the page went away
      }
      this.grabbed += 1
      return await run()
    } finally {
      this.depth -= 1
      if (options.keys === true) this.keyBursts -= 1
      this.lastEnd = this.now()
      // The last burst out gives the keyboard back and types what he pressed meanwhile; it still counts as holding until
      // then, so a key of his that arrives in that gap is kept from the page too.
      if (this.holds === 1 && this.had) {
        await this.giveBack()
        await this.replayHeld()
      }
      this.holds -= 1
      this.grabbed = Math.max(0, this.grabbed - 1)
    }
  }

  /**
   * A real key he pressed while a click of the agent held the keyboard in the page: true means keep it from the page; it
   * is typed into the chat box as soon as the box has the keyboard again, in the order he pressed it, so nothing he
   * types is lost or lands in the agent's page. False for everything else (no burst, he was not in the box, or the
   * keys are the agent's own).
   */
  swallow(key: HeldKey): boolean {
    if (this.holds === 0 || !this.had || this.keyBursts > 0) return false
    this.held.push(key)
    this.swallowed += 1
    return true
  }

  private async replayHeld(): Promise<void> {
    while (this.held.length > 0) {
      const keys = this.held
      this.held = []
      try {
        await this.probe.replay?.(keys)
        this.replayed += keys.length
      } catch {
        // Never stop an action over this.
      }
    }
  }

  /** A burst holds the keyboard in the page right now. */
  isHolding(): boolean {
    return this.grabbed > 0
  }

  /** Gives the keyboard back now if the page has it. */
  private async giveBack(): Promise<void> {
    if (!this.probe.appFocused()) return
    let has = true
    try {
      has = await this.probe.hostHasKeyboard()
    } catch {
      has = true
    }
    if (has) return
    try {
      await this.probe.restoreHost()
      this.fired += 1
      this.probe.note?.('keyboard given back to the chat', {
        after: this.label,
        times: this.fired,
      })
    } catch {
      // Never stop an action over this.
    }
  }

  private async begin(): Promise<void> {
    this.watching = true
    try {
      this.had = this.probe.appFocused() && (await this.probe.hostHasKeyboard())
      if (this.had) await this.probe.saveActive()
    } catch {
      this.had = false
    }
    if (!this.had) {
      this.watching = false
      return
    }
    this.lastEnd = this.now()
    void this.loop()
  }

  private async loop(): Promise<void> {
    try {
      for (;;) {
        await this.sleep(this.tick)
        if (this.depth === 0 && this.now() - this.lastEnd >= this.settle) break
        if (this.holds > 0) continue
        await this.giveBack()
      }
    } finally {
      this.watching = false
      this.had = false
      await this.probe.forgetActive().catch(() => undefined)
    }
  }
}

/** Input commands that may move the keyboard (see the top), plus the two that exist only to bring a page forward. */
export function takesKeyboard(method: string): boolean {
  return /^Input\./.test(method) || method === 'Page.bringToFront' || method === 'Target.activateTarget'
}

export interface GuardableDebugger {
  sendCommand: (method: string, params?: unknown, sessionId?: string) => Promise<unknown>
}

const GUARDED = Symbol.for('agent.focusGuarded')

/**
 * Puts every input command to a page through the guard, once per debugger. The one chokepoint: the browser tools, the
 * Vault's typing and the guide all send through the page's debugger, so none of them can forget it.
 */
export function guardDebugger(dbg: GuardableDebugger, guard: FocusGuard): void {
  const marked = dbg as unknown as Record<symbol, unknown>
  if (marked[GUARDED] === true) return
  marked[GUARDED] = true
  const send = dbg.sendCommand.bind(dbg)
  dbg.sendCommand = (method, params, sessionId) =>
    takesKeyboard(method)
      ? guard.around(() => (sessionId === undefined ? send(method, params) : send(method, params, sessionId)), method)
      : sessionId === undefined
        ? send(method, params)
        : send(method, params, sessionId)
}

/** Runs in the app window's page: has the keyboard, that is, the document has focus. */
export const HOST_HAS_KEYBOARD_JS = `document.hasFocus()`
/** Runs in the app window's page: remember the active element (the chat box he is typing in). */
export const SAVE_ACTIVE_JS = `(() => { const a = document.activeElement; globalThis.__agentKept = a && a !== document.body && a.tagName !== 'WEBVIEW' ? a : null; return true; })()`
/**
 * Runs in the app window's page: put focus back on that element. A text field keeps its caret and selection across a
 * blur and focus, so nothing he typed in between moves.
 */
export const RESTORE_ACTIVE_JS = `(() => { const el = globalThis.__agentKept; if (el && el.isConnected && typeof el.focus === 'function') { if (document.activeElement !== el) el.focus({ preventScroll: true }); return true; } return false; })()`
export const FORGET_ACTIVE_JS = `(() => { globalThis.__agentKept = null; return true; })()`
