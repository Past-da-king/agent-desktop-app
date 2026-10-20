/**
 * Drives sync for one device: push what is new locally, pull what is new remotely, apply, repeat.
 * Port of reference/kotlin-shared/sync/SyncEngine.kt, with the desktop's long-poll loop.
 *
 * Offline-first: everything works with no network; when the service is reachable again the next pass
 * reconciles. Passes are serialised by a mutex so a manual "sync now", a nudge and the long-poll loop
 * never overlap. After the first pass the loop holds a long-poll open, so a change made on another
 * device shows up within about a second.
 */
import type { SyncStatus } from '../ipc'
import type { Change } from './change'
import { SyncClient, SyncException } from './client'
import { compareStamps, decodeStamp, type HlcStamp } from './hlc'
import type { SyncStore } from './store'

export type SyncStatusListener = (status: SyncStatus) => void
export type AppliedListener = (changes: Change[]) => void | Promise<void>

export interface SyncEngineOptions {
  /** Called after remote changes are applied, so the UI reloads. */
  onApplied?: AppliedListener
  /** Also accepted through `onStatus`; kept here for construction-time wiring. */
  onStatus?: SyncStatusListener
  /** Long-poll window in seconds. The service caps it at 55. */
  pollWaitSeconds?: number
  /** A local write calls nudge(); it batches pushes for this long. */
  nudgeMs?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  now?: () => number
}

const DEFAULT_POLL_WAIT_SECONDS = 25

export class SyncEngine {
  private readonly store: SyncStore
  private readonly client: () => SyncClient | null
  private readonly options: SyncEngineOptions
  private readonly listeners = new Set<SyncStatusListener>()

  private current: SyncStatus = {
    signedIn: false,
    syncing: false,
    lastSyncedAt: null,
    error: null,
    pendingPush: 0,
  }

  private lockTail: Promise<void> = Promise.resolve()
  private started = false
  private stopController: AbortController | null = null
  private pullController: AbortController | null = null
  private loopRun: Promise<void> | null = null
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null
  private wakeDelay: (() => void) | null = null
  private nudgeAbort = false

  constructor(store: SyncStore, client: () => SyncClient | null, options: SyncEngineOptions = {}) {
    this.store = store
    this.client = client
    this.options = options
    if (options.onStatus !== undefined) this.listeners.add(options.onStatus)
  }

  /** What the UI shows about sync. */
  status(): SyncStatus {
    return { ...this.current }
  }

  onStatus(callback: SyncStatusListener): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  markSignedIn(signedIn: boolean): void {
    this.setStatus({ signedIn })
  }

  /**
   * One full pass, without a long poll. Safe to call at any time; false when it could not reach the service.
   * A loop that is holding a long poll is interrupted first, so a manual sync or onboarding pass never
   * waits for the 25 s window to expire.
   */
  syncOnce(): Promise<boolean> {
    this.pullController?.abort()
    return this.withLock(() => this.pass(0))
  }

  /** Start the long-poll loop. Idempotent. */
  start(): void {
    if (this.started) return
    const controller = new AbortController()
    this.started = true
    this.stopController = controller
    this.loopRun = this.runLoop(controller).catch(() => undefined)
  }

  stop(): void {
    this.started = false
    if (this.nudgeTimer !== null) {
      clearTimeout(this.nudgeTimer)
      this.nudgeTimer = null
    }
    this.pullController?.abort()
    this.pullController = null
    this.stopController?.abort()
    this.stopController = null
    const wake = this.wakeDelay
    this.wakeDelay = null
    wake?.()
    this.loopRun = null
    this.setStatus({ syncing: false })
  }

  /** Call after a local write. Debounced: a burst of writes becomes one quick pass. */
  nudge(): void {
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer)
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null
      if (!this.started) {
        void this.syncOnce()
        return
      }
      this.nudgeAbort = true
      const wake = this.wakeDelay
      this.wakeDelay = null
      wake?.()
      this.pullController?.abort()
    }, this.options.nudgeMs ?? 300)
  }

  private async runLoop(controller: AbortController): Promise<void> {
    const initial = this.options.initialBackoffMs ?? 2_000
    const max = this.options.maxBackoffMs ?? 60_000
    const wait = this.options.pollWaitSeconds ?? DEFAULT_POLL_WAIT_SECONDS
    let backoff = initial

    while (this.stopController === controller && !controller.signal.aborted) {
      this.nudgeAbort = false
      const ok = await this.withLock(() => this.pass(wait, controller.signal))
      if (this.stopController !== controller || controller.signal.aborted) break
      if (ok) {
        backoff = initial
        continue
      }
      if (this.nudgeAbort) {
        this.nudgeAbort = false
        backoff = initial
        continue
      }
      await this.sleep(backoff)
      backoff = Math.min(backoff * 2, max)
    }
  }

  private async pass(waitSeconds: number, stop?: AbortSignal): Promise<boolean> {
    if (aborted(stop)) return false
    const client = this.client()
    if (client === null) {
      this.setStatus({ signedIn: false, syncing: false })
      return false
    }

    this.setStatus({ signedIn: true, syncing: true, error: null })
    try {
      const pending = await this.store.localChanges(await this.store.pushMark())
      this.setStatus({ pendingPush: pending.length })
      if (pending.length > 0) {
        await client.push(this.store.deviceId, pending, this.stopController?.signal ?? undefined)
        const newest = latestStamp(pending)
        if (newest !== null) await this.store.setPushMark(newest)
      }

      if (aborted(stop)) return false
      const controller = new AbortController()
      this.pullController = controller
      let pulled
      try {
        pulled = await client.pull(await this.store.cursor(), {
          wait: waitSeconds,
          signal: controller.signal,
        })
      } finally {
        if (this.pullController === controller) this.pullController = null
      }

      if (pulled.changes.length > 0) {
        await this.store.applyRemote(pulled.changes)
        if (this.options.onApplied !== undefined) {
          try {
            await this.options.onApplied(pulled.changes)
          } catch {
            // A UI reload failing must not turn a good sync into an error.
          }
        }
      }
      await this.store.setCursor(pulled.cursor)
      this.setStatus({
        syncing: false,
        lastSyncedAt: this.now(),
        pendingPush: 0,
        error: null,
      })
      return true
    } catch (error) {
      if (this.stopController?.signal.aborted === true || isAbort(error)) {
        this.setStatus({ syncing: false })
        return false
      }
      this.setStatus({
        syncing: false,
        error: messageFor(error),
        pendingPush: await this.countPending(),
      })
      return false
    }
  }

  private async countPending(): Promise<number> {
    try {
      return (await this.store.localChanges(await this.store.pushMark())).length
    } catch {
      return this.current.pendingPush
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.current = { ...this.current, ...patch }
    const snapshot = this.status()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Status listeners are UI code; one failing must not stop sync.
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const signal = this.stopController?.signal ?? null
      if (signal?.aborted === true) {
        resolve()
        return
      }
      let timer: ReturnType<typeof setTimeout>
      const done = (): void => {
        clearTimeout(timer)
        if (this.wakeDelay === done) this.wakeDelay = null
        signal?.removeEventListener('abort', done)
        resolve()
      }
      timer = setTimeout(done, ms)
      this.wakeDelay = done
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private withLock<T>(task: () => Promise<T>): Promise<T> {
    const result = this.lockTail.then(task)
    this.lockTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function latestStamp(changes: Change[]): string | null {
  let best: HlcStamp | null = null
  let stamp: string | null = null
  for (const change of changes) {
    const decoded = decodeStamp(change.stamp)
    if (decoded === null) continue
    if (best === null || compareStamps(decoded, best) > 0) {
      best = decoded
      stamp = change.stamp
    }
  }
  if (stamp !== null) return stamp
  const last = changes[changes.length - 1]
  return last?.stamp ?? null
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function messageFor(error: unknown): string {
  if (error instanceof SyncException) return error.message
  if (error instanceof Error) return error.message
  return 'sync failed'
}
