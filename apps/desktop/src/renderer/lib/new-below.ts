/**
 * The "new messages" pill of the chat: what counts as a message the person would want to jump down to. A chat holds
 * far more rows than messages (tool steps, helper cards and their steps, notices, dividers, approval and question
 * cards, branch markers), and a row changes many times while it is worked on, so the count goes by row kind and by
 * row id, never by how many rows or changes arrived. Pure, so the view and the test share one definition.
 */
import type { ChatItem } from '@agent/core'

import { metaOf } from './meta'

/** Row kinds that are a message somebody said or sent: the person's own, and the agent's replies. */
const MESSAGE_KINDS: ReadonlySet<string> = new Set(['user', 'agent', 'report', 'voice_note', 'media'])

/** Whether a row is a message the person reads as one: his own, or a reply (text, a report, a voice note, media). */
export function isMessageRow(item: ChatItem): boolean {
  if (!MESSAGE_KINDS.has(item.kind)) return false
  const meta = metaOf(item)
  // A helper's own lines live inside its card, not in the conversation.
  const helper = meta['helper']
  if (typeof helper === 'string' && helper !== '') return false
  // An empty reply row draws nothing (a visual from a call is the exception: it has its own card).
  if (item.kind === 'agent' && item.text.trim() === '' && meta['visual'] === undefined) return false
  return true
}

/**
 * How many messages arrived since the person left the bottom of the chat. `seen` holds the id of every row that was
 * there when they scrolled up. A row that was there and changed since (a step that finished, a card that was
 * answered) is not new, and neither is any row that is not a message.
 */
export function countNewMessages(items: readonly ChatItem[], seen: ReadonlySet<string>): number {
  const counted = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id) || counted.has(item.id)) continue
    if (isMessageRow(item)) counted.add(item.id)
  }
  return counted.size
}

/** The pill's words: the count when there is one, else just the way down. */
export function newBelowLabel(count: number): string {
  if (count <= 0) return 'Jump to latest'
  return count === 1 ? '1 new message' : `${count} new messages`
}
