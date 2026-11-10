/**
 * Where the guide's ring is on the SCREEN (10 Nov 2026). The page script reports the target's rectangle in its own
 * frame's viewport; the overlay that draws the ring (main/overlay/guide-overlay.ts) works in screen coordinates. This
 * is the maths between the two, pure, so every case is a test: the browser view's place inside the app window, the
 * window's place on the screen (a second monitor has negative coordinates), page zoom and a page drawn scaled down, a
 * target inside an iframe, and the clipping that keeps the ring inside the page's visible area.
 *
 * Units: Electron places windows in DIPs (device independent pixels) on every screen scale, so everything here is in
 * DIPs and the screen's scale factor only matters where real pixels are named (overlay/rect.ts toPhysical, for a
 * capture check). The page's CSS pixels become DIPs by ONE measured number, `k`: the view's width on screen divided
 * by the width the top page says it has. Page zoom, device emulation and the card's CSS scale are all inside it, so
 * none of them is modelled (or got wrong) separately.
 */
import { intersect, isEmpty, type Rect } from '../overlay/rect'

export interface GuideGeometryInput {
  /** The target in its own frame's viewport, page CSS px (getBoundingClientRect). */
  target: Rect
  /** That frame's viewport inside the TOP page's viewport, page CSS px. The top page itself: 0, 0, its own size. */
  frame: Rect
  /** The top page's viewport width in its own CSS px (innerWidth). */
  pageWidth: number
  /** The browser view (the <webview>) in the app window's own CSS px, as drawn (after any CSS scale). */
  view: Rect
  /** The part of the view that is really visible (clipped by the card, the panel's scroll area, the window). */
  viewClip: Rect
  /** The app window's own zoom factor (its CSS px to DIPs). */
  windowZoom: number
  /** The app window's content area on the screen, DIPs (BrowserWindow.getContentBounds). */
  content: { x: number; y: number }
}

export interface GuideGeometry {
  /** Page CSS px to DIPs. */
  k: number
  /** The frame's viewport origin on the screen, DIPs: a page point p is at origin + p * k. */
  origin: { x: number; y: number }
  /** The target on the screen, DIPs. */
  target: Rect
  /** Where drawing is allowed on the screen, DIPs: the view's visible part, cut to the frame for a target in one. */
  clip: Rect
  /** The whole visible view on the screen, DIPs. */
  viewClip: Rect
  /** False when no part of the target is inside the clip (scrolled away, the view covered or empty). */
  visible: boolean
}

/** The target's rectangle on the screen, and where it may be drawn. Null when the view has no size to measure by. */
export function guideGeometry(input: GuideGeometryInput): GuideGeometry | null {
  const zoom = input.windowZoom > 0 ? input.windowZoom : 1
  if (!(input.pageWidth > 0) || !(input.view.width > 0) || !(input.view.height > 0)) return null
  const k = (input.view.width * zoom) / input.pageWidth
  const viewX = input.content.x + input.view.x * zoom
  const viewY = input.content.y + input.view.y * zoom
  const origin = { x: viewX + input.frame.x * k, y: viewY + input.frame.y * k }
  const target = pageToScreen(input.target, origin, k)
  const viewRect: Rect = { x: viewX, y: viewY, width: input.view.width * zoom, height: input.view.height * zoom }
  const viewClip = intersect(viewRect, {
    x: input.content.x + input.viewClip.x * zoom,
    y: input.content.y + input.viewClip.y * zoom,
    width: input.viewClip.width * zoom,
    height: input.viewClip.height * zoom,
  })
  const frameRect: Rect = { x: origin.x, y: origin.y, width: input.frame.width * k, height: input.frame.height * k }
  const clip = intersect(viewClip, frameRect)
  return { k, origin, target, clip, viewClip, visible: !isEmpty(intersect(clip, target)) }
}

/** A rectangle of the frame's viewport (page CSS px) on the screen. */
export function pageToScreen(rect: Rect, origin: { x: number; y: number }, k: number): Rect {
  return { x: origin.x + rect.x * k, y: origin.y + rect.y * k, width: rect.width * k, height: rect.height * k }
}
