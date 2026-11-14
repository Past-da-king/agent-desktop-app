/**
 * The agent cursor (11 Nov 2026): a second, branded cursor that shows where the AGENT is acting, drawn in a window
 * of its own so the agent never has to touch his pointer. Ayanda, 11 Nov: "When I'm typing and the agent is also using
 * the cursor it's confusing, only one of us can work at a time." His pointer, keyboard and focus stay his; this is a
 * drawing, never an input device: the window is click-through and never focusable (agent-cursor-window.ts).
 *
 * ---------------------------------------------------------------------------------------------------------------
 * API (SCREEN coordinates, DIPs: the units Electron's screen and BrowserWindow use)
 *
 *   import { createAgentCursors } from './overlay/agent-cursor-window'   // Electron: the real windows
 *   const cursors = createAgentCursors({ privacy, look, enabled })       // once, in main
 *
 *   cursors.show(id, { label, at?|locate?, who?, owner?, area? })  the cursor of agent `id` appears (and moves there)
 *   cursors.moveTo(id, at | locate, { label? })                    glide to a point; `locate` is called again about 5
 *                                                                  times a second so the cursor follows a window that
 *                                                                  moves, hides while it is minimised or covered
 *   cursors.click(id)                                              a pulse where it is: the agent clicked
 *   cursors.label(id, 'Typing the invoice number')                 the small label beside it
 *   cursors.hide(id)                                               that agent's run ended: its cursor is gone
 *   cursors.hideAll() / cursors.restyle() / cursors.refresh()      end of everything / theme / setting changed
 *   cursors.state()                                                what is drawn now (tests, proofs)
 *
 *   id        one cursor per running agent (browserOwner / ctx.owner); each has its own label. With more than one
 *             on screen the label also names its agent (`who`).
 *   locate    () => { at, visible, area? } | null   where the agent acts now, screen DIPs. visible false (the window
 *             is minimised, covered or off screen) or null hides the cursor until it is true again.
 *   owner     a BrowserWindow: the cursor window is its child (above it only, hides and minimises with it) and
 *             covers `area` only. Without it: always on top at the screen-saver level, one window per display.
 *   area      with an owner: the part of the screen the cursor may be drawn in (the browser's page area).
 *
 * A cursor that nobody moves for IDLE_HIDE_MS goes by itself (a run that crashed leaves nothing behind). The setting
 * `agentCursor` (default on) switches every call into a no-op; screen-share privacy follows hideGuidesFromCapture
 * (the windows are registered with capture-privacy.ts as 'guide').
 * ---------------------------------------------------------------------------------------------------------------
 *
 * This file is the logic, free of Electron, so its whole life cycle is tested (test/agent-cursor.test.ts).
 */
import type { BrandLook } from '../../shared/brand'
import { intersect, isEmpty, type Rect } from './rect'

export interface Point {
  x: number
  y: number
}

export interface Located {
  at: Point
  visible: boolean
  area?: Rect
}

export type Locator = () => Located | null | Promise<Located | null>

export interface CursorSpot {
  id: string
  /** Window coordinates. */
  x: number
  y: number
  label: string
  /** Counts up with every click: the page plays one pulse per new number. */
  pulse: number
  /** True while the cursor is the only one: the label then does not need the agent's name. */
  who: string
}

export interface CursorPageState {
  /** Where drawing is allowed, window coordinates. */
  clip: Rect
  cursors: CursorSpot[]
}

/** One window as the logic sees it. */
export interface CursorSurface {
  setBounds(bounds: Rect): Rect
  show(): void
  hide(): void
  destroy(): void
  push(state: CursorPageState | null): void
  restyle(look: BrandLook): void
  isProtected(): boolean
  isDestroyed(): boolean
}

export interface CursorDisplay {
  id: number
  bounds: Rect
}

export interface CursorHost {
  displays(): CursorDisplay[]
  createSurface(options: { look: BrandLook; owner?: object }): CursorSurface
}

export interface CursorOptions {
  /** The setting `agentCursor`, read live. */
  enabled: () => boolean
  look: () => BrandLook
  now?: () => number
  /** false: nothing is polled by itself; the test calls tick(). */
  timers?: boolean
}

export interface CursorShow {
  at?: Point
  locate?: Locator
  label?: string
  /** The agent's short name, shown when several cursors are on screen. */
  who?: string
  owner?: object
  area?: Rect
}

/** A cursor nobody moved or labelled for this long goes by itself. */
export const IDLE_HIDE_MS = 20_000
/** How often `locate` is read again. */
export const FOLLOW_MS = 200

interface Cursor {
  id: string
  who: string
  label: string
  at: Point | null
  locate: Locator | null
  owner: object | undefined
  area: Rect | undefined
  visible: boolean
  pulse: number
  touched: number
  /** Which window layer it is drawn in now. */
  layer: string | null
  polling: boolean
}

interface Layer {
  surface: CursorSurface
  look: string
  bounds: Rect
  actual: Rect
  shown: boolean
  owner: object | undefined
}

export function displayOf(point: Point, displays: CursorDisplay[]): CursorDisplay | null {
  let best: CursorDisplay | null = null
  let bestFar = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const b = display.bounds
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width))
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height))
    const far = Math.hypot(dx, dy)
    if (far < bestFar) {
      best = display
      bestFar = far
    }
  }
  return best
}

export class AgentCursors {
  private readonly cursors = new Map<string, Cursor>()
  private readonly layers = new Map<string, Layer>()
  private readonly ownerKeys = new WeakMap<object, number>()
  private ownerCount = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(
    private readonly host: CursorHost,
    private readonly options: CursorOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  /** Resolves when the cursor has been placed (a locator read once): the caller can wait for the glide. */
  show(id: string, spec: CursorShow = {}): Promise<void> {
    if (!this.options.enabled()) return Promise.resolve()
    const cursor = this.cursorFor(id)
    if (spec.who !== undefined) cursor.who = spec.who
    if (spec.owner !== undefined) cursor.owner = spec.owner
    if (spec.area !== undefined) cursor.area = spec.area
    if (spec.label !== undefined) cursor.label = spec.label
    this.aim(cursor, spec)
    this.touch(cursor)
    return this.settle(cursor)
  }

  moveTo(id: string, to: Point | Locator, options: { label?: string } = {}): Promise<void> {
    return this.show(id, { ...(typeof to === 'function' ? { locate: to } : { at: to }), ...(options.label === undefined ? {} : { label: options.label }) })
  }

  label(id: string, text: string): void {
    if (!this.options.enabled()) return
    const cursor = this.cursors.get(id)
    if (cursor === undefined) return
    cursor.label = text
    this.touch(cursor)
    this.render()
  }

  click(id: string): void {
    if (!this.options.enabled()) return
    const cursor = this.cursors.get(id)
    if (cursor === undefined) return
    cursor.pulse += 1
    this.touch(cursor)
    this.render()
  }

  hide(id: string): void {
    if (this.cursors.delete(id)) this.render()
    if (this.cursors.size === 0) this.stopTimer()
  }

  hideAll(): void {
    this.cursors.clear()
    this.stopTimer()
    this.render()
  }

  /** His theme or accent changed. */
  restyle(): void {
    const look = this.options.look()
    for (const layer of this.layers.values()) {
      if (layer.surface.isDestroyed()) continue
      layer.look = JSON.stringify(look)
      layer.surface.restyle(look)
    }
  }

  /** The setting changed: switched off, everything goes and the windows are closed. */
  refresh(): void {
    if (!this.options.enabled()) {
      this.cursors.clear()
      this.stopTimer()
      this.destroyAll()
    }
  }

  destroyAll(): void {
    this.cursors.clear()
    this.stopTimer()
    for (const layer of this.layers.values()) {
      try {
        if (!layer.surface.isDestroyed()) layer.surface.destroy()
      } catch {
        // Gone with its owner.
      }
    }
    this.layers.clear()
  }

  state(): { cursors: Array<{ id: string; at: Point | null; label: string; visible: boolean; pulse: number; layer: string | null }>; windows: number; protected: boolean } {
    const live = [...this.layers.values()].filter((layer) => !layer.surface.isDestroyed())
    return {
      cursors: [...this.cursors.values()].map((c) => ({ id: c.id, at: c.at === null ? null : { ...c.at }, label: c.label, visible: c.visible, pulse: c.pulse, layer: c.layer })),
      windows: live.length,
      protected: live.length > 0 && live.every((layer) => layer.surface.isProtected()),
    }
  }

  /** Reads every locator again and lets idle cursors go. Called by the timer; tests call it directly. */
  async tick(): Promise<void> {
    const now = this.now()
    for (const cursor of [...this.cursors.values()]) {
      if (now - cursor.touched > IDLE_HIDE_MS) {
        this.cursors.delete(cursor.id)
        continue
      }
      if (cursor.locate !== null) await this.settle(cursor, false)
    }
    if (this.cursors.size === 0) this.stopTimer()
    this.render()
  }

  // ---- inside ------------------------------------------------------------------------------------------------

  private cursorFor(id: string): Cursor {
    let cursor = this.cursors.get(id)
    if (cursor === undefined) {
      cursor = { id, who: '', label: '', at: null, locate: null, owner: undefined, area: undefined, visible: false, pulse: 0, touched: this.now(), layer: null, polling: false }
      this.cursors.set(id, cursor)
      this.startTimer()
    }
    return cursor
  }

  private aim(cursor: Cursor, spec: CursorShow): void {
    if (spec.locate !== undefined) {
      cursor.locate = spec.locate
    } else if (spec.at !== undefined) {
      cursor.locate = null
      cursor.at = { ...spec.at }
      cursor.visible = true
    }
  }

  private touch(cursor: Cursor): void {
    cursor.touched = this.now()
  }

  private async settle(cursor: Cursor, draw = true): Promise<void> {
    if (cursor.locate !== null && !cursor.polling) {
      cursor.polling = true
      try {
        const found = await cursor.locate()
        if (found === null) {
          cursor.visible = false
        } else {
          cursor.at = { ...found.at }
          cursor.visible = found.visible
          if (found.area !== undefined) cursor.area = found.area
        }
      } catch {
        cursor.visible = false
      } finally {
        cursor.polling = false
      }
    }
    if (draw) this.render()
  }

  private startTimer(): void {
    if (this.timer !== null || this.options.timers === false) return
    this.timer = setInterval(() => void this.tick().catch(() => undefined), FOLLOW_MS)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  private ownerKey(owner: object | undefined): string {
    if (owner === undefined) return 'free'
    let key = this.ownerKeys.get(owner)
    if (key === undefined) {
      key = ++this.ownerCount
      this.ownerKeys.set(owner, key)
    }
    return `win${key}`
  }

  /** Puts every visible cursor in the right window and draws it; windows nobody uses any more are hidden. */
  private render(): void {
    if (!this.options.enabled()) return
    const displays = this.host.displays()
    const byLayer = new Map<string, { layer: Layer; area: Rect; cursors: Cursor[] }>()
    const wanted = [...this.cursors.values()].filter((c) => c.visible && c.at !== null)
    const named = this.cursors.size > 1
    for (const cursor of wanted) {
      const at = cursor.at as Point
      const display = displayOf(at, displays)
      if (display === null) continue
      const area = cursor.owner !== undefined && cursor.area !== undefined ? intersect(cursor.area, display.bounds) : display.bounds
      if (isEmpty(area)) {
        cursor.layer = null
        continue
      }
      const key = cursor.owner === undefined ? `free:${display.id}` : `${this.ownerKey(cursor.owner)}:${display.id}`
      let entry = byLayer.get(key)
      if (entry === undefined) {
        const layer = this.layerFor(key, cursor.owner, area)
        if (layer === null) continue
        entry = { layer, area, cursors: [] }
        byLayer.set(key, entry)
      }
      cursor.layer = key
      entry.cursors.push(cursor)
    }
    for (const cursor of this.cursors.values()) if (!wanted.includes(cursor)) cursor.layer = null
    for (const [key, layer] of this.layers) {
      if (layer.surface.isDestroyed()) {
        this.layers.delete(key)
        continue
      }
      const entry = byLayer.get(key)
      if (entry === undefined) {
        if (layer.shown) {
          layer.surface.push(null)
          layer.surface.hide()
          layer.shown = false
        }
        continue
      }
      const look = this.options.look()
      const lookText = JSON.stringify(look)
      if (layer.look !== lookText) {
        layer.look = lookText
        layer.surface.restyle(look)
      }
      this.place(layer, entry.area)
      const spots: CursorSpot[] = entry.cursors.map((c) => ({
        id: c.id,
        x: (c.at as Point).x - layer.actual.x,
        y: (c.at as Point).y - layer.actual.y,
        label: c.label,
        pulse: c.pulse,
        who: named ? c.who : '',
      }))
      layer.surface.push({ clip: { x: 0, y: 0, width: layer.actual.width, height: layer.actual.height }, cursors: spots })
      if (!layer.shown) {
        layer.surface.show()
        layer.shown = true
      }
    }
  }

  private layerFor(key: string, owner: object | undefined, area: Rect): Layer | null {
    const existing = this.layers.get(key)
    if (existing !== undefined && !existing.surface.isDestroyed()) return existing
    const look = this.options.look()
    let surface: CursorSurface
    try {
      surface = this.host.createSurface({ look, ...(owner === undefined ? {} : { owner }) })
    } catch {
      return null
    }
    const layer: Layer = { surface, look: JSON.stringify(look), bounds: area, actual: area, shown: false, owner }
    this.layers.set(key, layer)
    return layer
  }

  private place(layer: Layer, area: Rect): void {
    const same = layer.bounds.x === area.x && layer.bounds.y === area.y && layer.bounds.width === area.width && layer.bounds.height === area.height
    if (same && layer.shown) return
    layer.bounds = area
    layer.actual = layer.surface.setBounds(area)
  }
}
