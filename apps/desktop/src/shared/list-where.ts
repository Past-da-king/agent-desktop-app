/**
 * A ListWhere applied to rows already in memory: the same answer Store.listWhere reads by index, for a store or a
 * bridge that has no indexed query (a small fake in tests, the mock window, an older computer over the link).
 * Rows are taken in the store's order (created-at); the result keeps it, newest first only when asked.
 */
import { MAIN_CHAT, type ListWhere } from '@agent/core'

/** A chat row's chat: rows with no tag belong to the first chat. */
export function chatOfRow(row: Record<string, unknown>): string {
  const meta = row['meta']
  if (typeof meta !== 'string' || !meta.includes('"chat"')) return MAIN_CHAT
  try {
    const parsed: unknown = JSON.parse(meta)
    const chat = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['chat'] : undefined
    return typeof chat === 'string' && chat !== '' ? chat : MAIN_CHAT
  } catch {
    return MAIN_CHAT
  }
}

export function filterRows<R>(input: readonly R[], where: ListWhere): R[] {
  let rows = input as unknown as Array<Record<string, unknown>>
  if (where.kinds !== undefined && where.kinds.length === 0) return []
  if (where.statuses !== undefined && where.statuses.length === 0) return []
  if (where.kind !== undefined && where.kinds !== undefined && !where.kinds.includes(where.kind)) return []
  if (where.thread !== undefined) rows = rows.filter((row) => row['thread'] === where.thread)
  if (where.kind !== undefined) rows = rows.filter((row) => row['kind'] === where.kind)
  if (where.kinds !== undefined) {
    const kinds = new Set(where.kinds)
    rows = rows.filter((row) => kinds.has(String(row['kind'])))
  }
  if (where.exceptKinds !== undefined && where.exceptKinds.length > 0) {
    const except = new Set(where.exceptKinds)
    rows = rows.filter((row) => !except.has(String(row['kind'])))
  }
  if (where.statuses !== undefined) {
    const statuses = new Set(where.statuses)
    rows = rows.filter((row) => statuses.has(String(row['status'])))
  }
  if (where.contains !== undefined && where.contains !== '') {
    const text = where.contains
    rows = rows.filter((row) => {
      const { id: _id, ...payload } = row
      return JSON.stringify(payload).includes(text)
    })
  }
  if (where.chat !== undefined) {
    const chat = where.chat === '' ? MAIN_CHAT : where.chat
    rows = rows.filter((row) => chatOfRow(row) === chat)
  }
  if (where.since !== undefined && where.since > 0) rows = rows.filter((row) => Number(row['createdAt']) > (where.since ?? 0))
  if (where.newestFirst === true) rows = [...rows].reverse()
  if (where.limit !== undefined && where.limit > 0) rows = rows.slice(0, Math.floor(where.limit))
  return rows as unknown as R[]
}
