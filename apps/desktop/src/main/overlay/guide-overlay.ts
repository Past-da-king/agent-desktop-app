/**
 * The guide overlay (10 Nov 2026): the ring and its label drawn in a window of their own, on top of whatever is on
 * the screen, instead of inside a page. A window can be left out of screen sharing (content protection); something
 * drawn inside a page cannot. So this is what makes a guide PRIVATE: he sees the ring, Teams, Meet and Zoom do not.
 *
 * Generic: it knows nothing about the in-app browser. Anything that can name a rectangle on the screen can ring it
 * (the browser guide translates a page rectangle with browser/guide-geometry.ts; "show me how" rings any window).
 *
 * ---------------------------------------------------------------------------------------------------------------
 * API (everything is in SCREEN coordinates, DIPs, the units Electron's screen and BrowserWindow use)
 *
 *   import { createGuideOverlay } from './overlay/overlay-window'      // Electron: the real windows
 *   const overlay = createGuideOverlay({ privacy })                    // privacy: main/capture-privacy.ts (optional)
 *
 *   overlay.show({ rect, label, step, of, fill?, look, ... })   draw the ring on `rect` with its label
 *   overlay.move(rect, { clip?, labelAt?, scale? })             the thing moved: follow it (cheap, call per frame)
 *   overlay.hide()                                              nothing drawn, windows kept for the next show
 *   overlay.restyle(look)                                       his theme or accent changed
 *   overlay.destroyAll()                                        every window closed; show() makes them again
 *   overlay.state()                                             { shown, displayId, rect, protected, windows }
 *
 *   OverlayShow:
 *     rect: Rect              the thing to ring (unpadded), screen DIPs
 *     label: string           a few words, "Click Create Pixel"
 *     step?, of?: number      the "2/5" chip; left out or of <= 1: no chip
 *     fill?: OverlayFill      clipboard fill wording: the label becomes "Field: value, press Ctrl+V"; a sensitive
 *                             value is never shown ("Field: on your clipboard, press Ctrl+V")
 *     look: BrandLook         shared/brand.ts brandLook({ theme, accent, systemDark }); drawn by guideStyle(look),
 *                             the same CSS the in-page ring uses
 *     displayId?: number      which display (default: the one the rect's centre is on, else the nearest)
 *     clip?: Rect             drawing is confined to this (default: the whole display, or `area`)
 *     labelAt?: { x, y, width? }  where the label goes (default: the overlay picks a free spot beside the ring)
 *     scale?: number          DIPs per drawing pixel (default 1): a ring over a zoomed page keeps its proportions
 *     owner?: object          a BrowserWindow: the overlay stays above THAT window only (moves in z-order, hides and
 *                             minimises with it) and covers only `area`. Without it: above every window, one
 *                             click-through window per display, at the screen-saver level.
 *     area?: Rect             with an owner: the part of the screen the overlay window covers (default: clip)
 *     onAct?: (outcome: 'done' | 'skipped') => void    he pressed I did it or Skip on the label
 *
 * The window is transparent, frameless, never focusable, never in the taskbar, and lets every click through except
 * on the label's two buttons. Whether it is hidden from capture follows the setting hideGuidesFromCapture, live, and
 * only where the system can really do it (shared/capture-privacy.ts): `state().protected` says what is true now.
 * ---------------------------------------------------------------------------------------------------------------
 *
 * This file is the logic, free of Electron (overlay-window.ts makes the windows), so its whole life cycle is tested.
 */
import type { BrandLook } from '../../shared/brand'
import { fillLabel } from '../browser/guide'
import type { OverlayPageState } from './overlay-page'
import { coverRect, intersect, isEmpty, localRect, sameRect, type Rect } from './rect'

export type { Rect } from './rect'

export interface OverlayFill {
  /** The field's name, as he reads it. */
  field: string
  value?: string
  sensitive?: boolean
  /** What his paste key is called here. Default Ctrl+V. */
  pasteKey?: string
}

export interface OverlayPlace {
  clip?: Rect
  labelAt?: { x: number; y: number; width?: number } | null
  scale?: number
  area?: Rect
}

export interface OverlayShow extends OverlayPlace {
  rect: Rect
  label: string
  step?: number
  of?: number
  fill?: OverlayFill
  look: BrandLook
  displayId?: number
  owner?: object
  onAct?: (outcome: 'done' | 'skipped') => void
}

export type OverlayEvent = { type: 'ready' } | { type: 'hover'; on: boolean } | { type: 'act'; outcome: 'done' | 'skipped' }

/** One overlay window, as the logic sees it. */
export interface OverlaySurface {
  /** Places the window (screen DIPs) and answers where its content area really is now. */
  setBounds(bounds: Rect): Rect
  show(): void
  hide(): void
  destroy(): void
  /** Draws this (window coordinates); null draws nothing. */
  push(state: OverlayPageState | null): void
  restyle(look: BrandLook): void
  /** true: the window takes clicks (the pointer is on a button). false: every click passes through. */
  setClickable(on: boolean): void
  onEvent(listener: (event: OverlayEvent) => void): void
  /** Is this window hidden from screen capture right now? */
  isProtected(): boolean
  isDestroyed(): boolean
}

export interface OverlayDisplay {
  id: number
  bounds: Rect
  scaleFactor: number
}

/** What makes the windows (overlay-window.ts in the app; a fake in tests). */
export interface OverlayHost {
  displays(): OverlayDisplay[]
  createSurface(options: { look: BrandLook; owner?: object }): OverlaySurface
}

export interface OverlayState {
  shown: boolean
  displayId: number | null
  /** The ring's target on the screen, when shown. */
  rect: Rect | null
  /** True when every overlay window is hidden from capture (false when there is none). */
  protected: boolean
  windows: number
}

interface Entry {
  surface: OverlaySurface
  owner: object | undefined
  /** The look it is drawn in now, as text, so a different one on the next show restyles it. */
  look: string
  asked: Rect | null
  /** Where the window's content area really is. */
  actual: Rect
  visible: boolean
}

/** "2/5", or '' when there is one step. */
export function stepChip(step: number | undefined, of: number | undefined): string {
  return of !== undefined && of > 1 && step !== undefined ? `${step}/${of}` : ''
}

/** The label as drawn: the plain one, or the clipboard-fill wording (a sensitive value is never in it). */
export function overlayLabel(show: Pick<OverlayShow, 'label' | 'fill'>): string {
  const fill = show.fill
  if (fill === undefined) return show.label
  return fillLabel({ target: { name: fill.field }, label: show.label, value: fill.value ?? '', ...(fill.sensitive === true ? { sensitive: true } : {}) }, fill.pasteKey ?? 'Ctrl+V')
}

/** The display a rectangle is on: the one holding its centre, else the nearest. Null with no display at all. */
export function displayFor(rect: Rect, displays: OverlayDisplay[]): OverlayDisplay | null {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  let best: OverlayDisplay | null = null
  let bestFar = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const b = display.bounds
    const dx = Math.max(b.x - cx, 0, cx - (b.x + b.width))
    const dy = Math.max(b.y - cy, 0, cy - (b.y + b.height))
    const far = Math.hypot(dx, dy)
    if (far < bestFar) {
      best = display
      bestFar = far
    }
  }
  return best
}

export class GuideOverlay {
  private readonly entries = new Map<string, Entry>()
  private spec: OverlayShow | null = null
  private shownOn: string | null = null
  private shownDisplay: number | null = null

  constructor(private readonly host: OverlayHost) {}

  show(spec: OverlayShow): void {
    this.spec = { ...spec }
    this.render()
  }

  /** The target moved (a scroll, a resize, the window dragged). Does nothing when nothing is shown. */
  move(rect: Rect, place: OverlayPlace = {}): void {
    if (this.spec === null) return
    this.spec = { ...this.spec, rect, ...place }
    this.render()
  }

  hide(): void {
    this.spec = null
    this.render()
  }

  restyle(look: BrandLook): void {
    if (this.spec !== null) this.spec = { ...this.spec, look }
    for (const entry of this.entries.values()) {
      if (entry.surface.isDestroyed()) continue
      entry.look = JSON.stringify(look)
      entry.surface.restyle(look)
    }
  }

  destroyAll(): void {
    this.spec = null
    this.shownOn = null
    this.shownDisplay = null
    for (const entry of this.entries.values()) {
      try {
        if (!entry.surface.isDestroyed()) entry.surface.destroy()
      } catch {
        // Already gone with its owner.
      }
    }
    this.entries.clear()
  }

  state(): OverlayState {
    const live = [...this.entries.values()].filter((entry) => !entry.surface.isDestroyed())
    return {
      shown: this.shownOn !== null,
      displayId: this.shownOn === null ? null : this.shownDisplay,
      rect: this.shownOn === null || this.spec === null ? null : { ...this.spec.rect },
      protected: live.length > 0 && live.every((entry) => entry.surface.isProtected()),
      windows: live.length,
    }
  }

  private render(): void {
    const spec = this.spec
    const display = spec === null ? null : spec.displayId !== undefined ? (this.host.displays().find((d) => d.id === spec.displayId) ?? null) : displayFor(spec.rect, this.host.displays())
    let key: string | null = null
    if (spec !== null && display !== null) {
      // With an owner the window covers only the area it was given; alone it covers its display.
      const area = spec.owner !== undefined ? (spec.area ?? spec.clip ?? display.bounds) : display.bounds
      const clip = intersect(spec.clip ?? area, area)
      if (!isEmpty(clip) && !isEmpty(intersect(clip, spec.rect))) {
        key = spec.owner !== undefined ? 'owner' : `display:${display.id}`
        const entry = this.entry(key, spec)
        const want = coverRect(area)
        if (!sameRect(entry.asked, want)) {
          entry.actual = entry.surface.setBounds(want)
          entry.asked = want
        }
        const look = JSON.stringify(spec.look)
        if (entry.look !== look) {
          entry.look = look
          entry.surface.restyle(spec.look)
        }
        const origin = { x: entry.actual.x, y: entry.actual.y }
        const tag = spec.labelAt === undefined || spec.labelAt === null ? null : { x: spec.labelAt.x - origin.x, y: spec.labelAt.y - origin.y, ...(spec.labelAt.width === undefined ? {} : { width: spec.labelAt.width }) }
        entry.surface.push({ clip: localRect(clip, origin), ring: localRect(spec.rect, origin), k: spec.scale !== undefined && spec.scale > 0 ? spec.scale : 1, tag, n: stepChip(spec.step, spec.of), label: overlayLabel(spec) })
        if (!entry.visible) {
          entry.visible = true
          entry.surface.show()
        }
        this.shownDisplay = display.id
      }
    }
    // Every other window (another display, or all of them when nothing is to be drawn) shows nothing and takes no click.
    for (const [name, entry] of this.entries) {
      if (name === key) continue
      if (entry.surface.isDestroyed()) {
        this.entries.delete(name)
        continue
      }
      if (!entry.visible) continue
      entry.visible = false
      entry.surface.push(null)
      entry.surface.setClickable(false)
      entry.surface.hide()
    }
    this.shownOn = key
  }

  private entry(key: string, spec: OverlayShow): Entry {
    const known = this.entries.get(key)
    if (known !== undefined && !known.surface.isDestroyed() && known.owner === spec.owner) return known
    if (known !== undefined) {
      try {
        if (!known.surface.isDestroyed()) known.surface.destroy()
      } catch {
        // Gone with its owner.
      }
    }
    const surface = this.host.createSurface({ look: spec.look, ...(spec.owner === undefined ? {} : { owner: spec.owner }) })
    const entry: Entry = { surface, owner: spec.owner, look: JSON.stringify(spec.look), asked: null, actual: { x: 0, y: 0, width: 0, height: 0 }, visible: false }
    surface.onEvent((event) => {
      if (this.entries.get(key) !== entry) return
      if (event.type === 'hover') {
        // Only while it shows a ring: a window with nothing on it never holds the mouse.
        surface.setClickable(event.on && entry.visible)
      } else if (event.type === 'act') {
        if (entry.visible) this.spec?.onAct?.(event.outcome)
      }
    })
    this.entries.set(key, entry)
    return entry
  }
}
