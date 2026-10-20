import type { Attachment, ChatItem } from '@agent/core'

import { short } from './format'
import { metaText, parseMeta } from './meta'

/** The conversation, oldest first. Branch markers and Home-only cards are not part of the thread. */
export function threadItems(items: ChatItem[]): ChatItem[] {
  return items
    .filter((item) => item.kind !== 'branch')
    .filter((item) => !(item.kind === 'question' && parseMeta(item.meta)['context'] === 'home'))
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** A notice that starts a fresh stretch of conversation without deleting the history above it. */
export function isDivider(item: ChatItem): boolean {
  return item.kind === 'notice' && parseMeta(item.meta)['divider'] === true
}

/** The chat header: the newest stretch after a divider, else the active branch's title. */
export function threadTitle(items: ChatItem[], fallback = 'New chat'): string {
  const thread = threadItems(items)
  let start = 0
  thread.forEach((item, index) => {
    if (isDivider(item)) start = index + 1
  })
  if (start > 0) {
    const firstAfter = thread.slice(start).find((item) => item.kind === 'user')
    return firstAfter ? short(firstAfter.text, 42) : fallback
  }
  const branches = items.filter((item) => item.kind === 'branch')
  const active = branches.find((item) => parseMeta(item.meta)['active'] === true) ?? branches[0]
  if (active) {
    const title = metaText(parseMeta(active.meta), 'title')
    if (title !== '') return title
  }
  const firstUser = thread.find((item) => item.kind === 'user')
  return firstUser ? short(firstUser.text, 42) : fallback
}

/** Files the person attached to a message. Old mock rows store only a count, so they have none. */
export function attachmentsOf(item: ChatItem): Attachment[] {
  const value = parseMeta(item.meta)['attachments']
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    if (typeof row['name'] !== 'string' || row['name'] === '') return []
    return [
      {
        path: typeof row['path'] === 'string' ? row['path'] : '',
        name: row['name'],
        mime: typeof row['mime'] === 'string' ? row['mime'] : '',
      },
    ]
  })
}
