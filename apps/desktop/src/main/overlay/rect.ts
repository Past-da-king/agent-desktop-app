/** Rectangles on the screen, in DIPs (10 Nov 2026). Pure helpers shared by the guide overlay and what feeds it. */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export function intersect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) }
}

export function isEmpty(rect: Rect): boolean {
  return !(rect.width > 0) || !(rect.height > 0)
}

/** The integer DIP rectangle a window takes to cover `rect` whole (windows sit on whole DIPs). */
export function coverRect(rect: Rect): Rect {
  const x = Math.floor(rect.x)
  const y = Math.floor(rect.y)
  return { x, y, width: Math.max(1, Math.ceil(rect.x + rect.width) - x), height: Math.max(1, Math.ceil(rect.y + rect.height) - y) }
}

/** A screen rectangle in the coordinates of a window whose content starts at `origin`. */
export function localRect(rect: Rect, origin: { x: number; y: number }): Rect {
  return { x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height }
}

export function sameRect(a: Rect | null, b: Rect | null, within = 0): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a.x - b.x) <= within && Math.abs(a.y - b.y) <= within && Math.abs(a.width - b.width) <= within && Math.abs(a.height - b.height) <= within
}

/**
 * DIPs to real screen pixels on a display of this scale factor whose DIP and pixel origins are given (the primary
 * display: both 0,0). Rounded the way a capture sees it. Only for checks against a captured frame: windows are
 * always placed in DIPs.
 */
export function toPhysical(rect: Rect, scaleFactor: number, display: { dip: { x: number; y: number }; pixel: { x: number; y: number } } = { dip: { x: 0, y: 0 }, pixel: { x: 0, y: 0 } }): Rect {
  const s = scaleFactor > 0 ? scaleFactor : 1
  const x = Math.round(display.pixel.x + (rect.x - display.dip.x) * s)
  const y = Math.round(display.pixel.y + (rect.y - display.dip.y) * s)
  const right = Math.round(display.pixel.x + (rect.x + rect.width - display.dip.x) * s)
  const bottom = Math.round(display.pixel.y + (rect.y + rect.height - display.dip.y) * s)
  return { x, y, width: right - x, height: bottom - y }
}
