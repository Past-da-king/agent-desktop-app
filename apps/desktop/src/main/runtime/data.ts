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
  upsert<E extends EntityName>(entity: E, input: RowInput<E>): Promise<EntityMap[E]>
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
