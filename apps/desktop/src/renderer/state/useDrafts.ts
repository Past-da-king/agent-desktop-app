/**
 * Every chat's message box, kept outside the box itself: the text and files are written to this computer's storage on
 * every change, per chat, so a navigation, a reload or a restart never loses them, and a dictation can reach a chat
 * that is not on screen. A message's draft is only cleared from storage once the message was accepted.
 */
import type { Attachment } from '@agent/core'
import { create, type StoreApi, type UseBoundStore } from 'zustand'

import { draftHolds, joinDraft } from '../../shared/box-draft'

const TEXT_KEY = 'agent.draft.v1.'
const FILES_KEY = 'agent.draftFiles.v1.'
/** Recordings already put in a draft: the same one is never added twice (a late answer, Insert after a reload). */
const APPLIED_KEY = 'agent.draftApplied.v1'
const APPLIED_KEPT = 60

export interface DraftStorage {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface Sending {
  text: string
  files: Attachment[]
}

export interface DraftsState {
  texts: Record<string, string>
  files: Record<string, Attachment[]>
  /** Goes up when a dictation lands in a chat: its box takes the cursor if he is not typing elsewhere. */
  added: Record<string, number>
  setText(chat: string, text: string): void
  setFiles(chat: string, files: Attachment[]): void
  /** A dictation's words after what is there. True only when they were read back from storage. */
  addWords(chat: string, words: string, recording?: string): boolean
  /** This recording's words are already in a draft. */
  applied(recording: string): boolean
  /** The box empties now; storage keeps the message until `accepted`. */
  sending(chat: string): void
  accepted(chat: string): void
  /** Not accepted: the message comes back in front of whatever was typed since. */
  refused(chat: string): void
}

let flushHook: (() => void) | null = null
/** How this window asks for its storage to be written to disk now. */
export function setDraftFlush(hook: () => void): void {
  flushHook = hook
}

function readFiles(storage: DraftStorage, key: string): Attachment[] {
  try {
    const parsed = JSON.parse(storage.getItem(key) ?? '[]') as unknown
    return Array.isArray(parsed) ? (parsed as Attachment[]) : []
  } catch {
    return []
  }
}

function readApplied(storage: DraftStorage): string[] {
  try {
    const parsed = JSON.parse(storage.getItem(APPLIED_KEY) ?? '[]') as unknown
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** How soon after a change the draft is pushed to disk. */
export const DRAFT_FLUSH_MS = 400

export function createDrafts(storage: DraftStorage | null, flush: () => void = () => flushHook?.()): UseBoundStore<StoreApi<DraftsState>> {
  const texts: Record<string, string> = {}
  const files: Record<string, Attachment[]> = {}
  if (storage !== null) {
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key === null) continue
        if (key.startsWith(TEXT_KEY)) texts[key.slice(TEXT_KEY.length)] = storage.getItem(key) ?? ''
        else if (key.startsWith(FILES_KEY)) files[key.slice(FILES_KEY.length)] = readFiles(storage, key)
      }
    } catch {
      // Storage that cannot be read starts empty; the box still works for this run.
    }
  }
  const inFlight = new Map<string, Sending>()
  let appliedIds = storage === null ? [] : readApplied(storage)

  // The page's storage reaches the disk when Chromium gets round to it, rate limited to as little as once a minute,
  // so a hard kill lost a draft typed seconds before. Each change asks for it to be written now, at most this often.
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flushSoon = (): void => {
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      try {
        flush()
      } catch {
        // Chromium still writes it itself a little later.
      }
    }, DRAFT_FLUSH_MS)
  }

  /** Writes what the chat's box holds, plus a message on its way, so a crash in between loses neither. */
  const persist = (chat: string, text: string, list: Attachment[]): boolean => {
    if (storage === null) return false
    const going = inFlight.get(chat)
    const allText = going === undefined ? text : joinDraft(going.text, text)
    const allFiles = going === undefined ? list : [...going.files, ...list]
    try {
      if (allText === '') storage.removeItem(TEXT_KEY + chat)
      else storage.setItem(TEXT_KEY + chat, allText)
      if (allFiles.length === 0) storage.removeItem(FILES_KEY + chat)
      else storage.setItem(FILES_KEY + chat, JSON.stringify(allFiles))
      flushSoon()
      return true
    } catch {
      return false
    }
  }

  return create<DraftsState>((set, get) => ({
    texts,
    files,
    added: {},
    setText: (chat, text) => {
      if ((get().texts[chat] ?? '') === text) return
      persist(chat, text, get().files[chat] ?? [])
      set((state) => ({ texts: { ...state.texts, [chat]: text } }))
    },
    setFiles: (chat, list) => {
      persist(chat, get().texts[chat] ?? '', list)
      set((state) => ({ files: { ...state.files, [chat]: list } }))
    },
    applied: (recording) => appliedIds.includes(recording),
    addWords: (chat, words, recording) => {
      const clean = words.trim()
      if (clean === '') return false
      if (recording !== undefined && appliedIds.includes(recording)) return true
      const next = joinDraft(get().texts[chat] ?? '', clean)
      if (!persist(chat, next, get().files[chat] ?? [])) return false
      let held = false
      try {
        held = draftHolds(storage?.getItem(TEXT_KEY + chat) ?? '', clean)
      } catch {
        held = false
      }
      if (!held) return false
      if (recording !== undefined) {
        appliedIds = [...appliedIds, recording].slice(-APPLIED_KEPT)
        try {
          storage?.setItem(APPLIED_KEY, JSON.stringify(appliedIds))
        } catch {
          // The words are in the draft; only the guard against adding them twice is short of a row.
        }
      }
      set((state) => ({ texts: { ...state.texts, [chat]: next }, added: { ...state.added, [chat]: (state.added[chat] ?? 0) + 1 } }))
      return true
    },
    sending: (chat) => {
      const earlier = inFlight.get(chat)
      const text = get().texts[chat] ?? ''
      const list = get().files[chat] ?? []
      inFlight.set(chat, { text: earlier === undefined ? text : joinDraft(earlier.text, text), files: [...(earlier?.files ?? []), ...list] })
      persist(chat, '', [])
      set((state) => ({ texts: { ...state.texts, [chat]: '' }, files: { ...state.files, [chat]: [] } }))
    },
    accepted: (chat) => {
      inFlight.delete(chat)
      persist(chat, get().texts[chat] ?? '', get().files[chat] ?? [])
    },
    refused: (chat) => {
      const going = inFlight.get(chat)
      if (going === undefined) return
      inFlight.delete(chat)
      const text = joinDraft(going.text, get().texts[chat] ?? '')
      const list = [...going.files, ...(get().files[chat] ?? [])]
      persist(chat, text, list)
      set((state) => ({ texts: { ...state.texts, [chat]: text }, files: { ...state.files, [chat]: list } }))
    },
  }))
}

function pageStorage(): DraftStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export const useDrafts = createDrafts(pageStorage())
