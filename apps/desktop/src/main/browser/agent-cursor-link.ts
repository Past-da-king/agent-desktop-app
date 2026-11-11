/**
 * Where the agent cursor goes for a browser action (11 Nov 2026). The agent clicks and types in a tab by the page's
 * debugger (cdp.ts) and never with his pointer, so the click has no place on his screen; this works out where it would
 * be, so overlay/agent-cursor.ts can draw the agent's own cursor there. Pure: every case is a test.
 *
 * Units: the page point is in page CSS px of the top frame's viewport (what cdp.ts takes, before its draw scale); the
 * answer is screen DIPs, by the same maths the guide ring uses (guide-geometry.ts).
 */
import { guideGeometry } from './guide-geometry'
import type { Located, Point } from '../overlay/agent-cursor'
import type { ViewInfo, WindowInfo } from './guide-private'

export interface BrowserCursorInput {
  /** The action's point in the page, CSS px. */
  point: Point
  /** The top page's viewport width, CSS px (innerWidth). */
  pageWidth: number
  view: ViewInfo | null
  window: WindowInfo | null
}

export function browserCursorAt(input: BrowserCursorInput): Located | null {
  const { view, window: win } = input
  if (view === null || win === null || !view.found) return null
  const geometry = guideGeometry({
    target: { x: input.point.x, y: input.point.y, width: 0, height: 0 },
    frame: { x: 0, y: 0, width: input.pageWidth, height: 0 },
    pageWidth: input.pageWidth,
    view: view.view,
    viewClip: view.clip,
    windowZoom: win.zoom,
    content: win.content,
  })
  if (geometry === null) return null
  const at = { x: geometry.target.x, y: geometry.target.y }
  const inside = at.x >= geometry.viewClip.x && at.x <= geometry.viewClip.x + geometry.viewClip.width && at.y >= geometry.viewClip.y && at.y <= geometry.viewClip.y + geometry.viewClip.height
  // Hidden while the tab is not the one in front, is parked behind the app, has a dialog of the app over it, the
  // window is minimised, or the point is scrolled out of the visible part.
  const visible = win.visible && view.front && !view.backstage && !view.covered && inside
  return { at, visible, area: geometry.viewClip }
}

/** The words beside the cursor: a short present-tense step. Never the typed text itself (it can be a secret). */
export function cursorLabel(action: string, target: string): string {
  const what = target.trim() === '' ? 'the page' : target.trim().replace(/\s+/g, ' ').slice(0, 48)
  switch (action) {
    case 'type':
      return `Typing in ${what}`
    case 'select':
      return `Choosing in ${what}`
    case 'check':
      return `Ticking ${what}`
    case 'uncheck':
      return `Unticking ${what}`
    case 'hover':
      return `Looking at ${what}`
    case 'scroll':
      return 'Scrolling'
    case 'drag':
      return `Dragging ${what}`
    case 'hold':
      return `Holding ${what}`
    case 'upload':
      return `Attaching a file to ${what}`
    case 'press':
      return `Pressing ${what}`
    case 'fill':
      return `Filling in ${what}`
    default:
      return `Clicking ${what}`
  }
}
