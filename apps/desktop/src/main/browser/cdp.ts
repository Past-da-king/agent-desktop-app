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
 *
 * Frames in other processes. Chromium puts a cross-origin iframe in its own process (an out-of-process iframe, OOPIF).
 * In an ordinary tab a mouse event sent to the page is routed into the frame under the pointer. In a <webview> guest
 * it is not (measured on Electron 44.9: a click on a button two cross-origin iframes deep focused the outer iframe
 * element and never reached the button, whatever the coordinates or the view size), so editors that live in nested
 * cross-origin frames (Office for the web, Google Docs and Slides, canvases) ignored every click. Keys and
 * Input.insertText follow the focused frame and do arrive. So for a guest a mouse gesture is routed here: the frame
 * under the point is found by hit-testing down through the frames (DOM.getNodeForLocation, which sees the iframe
 * element and its box in each frame's own viewport), the debugger attaches to that frame's own target
 * (Target.setAutoAttach, flat sessions) and the same events are sent on that session with frame-local
 * coordinates. They are as trusted as any other (isTrusted, pointerType mouse) and nothing is injected into the frame.
 */

export interface DebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  /** `sessionId` addresses a child target (a frame in another process) attached with Target.attachToTarget flatten. */
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  /** Protocol events, for the frames' sessions: (event, method, params, sessionId of the session it came on). */
  on?(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>, sessionId?: string) => void): unknown
}

/** Where a mouse gesture goes: the page itself, or the frame's own session with the point in that frame's viewport. */
export interface Route {
  /** Absent: the page's own session. */
  sessionId?: string
  /** The frame's top left corner in view pixels (page viewport pixels when there is no session). */
  originX: number
  originY: number
  /** The gesture's first point, to find the frame again if its session went away. */
  from: Point
  scale: number
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
  /** Route mouse gestures into frames in other processes (a guest only). Off only to compare against the old behaviour. */
  frames = true
  /** Frames in other processes the debugger is attached to (Target.setAutoAttach, flat sessions), by frame id. */
  private readonly frameSessions = new Map<string, { sessionId: string; parent: string }>()
  /** Sessions that already auto-attach to their own child frames ('' is the page). */
  private readonly watching = new Set<string>()
  private listening = false
  /** Where a mouse gesture went when it went into another frame, or why it could not (the app's log). */
  trace: ((line: string) => void) | undefined = undefined

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

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.ensure()) throw new Error('the page debugger is not available')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        sessionId === undefined ? this.dbg.sendCommand(method, params) : this.dbg.sendCommand(method, params, sessionId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${method} timed out`)), this.timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * The frame under a point (view pixels), found by hit-testing down through iframe elements. Only for a guest page
   * and a mouse; anything that goes wrong answers the page itself, which is what always happened before.
   */
  async route(p: Point, scale: number): Promise<Route> {
    const page: Route = { originX: 0, originY: 0, from: p, scale }
    if (!this.guest || !this.frames || this.touch || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return page
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1
    let route = page
    let at = 'start'
    let session: string | undefined
    // Frame-local point in CSS pixels, as DOM.* wants it.
    let lx = p.x / s
    let ly = p.y / s
    try {
      for (let depth = 0; depth < MAX_FRAME_DEPTH; depth++) {
        at = `hit ${depth}`
        const hit = objectOf(
          await this.send('DOM.getNodeForLocation', { x: Math.round(lx), y: Math.round(ly), ignorePointerEventsNone: true }, session),
        )
        const backendNodeId = hit['backendNodeId']
        if (typeof backendNodeId !== 'number') break
        at = `describe ${depth}`
        const node = objectOf(objectOf(await this.send('DOM.describeNode', { backendNodeId }, session))['node'])
        const frameId = node['frameId']
        if (!/^i?frame$/i.test(String(node['nodeName'] ?? '')) || typeof frameId !== 'string' || node['contentDocument'] !== undefined) break
        at = `box ${depth}`
        const box = objectOf(objectOf(await this.send('DOM.getBoxModel', { backendNodeId }, session))['model'])['content']
        if (!Array.isArray(box) || box.length < 2 || typeof box[0] !== 'number' || typeof box[1] !== 'number') break
        at = `attach ${depth}`
        const child = await this.frameSession(frameId, session)
        if (child === null) break
        lx -= box[0]
        ly -= box[1]
        session = child
        route = { sessionId: child, originX: p.x - lx * s, originY: p.y - ly * s, from: p, scale }
      }
    } catch (error) {
      this.trace?.(`frame routing stopped at ${at} (${Math.round(lx)},${Math.round(ly)} of ${Math.round(p.x)},${Math.round(p.y)} scale ${s}): ${error instanceof Error ? error.message : String(error)}`)
      return route
    }
    if (route.sessionId !== undefined) this.trace?.(`mouse routed into a frame in another process at ${Math.round(p.x)},${Math.round(p.y)}`)
    return route
  }

  /**
   * The session of a frame in another process. Chromium lets a page's own debugger find its child frames only through
   * auto-attach (Target.attachToTarget is refused for it): ask the parent to attach to its children, take each one as
   * its event arrives (and ask it for its own children, for frames nested deeper), and wait a moment for this one.
   */
  private async frameSession(frameId: string, parent: string | undefined): Promise<string | null> {
    this.listen()
    const from = parent ?? ''
    const found = (): string | null => {
      const known = this.frameSessions.get(frameId)
      return known !== undefined && known.parent === from ? known.sessionId : null
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt === 1) this.watching.delete(from)
        await this.autoAttach(parent)
        const until = Date.now() + 500
        let id = found()
        while (id === null && Date.now() < until) {
          await sleep(20)
          id = found()
        }
        if (id !== null) return id
      }
    } catch (error) {
      this.trace?.(`frame session failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return null
  }

  private async autoAttach(session: string | undefined): Promise<void> {
    const key = session ?? ''
    if (this.watching.has(key)) return
    this.watching.add(key)
    try {
      await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session)
    } catch (error) {
      this.watching.delete(key)
      throw error
    }
  }

  /** Remembers the frames the debugger attaches to, and attaches to theirs in turn. */
  private listen(): void {
    if (this.listening || this.dbg.on === undefined) return
    this.listening = true
    this.dbg.on('message', (_event, method, params, sessionId) => {
      if (method === 'Target.attachedToTarget') {
        const info = objectOf(params['targetInfo'])
        const child = params['sessionId']
        const id = info['targetId']
        if (typeof child !== 'string' || typeof id !== 'string' || info['type'] !== 'iframe') return
        this.frameSessions.set(id, { sessionId: child, parent: sessionId ?? '' })
        void this.autoAttach(child).catch(() => undefined)
      } else if (method === 'Target.detachedFromTarget') {
        const gone = params['sessionId']
        for (const [id, entry] of this.frameSessions) {
          if (entry.sessionId !== gone) continue
          this.frameSessions.delete(id)
          this.watching.delete(entry.sessionId)
        }
      }
    })
  }

  /** One mouse event on the route's session, with the point made frame-local. A session that went away is dropped and the frame found again. */
  private async mouse(route: Route, params: Record<string, unknown>, again = true): Promise<void> {
    if (route.sessionId === undefined) {
      await this.send('Input.dispatchMouseEvent', params)
      return
    }
    const local = { ...params, x: round2(Number(params['x']) - route.originX), y: round2(Number(params['y']) - route.originY) }
    try {
      await this.send('Input.dispatchMouseEvent', local, route.sessionId)
    } catch (error) {
      if (!again) throw error
      // The frame's session went away (it navigated or closed): attach afresh once, and send there.
      this.frameSessions.clear()
      this.watching.clear()
      Object.assign(route, await this.route(route.from, route.scale))
      await this.mouse(route, params, false)
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
    const route = await this.route(p, scale)
    await this.mouse(route, { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
    for (let n = 1; n <= clickCount; n++) {
      await this.mouse(route, { type: 'mousePressed', x: p.x, y: p.y, button, buttons: 1, clickCount: n })
      await sleep(12)
      await this.mouse(route, { type: 'mouseReleased', x: p.x, y: p.y, button, buttons: 0, clickCount: n })
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
    const route = await this.route(p, scale)
    await this.mouse(route, { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
  }

  async hold(at: Point, scale: number, ms: number): Promise<void> {
    const p = toView(at, scale)
    if (this.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: p.x, y: p.y }] })
      await sleep(ms)
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      return
    }
    const route = await this.route(p, scale)
    await this.mouse(route, { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
    await this.mouse(route, { type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(ms)
    await this.mouse(route, { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1 })
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
    const route = await this.route(a, scale)
    await this.mouse(route, { type: 'mouseMoved', x: a.x, y: a.y, buttons: 0 })
    await this.mouse(route, { type: 'mousePressed', x: a.x, y: a.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const ease = t * t * (3 - 2 * t)
      await this.mouse(route, {
        type: 'mouseMoved',
        x: a.x + (b.x - a.x) * ease,
        y: a.y + (b.y - a.y) * ease,
        button: 'left',
        buttons: 1,
      })
      await sleep(16)
    }
    await this.mouse(route, { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async wheel(at: Point, scale: number, deltaY: number): Promise<void> {
    const p = toView(at, scale)
    if (this.touch) {
      // A finger swipe: moving up scrolls the page down.
      await this.send('Input.synthesizeScrollGesture', { x: p.x, y: p.y, yDistance: -deltaY * scale, speed: 1200, gestureSourceType: 'touch' })
      return
    }
    const route = await this.route(p, scale)
    await this.mouse(route, { type: 'mouseWheel', x: p.x, y: p.y, deltaX: 0, deltaY })
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

/** Frames nested this deep are followed; more is a page that is not a document editor. */
const MAX_FRAME_DEPTH = 8

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}
