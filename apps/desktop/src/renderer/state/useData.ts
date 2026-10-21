import type { DataChange, EntityMap, EntityName } from '@agent/core'
import { useEffect } from 'react'
import { create } from 'zustand'

import { agent } from '../bridge'
import { patched } from '../lib/patch'

type RowStore = { [E in EntityName]: Array<EntityMap[E]> }

function emptyRows(): RowStore {
  return { chat_item: [], turn: [], memory: [], goal: [], task: [], trigger: [], project: [], device: [], device_command: [], turn_lease: [] }
}

function emptyFlags(): Record<EntityName, boolean> {
  return { chat_item: false, turn: false, memory: false, goal: false, task: false, trigger: false, project: false, device: false, device_command: false, turn_lease: false }
}

interface DataState {
  rows: RowStore
  loaded: Record<EntityName, boolean>
  loading: Record<EntityName, boolean>
  errors: Partial<Record<EntityName, string>>
  load: <E extends EntityName>(entity: E) => Promise<void>
  /** One row changed: the list is patched in place, in its order, without reading it all again. */
  patch: (change: DataChange) => void
}

let subscribed = false
/** A change that arrived while that list was loading: read it again once the load ends, or the change is missed. */
const again = new Set<EntityName>()

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  agent.data.onChanged((change) => {
    const state = useData.getState()
    // A list not on screen yet is read whole when something first asks for it.
    if (!state.loaded[change.entity] && !state.loading[change.entity]) return
    if (change.reset === true || (change.row === undefined && change.id === undefined) || state.loading[change.entity]) {
      again.add(change.entity)
      if (!state.loading[change.entity]) void state.load(change.entity)
      return
    }
    state.patch(change)
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

  patch: (change) => {
    set((state) => {
      const nextRows = { ...state.rows } as Record<EntityName, unknown[]>
      const current = state.rows[change.entity] as Array<{ id: string; createdAt: number }>
      nextRows[change.entity] = patched(current, change)
      return { rows: nextRows as unknown as RowStore }
    })
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
