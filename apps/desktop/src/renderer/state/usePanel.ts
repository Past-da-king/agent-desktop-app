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
  openReport: (id) => set({ report: id, helper: null }),
  closeReport: () => set({ report: null }),
  resetWidth: () => {
    set({ width: PANEL_DEFAULT_WIDTH })
    writePanelPrefs({ width: PANEL_DEFAULT_WIDTH, collapsed: get().collapsed }, prefStore())
  },
}))
