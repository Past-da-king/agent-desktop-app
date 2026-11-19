/**
 * The size a screenshot should be, so a point read off it is a point of the page.
 *
 * The agent reads a point off a screenshot and clicks it (`at:{x,y}`), and the click is made in the page's own CSS
 * pixels. Electron captures a page at the screen's device scale: on a Windows display set to 125% or 150% a 1440 px
 * wide page comes back 1800 or 2160 px wide, so every point read off it landed 25% or 50% too far right and down.
 * In a dense editor (the ribbon of an Office app in the browser) that is a click on the wrong button or on nothing,
 * and the page looks unchanged ("pixel-identical" before and after). The picture is brought back to the page's size.
 */
export interface Size {
  width: number
  height: number
}

/** The size to draw the picture at, or null when it already is the page's size (or not a clean multiple of it). */
export function shotResize(actual: Size, page: Size): Size | null {
  if (!(actual.width > 0 && actual.height > 0 && page.width > 0 && page.height > 0)) return null
  const rx = actual.width / page.width
  const ry = actual.height / page.height
  // Same factor on both axes, at least a few percent larger, not absurdly larger: a device scale factor.
  if (Math.abs(rx - ry) > 0.03 * Math.max(rx, ry)) return null
  if (rx < 1.04 || rx > 4) return null
  return { width: Math.round(page.width), height: Math.round(page.height) }
}
