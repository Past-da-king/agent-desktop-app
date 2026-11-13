/**
 * The browser as a workspace (10 Nov 2026). When the page is open over the window ("browser view") the app gives
 * it the room: the title bar folds to a slim strip, the rail and the side panel are out of the way, and the chat
 * docks beside the page as a panel the person can drag, fold and bring back. Full screen keeps only the browser's
 * own toolbar and a way back.
 *
 * Pure: what the layout is for a given state, the dock's width limits, and how the dock is remembered. The dock's
 * width and whether it is open are kept per device, the same way the side panel's are (lib/panel.ts).
 */

export const DOCK_MIN_WIDTH = 320
export const DOCK_MAX_WIDTH = 720
export const DOCK_DEFAULT_WIDTH = 400
/** The page always keeps at least this much width beside the docked chat. */
export const DOCK_PAGE_MIN = 360
/** A window narrower than this cannot hold the page and the chat side by side: the chat docks under the page. */
export const DOCK_BELOW_WIDTH = 760
export const DOCK_PREF_KEY = 'agent.browser.dock'

export interface DockPrefs {
  width: number
  open: boolean
}

/**
 * The dock's width: a whole number between the limits, and never so wide that the page beside it drops under
 * DOCK_PAGE_MIN when the window's width is known.
 */
export function clampDockWidth(value: unknown, windowWidth?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DOCK_DEFAULT_WIDTH
  let max = DOCK_MAX_WIDTH
  if (typeof windowWidth === 'number' && Number.isFinite(windowWidth) && windowWidth > 0) {
    max = Math.max(DOCK_MIN_WIDTH, Math.min(DOCK_MAX_WIDTH, Math.round(windowWidth) - DOCK_PAGE_MIN))
  }
  return Math.min(max, Math.max(DOCK_MIN_WIDTH, Math.round(value)))
}

type PrefStore = Pick<Storage, 'getItem' | 'setItem'>

/** Open at the designed width until the person says otherwise. */
export function readDockPrefs(store?: Pick<Storage, 'getItem'> | null): DockPrefs {
  const fallback: DockPrefs = { width: DOCK_DEFAULT_WIDTH, open: true }
  if (!store) return fallback
  try {
    const raw = store.getItem(DOCK_PREF_KEY)
    if (raw === null || raw === '') return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    const record = parsed as Record<string, unknown>
    return { width: clampDockWidth(record['width']), open: record['open'] !== false }
  } catch {
    return fallback
  }
}

export function writeDockPrefs(prefs: DockPrefs, store?: PrefStore | null): void {
  if (!store) return
  const clean: DockPrefs = { width: clampDockWidth(prefs.width), open: prefs.open !== false }
  try {
    store.setItem(DOCK_PREF_KEY, JSON.stringify(clean))
  } catch {
    // Storage refused: the dock still works for this run.
  }
}

export interface WorkspaceInput {
  /** The page is open over the window (BrowserState.expanded) and there is a page to show. */
  expanded: boolean
  hasPage: boolean
  /** Full screen was asked for (BrowserState.fullScreen). */
  fullScreen: boolean
  dockOpen: boolean
  dockWidth: number
  windowWidth: number
  tabs: number
}

export interface WorkspaceLayout {
  /** Browser view: the page has the window. */
  view: boolean
  /** Full screen: only the browser's toolbar and a way back. */
  full: boolean
  /** The app's own top bar: as usual, a slim strip in browser view, gone in full screen. */
  titleBar: 'normal' | 'slim' | 'hidden'
  /** Where the chat docks: beside the page, under it on a narrow window, or folded away. */
  dock: 'side' | 'below' | 'closed'
  /** The dock's width beside the page, already fitted to the window. 0 unless it is beside the page. */
  dockWidth: number
  /** The tab strip: always in browser view, and in full screen only when there is more than one tab to pick from. */
  showTabs: boolean
}

/** The whole layout from the state: one rule for the title bar, the dock and the tab strip. */
export function workspaceLayout(input: WorkspaceInput): WorkspaceLayout {
  const view = input.expanded && input.hasPage
  if (!view) return { view: false, full: false, titleBar: 'normal', dock: 'closed', dockWidth: 0, showTabs: true }
  const full = input.fullScreen
  const below = input.windowWidth < DOCK_BELOW_WIDTH
  const dock = !input.dockOpen ? 'closed' : below ? 'below' : 'side'
  return {
    view: true,
    full,
    titleBar: full ? 'hidden' : 'slim',
    dock,
    dockWidth: dock === 'side' ? clampDockWidth(input.dockWidth, input.windowWidth) : 0,
    showTabs: !full || input.tabs > 1,
  }
}

export interface EscapeInput {
  /** The key was pressed in a text field, the message box or anything editable. */
  inField: boolean
  /** A dialog, a menu or the palette is open and owns Escape. */
  overlayOpen: boolean
  full: boolean
}

/**
 * What Escape does in browser view: it leaves full screen first, then the browser view. It never takes the page
 * away from someone typing in the docked chat or closing a dialog.
 */
export function escapeAction(input: EscapeInput): 'none' | 'leave-full' | 'leave-view' {
  if (input.overlayOpen) return 'none'
  if (input.full) return 'leave-full'
  if (input.inField) return 'none'
  return 'leave-view'
}
