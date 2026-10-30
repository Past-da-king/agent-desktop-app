/**
 * This window's side of a dictation: the view the main process sends (one copy, also after a reload), the words that
 * land in a message box, and the finished recordings that never landed, which the box offers back.
 */
import type { DictationBoxText, DictationView, UndeliveredDictation } from '@agent/core'
import { create } from 'zustand'

import { agent } from '../bridge'
import { currentChat } from '../lib/current-chat'
import { setDraftFlush, useDrafts } from '../state/useDrafts'

/** True on the computer itself, where dictation runs through the main process (live words, limits, Retry). */
export function dictationHere(): boolean {
  return agent.platform !== 'web' && agent.remote === undefined
}

export const useDictationStore = create<{ view: DictationView | null; undelivered: UndeliveredDictation[] }>(() => ({ view: null, undelivered: [] }))

/** The dictation going into this window, or null when there is none. */
export function useDictationDraft(): DictationView | null {
  return useDictationStore((state) => state.view)
}

/** A text field he can type in. */
export function isEditable(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled
  if (!(element instanceof HTMLInputElement)) return false
  return !element.readOnly && !element.disabled && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type)
}

/** Types at the cursor of the field in front, and reads it back. */
function typeInFocused(words: string): boolean {
  const element = document.activeElement
  if (!isEditable(element)) return false
  const read = (): string => (element.isContentEditable ? (element.textContent ?? '') : (element as HTMLInputElement).value)
  const before = read()
  const sent = document.execCommand('insertText', false, words)
  const after = read()
  return sent && after !== before && after.includes(words.trim())
}

function land(message: DictationBoxText, hasChats: boolean): boolean {
  if (message.into === 'box') return message.chat !== null && useDrafts.getState().addWords(message.chat, message.text, message.id)
  if (useDrafts.getState().applied(message.id)) return true
  if (typeInFocused(message.text)) return true
  // The shortcut with no field in front in this window: the box of the chat on screen, never nowhere.
  return hasChats && useDrafts.getState().addWords(currentChat(), message.text, message.id)
}

export async function refreshUndelivered(): Promise<void> {
  try {
    const list = await agent.dictation.undelivered()
    // Already in a draft, only the answer never reached the computer (the window reloaded right then).
    const known = list.filter((item) => useDrafts.getState().applied(item.id))
    for (const item of known) void agent.dictation.settle(item.id, 'confirmed').catch(() => undefined)
    useDictationStore.setState({ undelivered: list.filter((item) => !known.includes(item)) })
  } catch {
    // Offered again the next time something changes.
  }
}

/** Starts it for this window; `hasChats` is false for the small windows that have no chat's box. */
export function startDictationBox(hasChats: boolean): () => void {
  if (!dictationHere()) return () => undefined
  setDraftFlush(() => void agent.dictation.flushDrafts().catch(() => undefined))
  const offDraft = agent.dictation.onDraft((next) => useDictationStore.setState({ view: next.phase === 'hidden' ? null : next }))
  const offBox = agent.dictation.onBoxText((message) => {
    let ok = false
    try {
      ok = land(message, hasChats)
    } catch {
      ok = false
    }
    // The words are in the box now: they no longer show as still being heard.
    if (ok) useDictationStore.setState((state) => ({ view: state.view === null ? null : { ...state.view, text: '', interim: '' } }))
    void agent.dictation.boxResult(message.id, ok).catch(() => undefined)
  })
  const offUndelivered = agent.dictation.onUndelivered(() => void refreshUndelivered())
  // After a reload the dictation is still going in the main process: pick it up where it is.
  void agent.dictation
    .current()
    .then((view) => {
      if (view !== null && useDictationStore.getState().view === null) useDictationStore.setState({ view })
    })
    .catch(() => undefined)
  void refreshUndelivered()
  return () => {
    offDraft()
    offBox()
    offUndelivered()
  }
}
