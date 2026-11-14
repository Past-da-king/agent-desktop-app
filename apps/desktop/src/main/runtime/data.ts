/**
 * The slice of the local Store the runtime and the tools need. Keeping it structural means tests can
 * use the real Store (they do) or a small fake, without importing anything from Electron.
 */
import { type EntityMap, type EntityName, type ListWhere, type MemoryVersion, type RowInput } from '@agent/core'

import { filterRows } from '../../shared/list-where'

export interface DataStore {
  list<E extends EntityName>(entity: E): Promise<Array<EntityMap[E]>>
  /** The rows that match, read inside the database (the real Store); a small fake may leave it out. */
  listWhere?<E extends EntityName>(entity: E, where: ListWhere): Promise<Array<EntityMap[E]>>
  get<E extends EntityName>(entity: E, id: string): Promise<EntityMap[E] | null>
  /**
   * Writes the fields given over the row's current ones. A row that was deleted is NOT brought back (the real Store
   * throws RowDeletedError); `restore: true` is the one way to bring it back.
   */
  upsert<E extends EntityName>(entity: E, input: RowInput<E>, options?: { restore?: boolean }): Promise<EntityMap[E]>
  remove(entity: EntityName, id: string): Promise<void>
  /** A memory page's kept versions, newest first (the real Store keeps them; a small fake may not). */
  memoryHistory?(memoryId: string): MemoryVersion[]
}

/**
 * The rows that match, through the store's own indexed query when it has one, else the whole list filtered here
 * (a fake store in tests). Either way the caller never parses rows it does not need.
 */
export async function listWhere<E extends EntityName>(store: DataStore, entity: E, where: ListWhere): Promise<Array<EntityMap[E]>> {
  if (store.listWhere !== undefined) return store.listWhere(entity, where)
  return filterRows(await store.list(entity), where)
}

/**
 * Updates a row that is still there, from the row as it is NOW, and never writes a stale copy back: `change` gets the
 * current row and returns only the fields to set (null: write nothing). A row that is gone, deleted while this
 * waited, or deleted between the read and the write, is left alone: the result is null. The general form of "a
 * run or a worker finished; record it" so that a delete or a pause made meanwhile is never undone.
 */
export async function updateLive<E extends EntityName>(
  store: DataStore,
  entity: E,
  id: string,
  change: (current: EntityMap[E]) => Partial<EntityMap[E]> | null,
): Promise<EntityMap[E] | null> {
  const current = await store.get(entity, id)
  if (current === null) return null
  const patch = change(current)
  if (patch === null) return current
  try {
    return await store.upsert(entity, { ...patch, id } as RowInput<E>)
  } catch (error) {
    if (error instanceof Error && error.name === 'RowDeletedError') return null
    throw error
  }
}

/**
 * Runs a write to a row that was read earlier and drops it, quietly, when the row has been deleted since (the store
 * refuses to bring a deleted row back). Anything else the write throws still throws.
 */
export async function ifStillThere<T>(write: Promise<T>): Promise<T | null> {
  try {
    return await write
  } catch (error) {
    if (error instanceof Error && error.name === 'RowDeletedError') return null
    throw error
  }
}
