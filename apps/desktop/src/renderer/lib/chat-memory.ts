import type { ChatItem } from '@agent/core'

import { parseMeta } from './meta'

export interface Note {
  status: 'saving' | 'done' | 'failed'
  saved: string[]
  error: string
}

/** The filing note a New chat divider carries (main/memory/service.ts), or null for a plain divider. */
export function dividerNote(item: ChatItem): Note | null {
  const value = parseMeta(item.meta)['memory']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const note = value as Record<string, unknown>
  const status = note['status']
  if (status !== 'saving' && status !== 'done' && status !== 'failed') return null
  return {
    status,
    saved: Array.isArray(note['saved']) ? note['saved'].filter((id): id is string => typeof id === 'string') : [],
    error: typeof note['error'] === 'string' ? note['error'] : '',
  }
}

/** The words on the note. Exported for tests. */
export function noteLine(note: Note): string {
  if (note.status === 'saving') return 'Saving the last chat to memory'
  if (note.status === 'failed') return 'Could not save the last chat to memory'
  const count = note.saved.length
  if (count === 0) return 'Nothing in the last chat needed remembering'
  return `Saved ${count} ${count === 1 ? 'memory' : 'memories'} from the last chat`
}

/** A card still waiting for the person: it stays on screen whatever chat it started in. */
function stillOpen(item: ChatItem): boolean {
  const meta = parseMeta(item.meta)
  if (item.kind === 'question') return typeof meta['answer'] !== 'string' || meta['answer'] === ''
  if (item.kind === 'approval') return typeof meta['decision'] !== 'string' || meta['decision'] === ''
  return false
}

/**
 * What the chat screen shows: New chat clears it, so only the newest chat (from its divider on) is drawn, plus any
 * card from before that still needs an answer. `earlier` is how many older rows are hidden; nothing is deleted.
 */
export function visibleThread(messages: ChatItem[], showEarlier: boolean): { rows: ChatItem[]; earlier: number } {
  let start = -1
  messages.forEach((item, index) => {
    if (item.kind === 'notice' && parseMeta(item.meta)['divider'] === true) start = index
  })
  if (start <= 0 || showEarlier) return { rows: messages, earlier: 0 }
  const before = messages.slice(0, start)
  const open = before.filter(stillOpen)
  return { rows: [...open, ...messages.slice(start)], earlier: before.length - open.length }
}


/** How many rows of the newest stretch the thread draws at first; the rest are a tap away, in steps. */
export const THREAD_WINDOW = 80
export const THREAD_STEP = 200

/**
 * The thread draws only its newest rows, so a long conversation scrolls and updates at the same speed as a
 * short one. Rows above the window are hidden (`above`), never dropped; a card still waiting on the person is
 * kept whatever its place.
 */
export function windowThread(rows: ChatItem[], limit: number): { rows: ChatItem[]; above: number } {
  if (rows.length <= limit) return { rows, above: 0 }
  const start = rows.length - limit
  const kept = rows.slice(0, start).filter(stillOpen)
  return { rows: [...kept, ...rows.slice(start)], above: start - kept.length }
}
