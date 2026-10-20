import type { ChatItem } from '@agent/core'

import { parseMeta } from './meta'

export function isOpenCard(item: ChatItem): boolean {
  if (item.kind !== 'question' && item.kind !== 'approval') return false
  const meta = parseMeta(item.meta)
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
    .filter((item) => !forChat || parseMeta(item.meta)['context'] !== 'home')
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
    .filter((item) => !forChat || parseMeta(item.meta)['context'] !== 'home')
    .sort((a, b) => a.createdAt - b.createdAt)
}
