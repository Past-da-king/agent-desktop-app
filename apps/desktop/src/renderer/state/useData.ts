import type { DataChange, EntityMap, EntityName } from '@agent/core'
import { useEffect } from 'react'
import { create } from 'zustand'

import { agent } from '../bridge'
import { patched } from '../lib/patch'

type RowStore = { [E in EntityName]: Array<EntityMap[E]> }

function emptyRows(): RowStore {
  return { chat_item: [], turn: [], memory: [], goal: [], task: [], trigger: [], project: [], device: [], device_command: [], turn_lease: [], job: [], prompt_rule: [] }
}

function emptyFlags(): Record<EntityName, boolean> {
  return { chat_item: false, turn: false, memory: false, goal: false, task: false, trigger: false, project: false, device: false, device_command: false, turn_lease: false, job: false, prompt_rule: false }
}

interface DataState {
  rows: RowStore
  loaded: Record<EntityName, boolean>
  loading: Record<EntityName, boolean>
  errors: Partial<Record<EntityName, string>>
  load: <E extends EntityName>(entity: E) => Promise<void>
  /** One row changed: the list is patched in place, in its order, without reading it all again. */
  patch: (change: DataChange) => void
  /** Several rows changed: every list is patched in one store update. */
  patchMany: (changes: DataChange[]) => void
}

let subscribed = false
/** A change that arrived while that list was loading: read it again once the load ends, or the change is missed. */
const again = new Set<EntityName>()

/**
 * Changes that arrived since the last frame. A helper at work, replication and the devices feed send rows in bursts;
 * each change applied on its own would redraw every screen that lists rows once per row, so they are applied
 * together, one store update (one redraw) per frame at most.
 */
let pending: DataChange[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
export const DATA_BATCH_MS = 16

function hear(change: DataChange): void {
  const state = useData.getState()
  // A list not on screen yet is read whole when something first asks for it.
  if (!state.loaded[change.entity] && !state.loading[change.entity]) return
  pending.push(change)
  if (flushTimer === null) flushTimer = setTimeout(flushChanges, DATA_BATCH_MS)
}

/** Applies every change heard since the last flush in one store update (exported for tests). */
export function flushChanges(): void {
  if (flushTimer !== null) clearTimeout(flushTimer)
  flushTimer = null
  const changes = pending
  pending = []
  const state = useData.getState()
  const reload = new Set<EntityName>()
  const patches: DataChange[] = []
  for (const change of changes) {
    if (reload.has(change.entity)) continue
    if (change.reset === true || (change.row === undefined && change.id === undefined) || state.loading[change.entity]) {
      reload.add(change.entity)
      continue
    }
    patches.push(change)
  }
  // A list that is read whole again needs none of its single changes.
  const kept = patches.filter((change) => !reload.has(change.entity))
  if (kept.length > 0) state.patchMany(kept)
  for (const entity of reload) {
    again.add(entity)
    if (!state.loading[entity]) void state.load(entity)
  }
}

function subscribeOnce(): void {
  if (subscribed) return
  subscribed = true
  agent.data.onChanged(hear)
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

  patch: (change) => get().patchMany([change]),

  patchMany: (changes) => {
    if (changes.length === 0) return
    set((state) => {
      const nextRows = { ...state.rows } as Record<EntityName, unknown[]>
      for (const change of changes) {
        const current = nextRows[change.entity] as Array<{ id: string; createdAt: number }>
        nextRows[change.entity] = patched(current, change)
      }
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
