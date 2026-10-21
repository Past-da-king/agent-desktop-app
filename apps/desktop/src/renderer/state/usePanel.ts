import { create } from 'zustand'

import {
  PANEL_DEFAULT_WIDTH,
  clampPanelWidth,
  readPanelPrefs,
  writePanelPrefs,
} from '../lib/panel'

function prefStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const initial = readPanelPrefs(prefStore())

/**
 * How the browser card shows: `auto` opens it while a page is open and folds it to one line when nothing is;
 * `min` is the person keeping it on one line (pages keep running); `open` is the person opening it with no page.
 */
export type BrowserMode = 'auto' | 'min' | 'open'
const BROWSER_MODE_KEY = 'agent.browserMode'

function readBrowserMode(): BrowserMode {
  try {
    return prefStore()?.getItem(BROWSER_MODE_KEY) === 'min' ? 'min' : 'auto'
  } catch {
    return 'auto'
  }
}

function writeBrowserMode(mode: BrowserMode): void {
  try {
    if (mode === 'min') prefStore()?.setItem(BROWSER_MODE_KEY, 'min')
    else prefStore()?.removeItem(BROWSER_MODE_KEY)
  } catch {
    // Storage refused: the choice lasts until the window closes.
  }
}

interface PanelState {
  width: number
  collapsed: boolean
  setWidth: (width: number) => void
  /** Called when a drag or key press ends, so ordinary renders do not touch storage. */
  commit: () => void
  setCollapsed: (collapsed: boolean) => void
  toggle: () => void
  resetWidth: () => void
  /** A helper opened full size over the window; closing it gives the panel back at its own width. */
  helper: string | null
  openHelper: (id: string) => void
  closeHelper: () => void
  browserMode: BrowserMode
  setBrowserMode: (mode: BrowserMode) => void
  /** A report (its chat row id) open to read in the side panel, in the helper's place. */
  report: string | null
  openReport: (id: string) => void
  closeReport: () => void
}

export const usePanel = create<PanelState>((set, get) => ({
  width: initial.width,
  collapsed: initial.collapsed,
  setWidth: (width) => set({ width: clampPanelWidth(width) }),
  commit: () => writePanelPrefs({ width: get().width, collapsed: get().collapsed }, prefStore()),
  setCollapsed: (collapsed) => {
    set({ collapsed })
    writePanelPrefs({ width: get().width, collapsed }, prefStore())
  },
  toggle: () => get().setCollapsed(!get().collapsed),
  helper: null,
  openHelper: (id) => set({ helper: id, report: null }),
  closeHelper: () => set({ helper: null }),
  report: null,
  browserMode: readBrowserMode(),
  setBrowserMode: (mode) => {
    writeBrowserMode(mode)
    set({ browserMode: mode })
  },
  openReport: (id) => set({ report: id, helper: null }),
  closeReport: () => set({ report: null }),
  resetWidth: () => {
    set({ width: PANEL_DEFAULT_WIDTH })
    writePanelPrefs({ width: PANEL_DEFAULT_WIDTH, collapsed: get().collapsed }, prefStore())
  },
}))
