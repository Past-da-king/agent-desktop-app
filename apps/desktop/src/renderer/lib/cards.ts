import type { ChatItem } from '@agent/core'

import { metaOf } from './meta'

/**
 * What to tell the person when a card answer did not go through. A card someone else settled first (the other
 * device, a second tap) refuses with "already decided: approve by <device>": shown as it is, because the card
 * already shows what proceeded. Anything else is the plain "try again".
 */
export function cardFailText(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const found = /already (?:decided|answered): [^\n]{1,160}/i.exec(text)
  if (found === null) return 'That did not go through. Try again.'
  const said = found[0]
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}.`
}

export function isOpenCard(item: ChatItem): boolean {
  if (item.kind !== 'question' && item.kind !== 'approval') return false
  const meta = metaOf(item)
  if (item.kind === 'question') {
    const answer = meta['answer']
    return typeof answer !== 'string' || answer === ''
  }
  const decision = meta['decision']
  return decision !== 'approve' && decision !== 'decline'
}

/** Cards that need the person. `forChat` leaves out cards the mock marks as belonging to Home. */
export function openCards(items: ChatItem[], forChat = false): ChatItem[] {
  return items
    .filter(isOpenCard)
    .filter((item) => !forChat || metaOf(item)['context'] !== 'home')
    .sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * The rows the main process says are waiting. A card that was answered or decided since is left out,
 * even if the last `chat.state()` reading is a moment old.
 */
export function cardsForIds(items: ChatItem[], ids: string[], forChat = false): ChatItem[] {
  const waiting = new Set(ids)
  return items
    .filter((item) => waiting.has(item.id) && isOpenCard(item))
    .filter((item) => !forChat || metaOf(item)['context'] !== 'home')
    .sort((a, b) => a.createdAt - b.createdAt)
}
