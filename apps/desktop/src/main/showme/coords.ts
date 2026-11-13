/**
 * Screen pixels and DIPs ("show me how", 10 Nov 2026). The screen reader speaks physical pixels (what Windows UI
 * Automation and the mouse hook give); the overlay speaks Electron's DIPs per display. On a 125% screen a button at
 * pixel 1000 is at DIP 800, and a second display has its own scale and its own origin in both systems, so the
 * conversion is always per display: find the display the thing is on, then scale around that display's two origins.
 *
 * Pure: the displays come in as data (displaysOf reads them from Electron), so every scale and layout is tested.
 */
import type { Rect } from './screen'

export interface ScreenDisplay {
  id: number
  /** Where the display is in DIPs (Electron's display.bounds). */
  dip: Rect
  /** Where the same display is in physical pixels. */
  pixel: Rect
  scaleFactor: number
}

function far(rect: Rect, x: number, y: number): number {
  const dx = Math.max(rect.x - x, 0, x - (rect.x + rect.width))
  const dy = Math.max(rect.y - y, 0, y - (rect.y + rect.height))
  return Math.hypot(dx, dy)
}

/** The display a pixel rectangle is on: the one holding its centre, else the nearest. Null with no display. */
export function displayOfPixels(rect: Rect, displays: ScreenDisplay[]): ScreenDisplay | null {
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  let best: ScreenDisplay | null = null
  let bestFar = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const d = far(display.pixel, cx, cy)
    if (d < bestFar) {
      best = display
      bestFar = d
    }
  }
  return best
}

/** A physical pixel rectangle as the DIP rectangle the overlay draws, and the display it is on. */
export function toDip(rect: Rect, displays: ScreenDisplay[]): { rect: Rect; displayId: number } | null {
  const display = displayOfPixels(rect, displays)
  if (display === null) return null
  const s = display.scaleFactor > 0 ? display.scaleFactor : 1
  return {
    displayId: display.id,
    rect: {
      x: display.dip.x + (rect.x - display.pixel.x) / s,
      y: display.dip.y + (rect.y - display.pixel.y) / s,
      width: rect.width / s,
      height: rect.height / s,
    },
  }
}

/** The other way, for a check: a DIP rectangle on a display as physical pixels. */
export function toPixels(rect: Rect, display: ScreenDisplay): Rect {
  const s = display.scaleFactor > 0 ? display.scaleFactor : 1
  return {
    x: display.pixel.x + (rect.x - display.dip.x) * s,
    y: display.pixel.y + (rect.y - display.dip.y) * s,
    width: rect.width * s,
    height: rect.height * s,
  }
}

/** The slice of Electron's `screen` this needs. dipToScreenRect exists on Windows only. */
export interface ScreenLike {
  getAllDisplays(): Array<{ id: number; bounds: Rect; scaleFactor: number }>
  dipToScreenRect?: (window: null, rect: Rect) => Rect
}

/**
 * This computer's displays in both systems. Windows knows where each display is in pixels (dipToScreenRect); where
 * that is missing the display's DIP origin is scaled, which is exact for one display and for displays of one scale.
 */
export function displaysOf(screen: ScreenLike): ScreenDisplay[] {
  return screen.getAllDisplays().map((display) => {
    const s = display.scaleFactor > 0 ? display.scaleFactor : 1
    let pixel: Rect | null = null
    try {
      pixel = screen.dipToScreenRect?.(null, display.bounds) ?? null
    } catch {
      pixel = null
    }
    if (pixel === null || !(pixel.width > 0) || !(pixel.height > 0)) {
      pixel = { x: Math.round(display.bounds.x * s), y: Math.round(display.bounds.y * s), width: Math.round(display.bounds.width * s), height: Math.round(display.bounds.height * s) }
    }
    return { id: display.id, dip: { ...display.bounds }, pixel, scaleFactor: s }
  })
}

export function contains(rect: Rect, x: number, y: number, pad = 0): boolean {
  return x >= rect.x - pad && x <= rect.x + rect.width + pad && y >= rect.y - pad && y <= rect.y + rect.height + pad
}
