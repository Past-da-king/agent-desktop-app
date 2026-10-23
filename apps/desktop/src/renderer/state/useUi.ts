import { MAIN_CHAT, type MemoryKind } from '@agent/core'
import { create } from 'zustand'

import { hashFor, isAppPage, parseHash, rememberLastView, type AppPage, type Route } from './route'
import { useChats } from './useChats'

/** Places kept for Back; older ones fall off. */
const MAX_BACK = 50

/** A route as a place: the chat page always with its chat. */
function placeOf(route: Route, openChat: string): Route {
  return route.page === 'chat' ? { page: 'chat', chat: route.chat ?? openChat } : route
}

function samePlace(a: Route, b: Route): boolean {
  if (a.page !== b.page) return false
  if (a.page === 'project' && b.page === 'project') return a.id === b.id
  if (a.page === 'chat' && b.page === 'chat') return (a.chat ?? MAIN_CHAT) === (b.chat ?? MAIN_CHAT)
  if (a.page === 'onboarding' && b.page === 'onboarding') return a.step === b.step
  return true
}

/** Only the app's own pages are places to go back to (never onboarding or the small windows). */
function isBackPlace(route: Route): boolean {
  return route.page === 'project' || isAppPage(route.page)
}

function writeHash(hash: string): void {
  if (typeof window === 'undefined') return
  try {
    if (window.location.hash !== hash) window.location.hash = hash
  } catch {
    // Hash routing is best-effort in odd embeds; the store still changes.
  }
}

export type OverlayName = 'palette' | 'quick' | 'work' | null
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
  /** Where the person was before each move, newest last: the title bar's Back (and Alt+Left) goes to the last one. */
  back: Route[]
  /** Moves to a page. `replace` moves without leaving a way back (boot, a redirect). */
  navigate: (route: Route, options?: { replace?: boolean }) => void
  /** Back to where the person was before the last move; false when there is nowhere to go back to. */
  goBack: () => boolean
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

  back: [],

  navigate: (route, options) => {
    const state = useUi.getState()
    const chats = useChats.getState()
    // The chat page always names its chat, so the place it leaves can be gone back to exactly.
    const next: Route = route.page === 'chat' ? { page: 'chat', chat: route.chat ?? chats.open } : route
    const here = placeOf(state.route, chats.open)
    const moving = !samePlace(here, next)
    if (moving && options?.replace !== true && isBackPlace(here)) set({ back: [...state.back, here].slice(-MAX_BACK) })
    if (next.page === 'chat' && next.chat !== undefined && next.chat !== chats.open) chats.openChat(next.chat)
    writeHash(hashFor(next))
    set({ route: next })
    if (isAppPage(next.page)) rememberLastView(next.page)
  },

  goBack: () => {
    const state = useUi.getState()
    const previous = state.back[state.back.length - 1]
    if (previous === undefined) return false
    set({ back: state.back.slice(0, -1), overlay: null })
    if (previous.page === 'chat' && previous.chat !== undefined && previous.chat !== useChats.getState().open) useChats.getState().openChat(previous.chat)
    writeHash(hashFor(previous))
    set({ route: previous })
    if (isAppPage(previous.page)) rememberLastView(previous.page)
    return true
  },

  applyHash: (hash) => {
    const route = parseHash(hash)
    if (!route) return
    // An address with no chat in it is the main chat (`#/chat`); one with a chat opens that chat.
    if (route.page === 'chat') {
      const chat = route.chat ?? MAIN_CHAT
      if (chat !== useChats.getState().open) useChats.getState().openChat(chat)
      set({ route: { page: 'chat', chat } })
    } else {
      set({ route })
    }
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
