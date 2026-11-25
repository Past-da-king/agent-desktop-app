import { redactSecrets } from '../logger'
import type { DataStore } from './data'
import { chatOf, parseMeta, newestOfChat } from './chat-lines'
import type { RequestSource } from '../../shared/request-source'

/** Resolve an app-recorded id to the actual person's row. Briefs, summaries and tool results never count. */
export async function requestById(store: DataStore, id: string): Promise<RequestSource | null> {
  if (id === '') return null
  const row = await store.get('chat_item', id)
  if (row === null || row.kind !== 'user' || parseMeta(row.meta)['via'] !== undefined) return null
  return { id: row.id, at: row.createdAt, text: redactSecrets(row.text) }
}

/** Bind once when handing off. A child uses its parent's binding, never the newest unrelated user message. */
export async function requestFor(store: DataStore, chat: string, helper = ''): Promise<RequestSource | null> {
  if (helper !== '') {
    const row = await store.get('chat_item', helper)
    if (row === null || row.kind !== 'helper') return null
    const id = parseMeta(row.meta)['requestId']
    return typeof id === 'string' ? requestById(store, id) : null
  }
  const rows = await newestOfChat(store, chat, ['user'], 1)
  const row = rows.find((item) => chatOf(item) === chat)
  if (row === undefined) return null
  const via = parseMeta(row.meta)['via']
  if (via === undefined) return requestById(store, row.id)
  const id = typeof via === 'object' && via !== null ? (via as Record<string, unknown>)['requestId'] : undefined
  return typeof id === 'string' ? requestById(store, id) : null
}

/** Resolve the accepted row itself, including an app-owned forwarded request reference. */
export async function requestFromMessage(store: DataStore, id: string): Promise<RequestSource | null> {
  const row = await store.get('chat_item', id)
  if (row === null || row.kind !== 'user') return null
  const via = parseMeta(row.meta)['via']
  if (via === undefined) return requestById(store, id)
  const original = typeof via === 'object' && via !== null ? (via as Record<string, unknown>)['requestId'] : undefined
  return typeof original === 'string' ? requestById(store, original) : null
}
