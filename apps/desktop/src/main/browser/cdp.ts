/**
 * Trusted input and emulation through the page's own debugger (the Chrome DevTools Protocol).
 *
 * Why not synthetic DOM events: many sites ignore an untrusted `.click()` or a value set from script,
 * and CDP input goes through the browser's real input pipeline, so `event.isTrusted` is true and the
 * click hit-tests across frame boundaries, reaching a cross-origin sign-in button that
 * `webContents.sendInputEvent` cannot (hard sites ignore synthetic events). Coordinates passed here are in
 * page CSS pixels; under device emulation the view is drawn scaled, and CDP input is in view pixels,
 * so every point is multiplied by the current draw scale first.
 *
 * The debugger is attached once per tab and kept: detaching drops every emulation override.
 */

export interface DebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>
}

export interface Point {
  x: number
  y: number
}

interface KeySpec {
  key: string
  code: string
  keyCode: number
  text?: string
}

const KEYS: Record<string, KeySpec> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  home: { key: 'Home', code: 'Home', keyCode: 36 },
  end: { key: 'End', code: 'End', keyCode: 35 },
}

export const KEY_NAMES = Object.values(KEYS).map((spec) => (spec.key === ' ' ? 'Space' : spec.key))

const MODIFIERS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, shift: 8 }

/** "Enter", "ctrl+a", "Shift+Tab", "a". Null when it is not a key this knows. */
export function parseKey(raw: string): { spec: KeySpec; modifiers: number } | null {
  const parts = raw.split('+').map((part) => part.trim()).filter((part) => part !== '')
  if (parts.length === 0) return null
  let modifiers = 0
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIERS[part.toLowerCase()]
    if (bit === undefined) return null
    modifiers |= bit
  }
  const last = parts[parts.length - 1] ?? ''
  const named = KEYS[last.toLowerCase()]
  if (named !== undefined) return { spec: named, modifiers }
  if (last.length === 1) {
    const upper = last.toUpperCase()
    const isLetter = /[A-Z]/.test(upper)
    const isDigit = /[0-9]/.test(last)
    return {
      spec: {
        key: last,
        code: isLetter ? `Key${upper}` : isDigit ? `Digit${last}` : '',
        keyCode: upper.charCodeAt(0),
        ...(modifiers & ~8 ? {} : { text: last }),
      },
      modifiers,
    }
  }
  return null
}

export class Cdp {
  private readonly dbg: DebuggerLike
  private readonly timeoutMs: number
  /**
   * True while the page emulates a touch device. Mouse events then hang in Chromium's touch
   * emulation (measured on Electron 44: Input.dispatchMouseEvent never answers), and a phone site
   * expects taps anyway, so input goes out as touch events instead.
   */
  touch = false
  /**
   * The page is a <webview> guest. Chromium turns touches into a tap (and its click) only in the window's own
   * view, so touches sent here reach the page's touch handlers but never click; mouse events, on the other
   * hand, do not hang for a guest (measured on Electron 44). A tap then also sends the mouse half that follows
   * a real finger tap.
   */
  guest = false

  constructor(dbg: DebuggerLike, timeoutMs = 10_000) {
    this.dbg = dbg
    this.timeoutMs = timeoutMs
  }

  /** False when the debugger cannot be attached (another tool holds it); callers fall back. */
  ensure(): boolean {
    try {
      if (!this.dbg.isAttached()) this.dbg.attach('1.3')
      return true
    } catch {
      return false
    }
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ensure()) throw new Error('the page debugger is not available')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.dbg.sendCommand(method, params),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out`)), this.timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  async click(at: Point, scale: number, options: { clickCount?: number; button?: 'left' | 'right' | 'middle' } = {}): Promise<void> {
    const p = toView(at, scale)
    const button = options.button ?? 'left'
    const clickCount = options.clickCount ?? 1
    if (this.touch && button === 'left') {
      for (let n = 1; n <= clickCount; n++) {
        await this.tap(p)
        if (n < clickCount) await sleep(60)
      }
      return
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
    for (let n = 1; n <= clickCount; n++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, buttons: 1, clickCount: n })
      await sleep(30)
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, buttons: 0, clickCount: n })
    }
  }

  /** One finger down and up at a point already in view pixels. */
  private async tap(p: Point): Promise<void> {
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
    await sleep(40)
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    if (this.guest) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
    }
  }

  async hover(at: Point, scale: number): Promise<void> {
    if (this.touch) return
    const p = toView(at, scale)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
  }

  async hold(at: Point, scale: number, ms: number): Promise<void> {
    const p = toView(at, scale)
    if (this.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
      await sleep(ms)
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(ms)
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  /** Moves along a path with intermediate steps: sliders and drag-to-verify ignore instant jumps. */
  async drag(from: Point, to: Point, scale: number, steps = 16): Promise<void> {
    const a = toView(from, scale)
    const b = toView(to, scale)
    if (this.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: a.x, y: a.y }] })
      for (let i = 1; i <= steps; i++) {
        const t = i / steps
        const ease = t * t * (3 - 2 * t)
        await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + (b.x - a.x) * ease, y: a.y + (b.y - a.y) * ease }] })
        await sleep(16)
      }
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const ease = t * t * (3 - 2 * t)
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: a.x + (b.x - a.x) * ease,
        y: a.y + (b.y - a.y) * ease,
        button: 'left',
        buttons: 1,
      })
      await sleep(16)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async wheel(at: Point, scale: number, deltaY: number): Promise<void> {
    const p = toView(at, scale)
    if (this.touch) {
      // A finger swipe: moving up scrolls the page down.
      await this.send('Input.synthesizeScrollGesture', { x: p.x, y: p.y, yDistance: -deltaY * scale, speed: 1200, gestureSourceType: 'touch' })
      return
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY })
  }

  /** Types as one trusted text insertion: beforeinput and input fire as for a real keyboard. */
  async insertText(text: string): Promise<void> {
    await this.send('Input.insertText', { text })
  }

  async press(raw: string): Promise<boolean> {
    const parsed = parseKey(raw)
    if (parsed === null) return false
    const { spec, modifiers } = parsed
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      nativeVirtualKeyCode: spec.keyCode,
      modifiers,
    }
    await this.send('Input.dispatchKeyEvent', { type: spec.text === undefined ? 'rawKeyDown' : 'keyDown', ...base, ...(spec.text === undefined ? {} : { text: spec.text, unmodifiedText: spec.text }) })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    return true
  }
}

export function toView(at: Point, scale: number): Point {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1
  return { x: Math.round(at.x * s * 100) / 100, y: Math.round(at.y * s * 100) / 100 }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
