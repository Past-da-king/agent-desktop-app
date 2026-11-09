import type { WorkerInfo } from '@agent/core'

export interface WorkersSnapshot {
  workers: WorkerInfo[]
  loaded: boolean
  /** Why the list could not be read; empty when the last read worked. */
  error: string
}

/** The part of the bridge the store needs, so a test can hand it a fake. */
export interface WorkersSource {
  list(): Promise<WorkerInfo[]>
  onChange(cb: () => void): () => void
}

export interface WorkersStore {
  get(): WorkersSnapshot
  subscribe(listener: () => void): () => void
  reload(): void
}

/** "Last heard 3 min ago" moves on its own; one slow refresh for the whole window keeps it honest. */
export const WORKERS_REFRESH_MS = 20_000

/**
 * One list of workers for the whole window. Every screen that shows workers (the Routines page, each card, Home's
 * "Needs you") used to keep its own copy, its own change listener and its own 20 second timer, so one change was
 * four reads of the same list. Here the list is read once per change and shared, only while something shows it.
 */
export function createWorkersStore(source: WorkersSource, refreshMs = WORKERS_REFRESH_MS): WorkersStore {
  let snapshot: WorkersSnapshot = { workers: [], loaded: false, error: '' }
  const listeners = new Set<() => void>()
  let off: (() => void) | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let reads = 0

  const set = (next: WorkersSnapshot): void => {
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  const read = (): void => {
    const mine = ++reads
    source
      .list()
      .then((list) => {
        // A slower, older answer must not overwrite a newer one.
        if (mine === reads) set({ workers: list, loaded: true, error: '' })
      })
      .catch((cause: unknown) => {
        if (mine !== reads) return
        set({ workers: snapshot.workers, loaded: true, error: cause instanceof Error ? cause.message : 'Could not read the workers.' })
      })
  }

  return {
    get: () => snapshot,
    reload: read,
    subscribe(listener) {
      listeners.add(listener)
      if (listeners.size === 1) {
        read()
        off = source.onChange(read)
        timer = setInterval(read, refreshMs)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        off?.()
        off = null
        if (timer !== null) clearInterval(timer)
        timer = null
        // Answers still on their way belong to nobody now.
        reads += 1
      }
    },
  }
}
