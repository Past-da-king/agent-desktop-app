/**
 * A message that leaves the box while a dictation for that box is still being written down goes without those words:
 * they land in the emptied box afterwards (18 Nov 2026, the same race as on the phone, where the live caption went).
 * Send waits for the dictation: it ends the listening, waits until the words have landed in the draft, then sends.
 */
import type { DictationView } from '@agent/core'

const ACTIVE = ['starting', 'listening', 'finishing', 'cleaning']

export type DictationWait = 'none' | 'landed' | 'ended' | 'failed' | 'timeout'

export interface DictationIo {
  /** The dictation going into this window now. */
  view(): DictationView | null
  /** Calls `listener` at every change of the view; returns how to stop. */
  subscribe(listener: () => void): () => void
  /** Ends the listening of the dictation for this chat (the same as the mic button's second tap). */
  stop(chat: string): void
}

/** Whether a dictation for [chat]'s box is running or being written down. */
export function dictatingFor(view: DictationView | null, chat: string): boolean {
  return view !== null && view.chat === chat && ACTIVE.includes(view.phase)
}

/**
 * Resolves when the dictation for [chat] is over. landed: its words are in the draft (the controller answers 'done' only
 * after the box confirmed them). ended: it was dismissed or cancelled, nothing more is coming. failed: the words could not
 * be had or did not reach the box, so the draft is NOT complete. none: no dictation for this chat. timeout: gave up waiting.
 */
export function waitForDictation(chat: string, io: DictationIo, limitMs: number): Promise<DictationWait> {
  const first = io.view()
  if (!dictatingFor(first, chat)) return Promise.resolve('none')
  return new Promise((resolve) => {
    let finished = false
    let off: () => void = () => undefined
    const done = (result: DictationWait): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      off()
      resolve(result)
    }
    const timer = setTimeout(() => done('timeout'), limitMs)
    const look = (): void => {
      const view = io.view()
      if (dictatingFor(view, chat)) return
      if (view === null || view.phase === 'hidden') done('ended')
      else if (view.phase === 'done') done('landed')
      else done('failed')
    }
    off = io.subscribe(look)
    if (first !== null && (first.phase === 'starting' || first.phase === 'listening')) io.stop(chat)
    look()
  })
}

/**
 * Runs [send] once the words of a dictation still going into [chat]'s box have landed. Nothing is sent when they could not
 * be had: [onHeld] says so and the draft stays as it is. Without a dictation it sends at once.
 */
export async function sendAfterDictation(chat: string, io: DictationIo, send: () => void, onHeld: (why: 'failed' | 'timeout') => void, limitMs = 130_000): Promise<void> {
  const result = await waitForDictation(chat, io, limitMs)
  if (result === 'failed' || result === 'timeout') onHeld(result)
  else send()
}
