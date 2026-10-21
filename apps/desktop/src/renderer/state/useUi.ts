import type { MemoryKind } from '@agent/core'
import { create } from 'zustand'

import { hashFor, isAppPage, parseHash, rememberLastView, type AppPage, type Route } from './route'

export type OverlayName = 'palette' | 'quick' | null
export type TaskTab = 'todos' | 'agent'
export type MemoryFilter = 'all' | MemoryKind

interface UiState {
  route: Route
  overlay: OverlayName
  railCollapsed: boolean
  taskTab: TaskTab
  taskSel: string | null
  memSel: string | null
  memQuery: string
  memKind: MemoryFilter
  /** When set, the Memory view shows only these pages (the ones the last chat saved). */
  memOnly: string[] | null
  /** Bumped when New chat or a palette action should put the cursor in the composer. */
  composerFocus: number
  /** Text to put in the composer the next time it takes focus (a recent chat picked from the rail). */
  composerDraft: string
  /** Bumped when New chat should bring the newest part of the thread back into view. */
  chatScroll: number
  navigate: (route: Route) => void
  applyHash: (hash: string) => void
  setOverlay: (overlay: OverlayName) => void
  openPalette: () => void
  openQuick: () => void
  closeOverlay: () => void
  toggleRail: () => void
  setTaskTab: (tab: TaskTab) => void
  selectTask: (id: string | null) => void
  selectMemory: (id: string | null) => void
  setMemoryQuery: (query: string) => void
  setMemoryKind: (kind: MemoryFilter) => void
  /** Opens Memory on just these pages; null shows everything again. */
  showMemories: (ids: string[] | null) => void
  focusComposer: () => void
  draftComposer: (text: string) => void
  scrollChat: () => void
}

export const useUi = create<UiState>((set) => ({
  route: { page: 'home' },
  overlay: null,
  railCollapsed: false,
  taskTab: 'todos',
  taskSel: null,
  memSel: null,
  memQuery: '',
  memKind: 'all',
  memOnly: null,
  composerFocus: 0,
  composerDraft: '',
  chatScroll: 0,

  navigate: (route) => {
    const hash = hashFor(route)
    if (window.location.hash !== hash) {
      try {
        window.location.hash = hash
      } catch {
        // Hash routing is best-effort in odd embeds; the store still changes below.
      }
    }
    set({ route })
    if (isAppPage(route.page)) rememberLastView(route.page)
  },

  applyHash: (hash) => {
    const route = parseHash(hash)
    if (!route) return
    set({ route })
    if (isAppPage(route.page)) rememberLastView(route.page)
  },

  setOverlay: (overlay) => set({ overlay }),
  openPalette: () => set({ overlay: 'palette' }),
  openQuick: () => set({ overlay: 'quick' }),
  closeOverlay: () => set({ overlay: null }),
  toggleRail: () => set((state) => ({ railCollapsed: !state.railCollapsed })),
  setTaskTab: (taskTab) => set({ taskTab }),
  selectTask: (taskSel) => set({ taskSel }),
  selectMemory: (memSel) => set({ memSel }),
  setMemoryQuery: (memQuery) => set({ memQuery }),
  setMemoryKind: (memKind) => set({ memKind }),
  showMemories: (ids) => {
    if (ids !== null) {
      useUi.getState().navigate({ page: 'memory' })
      set({ memOnly: ids, memQuery: '', memKind: 'all', memSel: ids[0] ?? null })
      return
    }
    set({ memOnly: null })
  },
  focusComposer: () => set((state) => ({ composerFocus: state.composerFocus + 1, overlay: null })),
  draftComposer: (composerDraft) =>
    set((state) => ({ composerDraft, composerFocus: state.composerFocus + 1, overlay: null })),
  scrollChat: () => set((state) => ({ chatScroll: state.chatScroll + 1 })),
}))

export function useRoute(): Route {
  return useUi((state) => state.route)
}

export function navigateTo(page: AppPage): void {
  useUi.getState().navigate({ page })
}
