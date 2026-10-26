/**
 * Where a window opens: the rectangle maths, pure, so it is tested without Electron.
 *
 * A window's saved rectangle is only a wish. The screen it was on may be gone, smaller, scaled differently or
 * have a taskbar where the window was; a snapped window saves its snapped rectangle. Whatever was saved, the
 * window opens fully on a screen that exists, never under the taskbar or off an edge.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindow {
  width: number
  height: number
  /** null: never placed (first start), so it is centred. */
  x: number | null
  y: number | null
  maximized: boolean
}

export interface FittedWindow {
  /** null only when there is no screen information at all (left to the system). */
  x: number | null
  y: number | null
  width: number
  height: number
  /** Open maximised (the rectangle is then the size it returns to when un-maximised). */
  maximized: boolean
}

export interface FitOptions {
  minWidth: number
  minHeight: number
  /** The size of a fresh window; shrunk to fit a small screen. */
  defaultWidth: number
  defaultHeight: number
  /** Pixels of slack when comparing against a screen edge. */
  tolerance?: number
  /** A saved window as big as the screen, or saved maximised, opens maximised. Off when re-fitting a live window. */
  allowMaximize?: boolean
}

/** Less than this share of the window on any screen and it is treated as lost, so it is centred instead. */
const LOST_SHARE = 0.25
/** A fresh window never takes more than this share of the screen it opens on. */
const FRESH_SHARE = 0.9

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

/** Fully inside [start, start + length]: kept. Otherwise centred on that axis (a nudge to the edge is what left it looking pushed off). */
function placeAxis(pos: number | null, size: number, start: number, length: number): number {
  if (pos !== null && pos >= start && pos + size <= start + length) return Math.round(pos)
  return Math.round(start + (length - size) / 2)
}

function centred(area: Rect, width: number, height: number): Rect {
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  }
}

function freshSize(area: Rect, options: FitOptions): { width: number; height: number } {
  return {
    width: Math.round(Math.min(options.defaultWidth, area.width * FRESH_SHARE, area.width)),
    height: Math.round(Math.min(options.defaultHeight, area.height * FRESH_SHARE, area.height)),
  }
}

/**
 * The rectangle a window opens at, given what was saved and the work areas of the screens there are now
 * (the primary screen first). The result always lies fully inside one work area.
 *
 * - Picks the screen the window overlaps most; on none (a screen that was unplugged) or barely any, the primary
 *   screen, centred.
 * - Shrinks a window bigger than its screen, then moves it in; an axis that had to move is centred.
 * - A size below the minimum, or not a number, becomes the default size.
 * - Saved maximised, or as big as the screen both ways, opens maximised with a sensible size to return to.
 */
export function fitWindowToDisplay(saved: SavedWindow, workAreas: readonly Rect[], options: FitOptions): FittedWindow {
  const tolerance = options.tolerance ?? 8
  const allowMaximize = options.allowMaximize ?? true
  const areas = workAreas.filter((a) => finite(a.x) && finite(a.y) && finite(a.width) && finite(a.height) && a.width > 0 && a.height > 0)
  const sizeOk =
    finite(saved.width) && finite(saved.height) && saved.width >= options.minWidth && saved.height >= options.minHeight
  const width = sizeOk ? Math.round(saved.width) : options.defaultWidth
  const height = sizeOk ? Math.round(saved.height) : options.defaultHeight
  const placed = finite(saved.x) && finite(saved.y)

  if (areas.length === 0) {
    // No screen information at all: leave it to the system.
    return {
      x: placed ? Math.round(saved.x as number) : null,
      y: placed ? Math.round(saved.y as number) : null,
      width,
      height,
      maximized: saved.maximized,
    }
  }
  const primary = areas[0] as Rect

  let area = primary
  let lost = !placed
  if (placed) {
    const rect: Rect = { x: saved.x as number, y: saved.y as number, width, height }
    let best = 0
    for (const candidate of areas) {
      const shared = overlap(rect, candidate)
      if (shared > best) {
        best = shared
        area = candidate
      }
    }
    if (best === 0 || best < width * height * LOST_SHARE) {
      area = best === 0 ? primary : area
      lost = true
    }
  }

  const fillsScreen = width >= area.width - tolerance && height >= area.height - tolerance
  const maximized = allowMaximize && (saved.maximized || fillsScreen)

  // The size it returns to when un-maximised: a screen-filling one would only fill the screen again.
  if (maximized && (fillsScreen || !sizeOk)) {
    const fresh = freshSize(area, options)
    return { ...centred(area, fresh.width, fresh.height), maximized: true }
  }

  const fitWidth = Math.min(width, area.width)
  const fitHeight = Math.min(height, area.height)
  if (lost) return { ...centred(area, fitWidth, fitHeight), maximized }
  return {
    x: placeAxis(saved.x, fitWidth, area.x, area.width),
    y: placeAxis(saved.y, fitHeight, area.y, area.height),
    width: fitWidth,
    height: fitHeight,
    maximized,
  }
}

/**
 * Looks like Windows Snap (or a snap layout) put it there: it runs the full height of the work area against a side,
 * or sits in a corner at about half the height. A snapped window's "normal" bounds are the snapped rectangle, so
 * that is not remembered as the size he chose.
 */
export function looksSnapped(bounds: Rect, area: Rect, tolerance = 8): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) <= tolerance
  const top = near(bounds.y, area.y)
  const bottom = near(bounds.y + bounds.height, area.y + area.height)
  const left = near(bounds.x, area.x)
  const right = near(bounds.x + bounds.width, area.x + area.width)
  const fullWidth = left && right
  const fullHeight = top && bottom
  if (fullWidth && fullHeight) return false // the whole work area: that is maximised-sized, handled as such
  if (fullHeight && (left || right)) return true // left or right half, a third, two thirds
  const halfHeight = Math.abs(bounds.height - area.height / 2) <= tolerance * 2
  return halfHeight && (top || bottom) && (left || right) // a quarter
}

/** The work areas in the order fitWindowToDisplay wants: the primary screen first. */
export function workAreasPrimaryFirst(primary: { workArea: Rect }, all: readonly { workArea: Rect }[]): Rect[] {
  const rest = all.map((d) => d.workArea).filter((a) => !(a.x === primary.workArea.x && a.y === primary.workArea.y && a.width === primary.workArea.width && a.height === primary.workArea.height))
  return [primary.workArea, ...rest]
}

export interface FrameDelta {
  width: number
  height: number
}

/** Bigger than this and the difference is not the frame (a scale change resized it): not corrected. */
const MAX_FRAME_DELTA = 16

/**
 * How much bigger the system reports a window than it was asked to be. A frameless window with a resizable frame
 * on a scaled Windows screen reports its bounds a pixel or two larger than it was created at (1200x700 reads back
 * as 1202x702 at 125%), so saving what it reports and restoring it grows the window on every restart.
 */
export function frameDelta(requested: { width: number; height: number }, reported: { width: number; height: number }): FrameDelta {
  const width = reported.width - requested.width
  const height = reported.height - requested.height
  return {
    width: Math.abs(width) <= MAX_FRAME_DELTA ? width : 0,
    height: Math.abs(height) <= MAX_FRAME_DELTA ? height : 0,
  }
}

/** The size to save or compare: what the window reports, less the frame difference, so a restore round-trips. */
export function withoutFrame<T extends { width: number; height: number }>(rect: T, delta: FrameDelta): T {
  return { ...rect, width: rect.width - delta.width, height: rect.height - delta.height }
}

/** Two rectangles the same, to the pixel. */
export function sameRect(a: Rect, b: Rect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
