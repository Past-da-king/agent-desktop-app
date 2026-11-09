import { useSyncExternalStore } from 'react'

import { agent } from '../bridge'
import { createWorkersStore } from './workersStore'
import type { WorkersSnapshot, WorkersStore } from './workersStore'

let shared: WorkersStore | null = null
function store(): WorkersStore {
  shared ??= createWorkersStore(agent.workers)
  return shared
}
const subscribe = (listener: () => void): (() => void) => store().subscribe(listener)
const get = (): WorkersSnapshot => store().get()
const reload = (): void => store().reload()

/** The background workers, read again whenever the main process says something about them changed. */
export function useWorkers(): WorkersSnapshot & { reload: () => void } {
  const snapshot = useSyncExternalStore(subscribe, get)
  return { ...snapshot, reload }
}
