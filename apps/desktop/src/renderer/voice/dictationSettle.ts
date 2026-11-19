/**
 * Instant send (19 Nov 2026) replaced the wait of 18 Nov: a send during a dictation hands the audio over and goes at once
 * (Composer.tsx, chat.send with `dictation: {handOff: true}`); the computer writes the take down and replaces the message.
 */
import type { DictationView } from '@agent/core'

const ACTIVE = ['starting', 'listening', 'finishing', 'cleaning']

/** Whether a dictation for [chat]'s box is running or being written down. */
export function dictatingFor(view: DictationView | null, chat: string): boolean {
  return view !== null && view.chat === chat && ACTIVE.includes(view.phase)
}
