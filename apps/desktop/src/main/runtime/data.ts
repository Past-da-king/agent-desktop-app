/**
 * The slice of the local Store the runtime and the tools need. Keeping it structural means tests can
 * use the real Store (they do) or a small fake, without importing anything from Electron.
 */
import type { EntityMap, EntityName, MemoryVersion, RowInput } from '@agent/core'

export interface DataStore {
  list<E extends EntityName>(entity: E): Promise<Array<EntityMap[E]>>
  get<E extends EntityName>(entity: E, id: string): Promise<EntityMap[E] | null>
  upsert<E extends EntityName>(entity: E, input: RowInput<E>): Promise<EntityMap[E]>
  remove(entity: EntityName, id: string): Promise<void>
  /** A memory page's kept versions, newest first (the real Store keeps them; a small fake may not). */
  memoryHistory?(memoryId: string): MemoryVersion[]
}
