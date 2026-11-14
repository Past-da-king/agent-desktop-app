/**
 * The docked chat beside the browser: how wide it is and whether it is open, remembered on this device across
 * restarts (lib/workspace.ts holds the rules). The browser view itself and full screen live in the main process
 * with the pages (BrowserState.expanded, BrowserState.fullScreen), so the keyboard works from inside a page too.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'

import { DOCK_DEFAULT_WIDTH, clampDockWidth, readDockPrefs, writeDockPrefs } from '../lib/workspace'

export interface WorkspaceState {
  dockWidth: number
  dockOpen: boolean
  /** While dragging: fitted to the limits and to the window, not yet written. */
  setDockWidth: (width: number, windowWidth?: number) => void
  /** A drag or a key press ended: write it. */
  commit: () => void
  setDockOpen: (open: boolean) => void
  toggleDock: () => void
  resetDockWidth: () => void
}

type Store = Pick<Storage, 'getItem' | 'setItem'>

export function createWorkspace(store: Store | null): UseBoundStore<StoreApi<WorkspaceState>> {
  const initial = readDockPrefs(store)
  return create<WorkspaceState>((set, get) => ({
    dockWidth: initial.width,
    dockOpen: initial.open,
    setDockWidth: (width, windowWidth) => set({ dockWidth: clampDockWidth(width, windowWidth) }),
    commit: () => writeDockPrefs({ width: get().dockWidth, open: get().dockOpen }, store),
    setDockOpen: (open) => {
      set({ dockOpen: open })
      writeDockPrefs({ width: get().dockWidth, open }, store)
    },
    toggleDock: () => get().setDockOpen(!get().dockOpen),
    resetDockWidth: () => {
      set({ dockWidth: DOCK_DEFAULT_WIDTH })
      writeDockPrefs({ width: DOCK_DEFAULT_WIDTH, open: get().dockOpen }, store)
    },
  }))
}

function pageStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export const useWorkspace = createWorkspace(pageStore())
