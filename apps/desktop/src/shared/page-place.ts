/**
 * Where the agent's page sits inside the box that shows it (the panel card or the full-size view), worked
 * out in the renderer in the same frame as the box itself, so the page never trails its card.
 *
 * The page is a <webview> laid out at its own size (1440 wide for a desktop page, 390x844 for a phone) and
 * drawn scaled down with a CSS transform, centred in the box. This is the same maths as the main process's
 * shapedView + fitView (main/browser/emulation.ts); test/browser-embed.test.ts holds the two together.
 * Pure: no DOM, no Electron.
 */

export type PageMode = 'desktop' | 'tablet' | 'phone' | 'fit'

export interface PageSpec {
  mode: PageMode
  /** The size the page lays out at, in CSS pixels. Ignored for `fit`. */
  width: number
  height: number
  /** Page zoom; 1 is normal. */
  zoom?: number
  /** True when the agent asked for an exact size: a desktop page then keeps it instead of taking the box's shape. */
  fixed?: boolean
}

export interface Placement {
  /** Offset of the page inside the box, in box pixels. */
  left: number
  top: number
  /** The page's own layout size (the <webview> element before scaling). */
  width: number
  height: number
  /** Layout pixels to box pixels; never above 1. */
  scale: number
}

const DESKTOP_WIDTH = 1440
const DESKTOP_MIN_WIDTH = 1280
const MIN_SIDE = 200
const MAX_SIDE = 4000

function clampSide(value: number): number {
  if (!Number.isFinite(value)) return DESKTOP_WIDTH
  return Math.round(Math.min(MAX_SIDE, Math.max(MIN_SIDE, value)))
}

/** The page's layout size in a box: a plain desktop page takes the box's shape (see emulation.ts shapedView). */
export function pageSize(box: { width: number; height: number }, spec: PageSpec): { width: number; height: number } {
  if (spec.mode === 'fit') return { width: Math.max(0, Math.round(box.width)), height: Math.max(0, Math.round(box.height)) }
  if (spec.mode !== 'desktop' || box.width <= 0 || box.height <= 0) return { width: spec.width, height: spec.height }
  const zoom = spec.zoom !== undefined && spec.zoom > 0 ? spec.zoom : 1
  const least = spec.fixed === true ? spec.width : Math.max(DESKTOP_WIDTH, DESKTOP_MIN_WIDTH)
  const width = box.width / zoom >= least ? Math.round(box.width / zoom) : least
  const height = Math.round((width * box.height) / box.width)
  return { width: clampSide(width), height: clampSide(height) }
}

/** The page's place in the box: its layout size, the scale it is drawn at, and its offset. Null for an empty box. */
export function placePage(box: { width: number; height: number }, spec: PageSpec): Placement | null {
  if (!(box.width > 0) || !(box.height > 0)) return null
  const size = pageSize(box, spec)
  if (spec.mode === 'fit' || size.width <= 0 || size.height <= 0) {
    return { left: 0, top: 0, width: Math.round(box.width), height: Math.round(box.height), scale: 1 }
  }
  const scale = Math.min(1, box.width / size.width, box.height / size.height)
  const shownWidth = Math.max(1, Math.round(size.width * scale))
  const shownHeight = Math.max(1, Math.round(size.height * scale))
  return {
    left: Math.floor((box.width - shownWidth) / 2),
    top: Math.floor((box.height - shownHeight) / 2),
    width: size.width,
    height: size.height,
    scale,
  }
}
