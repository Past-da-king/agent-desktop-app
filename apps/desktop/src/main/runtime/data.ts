/**
 * The slice of the local Store the runtime and the tools need. Keeping it structural means tests can
 * use the real Store (they do) or a small fake, without importing anything from Electron.
 */
import { MAIN_CHAT, type EntityMap, type EntityName, type ListWhere, type MemoryVersion, type RowInput } from '@agent/core'

export interface DataStore {
  list<E extends EntityName>(entity: E): Promise<Array<EntityMap[E]>>
  /** The rows that match, read inside the database (the real Store); a small fake may leave it out. */
  listWhere?<E extends EntityName>(entity: E, where: ListWhere): Promise<Array<EntityMap[E]>>
  get<E extends EntityName>(entity: E, id: string): Promise<EntityMap[E] | null>
  upsert<E extends EntityName>(entity: E, input: RowInput<E>): Promise<EntityMap[E]>
  remove(entity: EntityName, id: string): Promise<void>
  /** A memory page's kept versions, newest first (the real Store keeps them; a small fake may not). */
  memoryHistory?(memoryId: string): MemoryVersion[]
}

/** A chat row's chat, as the runtime reads it: rows with no tag belong to the first chat. */
function chatOfRow(row: Record<string, unknown>): string {
  const meta = row['meta']
  if (typeof meta !== 'string') return MAIN_CHAT
  try {
    const parsed: unknown = JSON.parse(meta)
    const chat = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)['chat'] : undefined
    return typeof chat === 'string' && chat !== '' ? chat : MAIN_CHAT
  } catch {
    return MAIN_CHAT
  }
}

/**
 * The rows that match, through the store's own indexed query when it has one, else the whole list filtered here
 * (a fake store in tests). Either way the caller never parses rows it does not need.
 */
export async function listWhere<E extends EntityName>(store: DataStore, entity: E, where: ListWhere): Promise<Array<EntityMap[E]>> {
  if (store.listWhere !== undefined) return store.listWhere(entity, where)
  let rows = (await store.list(entity)) as Array<Record<string, unknown> & EntityMap[E]>
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
  if (where.chat !== undefined) rows = rows.filter((row) => chatOfRow(row) === where.chat)
  if (where.since !== undefined && where.since > 0) rows = rows.filter((row) => Number(row['createdAt']) > (where.since ?? 0))
  if (where.newestFirst === true) rows = [...rows].reverse()
  if (where.limit !== undefined && where.limit > 0) rows = rows.slice(0, where.limit)
  return rows
}
