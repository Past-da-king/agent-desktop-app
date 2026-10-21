import { MAIN_CHAT, type ChatEvent, type ChatRunInfo } from '@agent/core'
import { create } from 'zustand'

import { chat as chatApi } from '../bridge'
import { currentChat, setCurrentChat } from '../lib/current-chat'

const SEEN_KEY = 'agent.chatSeen'

function readSeen(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

const SINCE_KEY = 'agent.chatSeenSince'

/** When unread tracking began on this computer: replies older than this count as read. */
function readSince(): number {
  try {
    const raw = Number(window.localStorage.getItem(SINCE_KEY))
    if (Number.isFinite(raw) && raw > 0) return raw
    const now = Date.now()
    window.localStorage.setItem(SINCE_KEY, String(now))
    return now
  } catch {
    return Date.now()
  }
}

function writeSeen(seen: Record<string, number>): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    // Unread dots fall back to this session only.
  }
}

interface ChatsState {
  /** The chat on screen. */
  open: string
  /** Every chat with something going on, by chat id. */
  runs: Record<string, ChatRunInfo>
  /** When the person last looked at each chat (epoch ms), for "done, not read yet". */
  seen: Record<string, number>
  /** Replies before this are read (unread tracking started then). */
  since: number
  openChat: (chat: string) => void
  markSeen: (chat: string) => void
  refresh: () => Promise<void>
}

export const useChats = create<ChatsState>((set, get) => ({
  open: currentChat(),
  runs: {},
  seen: readSeen(),
  since: readSince(),
  openChat: (chat) => {
    setCurrentChat(chat)
    const seen = { ...get().seen, [chat]: Date.now() }
    writeSeen(seen)
    set({ open: chat, seen })
  },
  markSeen: (chat) => {
    const seen = { ...get().seen, [chat]: Date.now() }
    writeSeen(seen)
    set({ seen })
  },
  refresh: async () => {
    try {
      const list = await chatApi.states()
      const runs: Record<string, ChatRunInfo> = {}
      for (const info of list) runs[info.chat] = info
      set({ runs })
    } catch {
      // An older main process without states(): fall back to events only.
    }
  },
}))

/** The chat an event is about. */
export function eventChat(event: ChatEvent): string {
  return event.chat ?? MAIN_CHAT
}

let started = false

/** Keeps `runs` live: one listener for the whole app. Safe to call more than once. */
export function startChatTracking(): void {
  if (started) return
  started = true
  const store = useChats
  void store.getState().refresh()
  chatApi.onEvent((event) => {
    const chat = eventChat(event)
    if (event.type === 'run_started' || event.type === 'run_finished') {
      const runs = { ...store.getState().runs }
      const before = runs[chat] ?? { chat, running: false, waiting: [], alongside: 0 }
      runs[chat] = { ...before, running: event.type === 'run_started' }
      store.setState({ runs })
      if (event.type === 'run_finished' && store.getState().open === chat) store.getState().markSeen(chat)
    }
    void store.getState().refresh()
  })
}

/** Is this chat running right now. */
export function useChatRunning(chat: string): boolean {
  return useChats((state) => state.runs[chat]?.running === true)
}

/** Is any chat running right now. */
export function useAnyRunning(): boolean {
  return useChats((state) => Object.values(state.runs).some((run) => run.running))
}
