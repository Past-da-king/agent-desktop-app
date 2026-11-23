/**
 * When a card stops standing by itself (23 Nov 2026).
 *
 * Today he hit two: an X card still asking him to buy credits after he had bought them, and a folder question still
 * showing after the redeploy. Both sat in project chats whose asking run had long moved on. The cards were still
 * "open" because only an answer or a dismiss ever closed a card, and nothing noticed that the question no longer had
 * anyone waiting for it. A card stands only while something is waiting on its answer or the conversation has not
 * moved past it.
 *
 *   waiting       a run in this app (or one placed elsewhere and still running) is waiting on it: it stands
 *   replaced      a newer card from the same asker of the same kind: the old one is superseded
 *   run-ended     the asking helper is finished, failed or stopped, or the chat's run is gone for a long time
 *   answered      he wrote in that chat after the card appeared (answered in chat), or another device answered
 *                 (that one is already a decision on the row and never reaches here)
 *   already-done  the asking agent carried on past it (a later step or message in its chat or helper): what it asked
 *                 for already happened, or it no longer needs the answer
 *
 * Pure: the caller gathers the facts. Nothing here reads a store.
 */

export type StaleReason = 'replaced' | 'run-ended' | 'answered-elsewhere' | 'already-done'

export interface StaleFacts {
  /** A run here, or one placed elsewhere and still running, is waiting for this card's answer. */
  hasWaiter: boolean
  /** The asker lives on another computer that is up: its card is that computer's to judge. */
  askerElsewhere: boolean
  /** A helper card: the helper row's state ('working', 'done', ...), or null when the helper row is gone. Undefined: not a helper's card. */
  helperState?: string | null
  helperLive: boolean
  /** Rows in the card's chat after the card (cards and the helper's own bookkeeping left out). */
  chatNewer: { user: boolean; agent: boolean }
  /** Steps the asking helper took after the card. */
  helperProgressed: boolean
  /** A newer card (any state) from the same asker of the same kind. */
  newerCard: boolean
  chatRunning: boolean
  now: number
  createdAt: number
}

export interface StaleVerdict {
  reason: StaleReason
  why: string
}

/** A card must be this old before it can go stale (a waiter is registered and shown before this, never after). */
export const STALE_GRACE_MS = 20_000
/** A card of a chat with no run and nothing since, after a restart: it can still be answered, so it waits this long. */
export const STALE_IDLE_MS = 2 * 60 * 60_000

export function staleReason(facts: StaleFacts): StaleVerdict | null {
  if (facts.hasWaiter || facts.askerElsewhere) return null
  if (facts.now - facts.createdAt < STALE_GRACE_MS) return null
  if (facts.newerCard) return { reason: 'replaced', why: 'A newer card from the same asker replaced it.' }
  if (facts.helperState !== undefined) {
    const ended = facts.helperState === null || ['done', 'failed', 'stopped'].includes(facts.helperState)
    if (ended && !facts.helperLive) return { reason: 'run-ended', why: 'The helper that asked has finished, so nothing is waiting for this.' }
    if (facts.helperProgressed) return { reason: 'already-done', why: 'The helper carried on past this, so what it asked for already happened.' }
    return null
  }
  if (facts.chatNewer.user) return { reason: 'answered-elsewhere', why: 'You wrote in that chat after it appeared, so it was answered there.' }
  if (facts.chatNewer.agent) return { reason: 'already-done', why: 'The agent carried on in that chat, so what it asked for already happened.' }
  if (!facts.chatRunning && facts.now - facts.createdAt >= STALE_IDLE_MS) return { reason: 'run-ended', why: 'Nothing has been waiting for this for hours.' }
  return null
}
