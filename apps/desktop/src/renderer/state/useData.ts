import type { DataChange, EntityMap, EntityName } from '@agent/core'
import { useEffect, useState } from 'react'
import { create } from 'zustand'

import { agent } from '../bridge'
import { patched, patchedMany } from '../lib/patch'

type RowStore = { [E in EntityName]: Array<EntityMap[E]> }

function emptyRows(): RowStore {
  return { chat_item: [], turn: [], memory: [], goal: [], task: [], trigger: [], project: [], device: [], device_command: [], turn_lease: [], job: [], prompt_rule: [], wakeup: [], miniapp: [] }
}

function emptyFlags(): Record<EntityName, boolean> {
  return { chat_item: false, turn: false, memory: false, goal: false, task: false, trigger: false, project: false, device: false, device_command: false, turn_lease: false, job: false, prompt_rule: false, wakeup: false, miniapp: false }
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

/**
 * Changes heard while a list is being read: applied to it once the read lands, instead of reading the whole list
 * again (28 Oct 2026: at start-up every write during the first read of 63,000 chat rows made the window read them all
 * a second time). Every write after the read began is here in order, so the last one per row wins.
 */
const heldWhileLoading = new Map<EntityName, DataChange[]>()

function hold(change: DataChange): void {
  const list = heldWhileLoading.get(change.entity)
  if (list === undefined) heldWhileLoading.set(change.entity, [change])
  else list.push(change)
}

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
    const loading = state.loading[change.entity]
    // A batch says which rows changed: applied like single changes, the list is not read again.
    if (change.reset === true && change.batch !== undefined) {
      for (const each of change.batch) (loading ? hold : (one: DataChange) => patches.push(one))(each)
      continue
    }
    // Being read now: kept and applied when the read lands.
    if (loading && change.reset !== true && (change.row !== undefined || change.id !== undefined)) {
      hold(change)
      continue
    }
    if (change.reset === true || (change.row === undefined && change.id === undefined) || loading) {
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
    heldWhileLoading.delete(entity)
    set((state) => ({ loading: { ...state.loading, [entity]: true } }))
    try {
      const rows: Array<EntityMap[E]> = await agent.data.list(entity)
      // What changed while it was read (held by flushChanges), applied on top in one pass.
      flushChanges()
      const held = heldWhileLoading.get(entity) ?? []
      heldWhileLoading.delete(entity)
      set((state) => {
        const nextRows: RowStore = { ...state.rows }
        const fresh = rows as unknown as Array<{ id: string; createdAt: number }>
        nextRows[entity] = (held.length === 0 ? fresh : patchedMany(fresh, held)) as unknown as RowStore[E]
        return {
          rows: nextRows,
          loaded: { ...state.loaded, [entity]: true },
          loading: { ...state.loading, [entity]: false },
          errors: { ...state.errors, [entity]: undefined },
        }
      })
    } catch (error) {
      heldWhileLoading.delete(entity)
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
      const perEntity = new Map<EntityName, DataChange[]>()
      for (const change of changes) {
        const list = perEntity.get(change.entity)
        if (list === undefined) perEntity.set(change.entity, [change])
        else list.push(change)
      }
      // One pass per list however many rows changed (a helper's burst, a sync): never a copy of the list per row.
      for (const [entity, list] of perEntity) {
        const current = nextRows[entity] as Array<{ id: string; createdAt: number }>
        nextRows[entity] = list.length === 1 ? patched(current, list[0]!) : patchedMany(current, list)
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

/** How often a calm view follows its rows at most (useCalmEntity). */
export const CALM_MS = 400

/**
 * The rows of an entity for a view off to the side (the helpers panel, the rail, Needs you, Home, a project page):
 * it follows changes at most once per `ms`, and the last change always shows. Each of these walks every chat row
 * to work out its cards; with a dozen helpers writing steps that happened dozens of times a second and the window
 * stopped answering (30 Oct 2026). The open chat keeps useEntity and follows every change.
 */
export function useCalmEntity<E extends EntityName>(entity: E, ms = CALM_MS): Array<EntityMap[E]> {
  const [rows, setRows] = useState(() => useData.getState().rows[entity])
  const loaded = useData((state) => state.loaded[entity])
  useEffect(() => {
    if (!loaded) void useData.getState().load(entity)
  }, [entity, loaded])
  useEffect(() => {
    let last = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    const push = (): void => {
      timer = null
      last = Date.now()
      setRows(useData.getState().rows[entity])
    }
    push()
    const off = useData.subscribe((state, prev) => {
      if (state.rows[entity] === prev.rows[entity] || timer !== null) return
      const wait = ms - (Date.now() - last)
      if (wait <= 0) push()
      else timer = setTimeout(push, wait)
    })
    return () => {
      off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [entity, ms])
  return rows
}

export function useEntityLoaded(entity: EntityName): boolean {
  return useData((state) => state.loaded[entity])
}

export function refreshEntity(entity: EntityName): void {
  void useData.getState().load(entity)
}
