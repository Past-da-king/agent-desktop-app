import type { EntityMap, EntityName } from '@agent/core'
import { useEffect } from 'react'
import { create } from 'zustand'

import { agent } from '../bridge'

type RowStore = { [E in EntityName]: Array<EntityMap[E]> }

function emptyRows(): RowStore {
  return { chat_item: [], turn: [], memory: [], goal: [], task: [], trigger: [] }
}

function emptyFlags(): Record<EntityName, boolean> {
  return { chat_item: false, turn: false, memory: false, goal: false, task: false, trigger: false }
}

interface DataState {
  rows: RowStore
  loaded: Record<EntityName, boolean>
  loading: Record<EntityName, boolean>
  errors: Partial<Record<EntityName, string>>
  load: <E extends EntityName>(entity: E) => Promise<void>
}

let subscribed = false
/** A change that arrived while that list was loading: read it again once the load ends, or the change is missed. */
const again = new Set<EntityName>()

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  agent.data.onChanged((entity) => {
    void useData.getState().load(entity)
  })
}

export const useData = create<DataState>((set, get) => ({
  rows: emptyRows(),
  loaded: emptyFlags(),
  loading: emptyFlags(),
  errors: {},

  load: async <E extends EntityName>(entity: E) => {
    subscribeOnce()
    if (get().loading[entity]) {
      again.add(entity)
      return
    }
    set((state) => ({ loading: { ...state.loading, [entity]: true } }))
    try {
      const rows: Array<EntityMap[E]> = await agent.data.list(entity)
      set((state) => {
        const nextRows: RowStore = { ...state.rows }
        nextRows[entity] = rows as unknown as RowStore[E]
        return {
          rows: nextRows,
          loaded: { ...state.loaded, [entity]: true },
          loading: { ...state.loading, [entity]: false },
          errors: { ...state.errors, [entity]: undefined },
        }
      })
    } catch (error) {
      set((state) => ({
        loading: { ...state.loading, [entity]: false },
        errors: {
          ...state.errors,
          [entity]: error instanceof Error ? error.message : 'Could not read local data.',
        },
      }))
    }
    if (again.delete(entity)) void get().load(entity)
  },
}))

export function useEntity<E extends EntityName>(entity: E): Array<EntityMap[E]> {
  const rows = useData((state) => state.rows[entity])
  const loaded = useData((state) => state.loaded[entity])

  useEffect(() => {
    if (!loaded) void useData.getState().load(entity)
  }, [entity, loaded])

  return rows
}

export function useEntityLoaded(entity: EntityName): boolean {
  return useData((state) => state.loaded[entity])
}

export function refreshEntity(entity: EntityName): void {
  void useData.getState().load(entity)
}
