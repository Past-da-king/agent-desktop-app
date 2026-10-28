/**
 * Turn leases, crash resume and failover (docs/devices-protocol.md s8).
 *
 * When a brain starts a turn (or a helper job) it writes a synced `turn_lease` row and beats its heartbeat every
 * 10 s; it marks the row done or failed at the end. So:
 *  - Crash resume (works with Devices off too): on start, this brain's own leases still `running` were cut off by
 *    a crash. Each becomes `interrupted` and is resumed once: the chat runs again from its saved transcript with a
 *    short note (it was interrupted, carry on, do not repeat what is done); a helper is sent back to work.
 *  - Failover: another brain takes over a `running` lease whose heartbeat is older than 45 s and whose brain fails
 *    its health check, but only if it is the highest-ranked healthy brain it knows. It bumps `attempt` and makes the
 *    lease its own.
 * At most 3 attempts; after that the lease is `failed` and the chat says so.
 */
import { randomUUID } from 'node:crypto'

import type { DeviceRow, TurnLeaseRow } from '@agent/core'

import { listWhere, type DataStore } from './data'
import { chatTag } from './chat-lines'

export const HEARTBEAT_MS = 10_000
export const STALE_MS = 45_000
export const MAX_ATTEMPTS = 3

export const RESUME_NOTE =
  '[System note: your previous run of this request was interrupted (the app stopped or the computer running it went away) before you finished. Carry on from where the transcript ends. Do not repeat side effects already done (messages sent, files written, things bought or booked); check first if unsure. Do not apologise at length.]'

export const GAVE_UP_NOTE = 'This was interrupted 3 times, so I stopped trying. Send it again if you still need it.'

/** What the runner and the helper manager call: nothing more than start and end. */
export interface LeaseHook {
  /** A turn or job starts. Returns the lease id. `id` resumes a lease that already exists. */
  begin(info: { kind: 'turn' | 'job'; chatId: string; messageId: string; prompt: string; id?: string }): string
  end(id: string, status: 'done' | 'failed'): void
  /** Resolves once the lease writes queued so far are stored (so other brains can see a turn the moment it starts). */
  settled?(): Promise<void>
  /** Will crash recovery send this lease's run back to work (it is this brain's, still running, attempts left)? */
  willResume?(id: string): Promise<boolean>
}

export interface TurnLeasesDeps {
  store: DataStore
  /** The id this brain writes into leases: its device id with Devices on, else this install's store id. */
  selfId: () => string
  /** Every id that has meant this brain (store id and device id), so a lease from before Devices was on is ours. */
  ownIds?: () => string[]
  /** Run a chat's turn again from its saved transcript, under the same lease. */
  resumeTurn: (chat: string, leaseId: string, note: string) => Promise<void> | void
  /** Send a helper back to work with a note. */
  resumeJob: (helperId: string, note: string) => Promise<void> | void
  /** Another brain took this lease over (we were thought dead, e.g. cut off from the others): stop our run of it. */
  lost?: (lease: TurnLeaseRow) => void
  /** A visible note in a chat. Default: a notice row in that chat. */
  notice?: (chat: string, text: string) => Promise<void> | void
  /** Is that brain up? Injectable for tests; the node passes a pinned /v1/health probe. */
  health?: (brain: DeviceRow) => Promise<{ up: boolean; ready: boolean }>
  /** The brains ranked best first (device rows with role brain, not revoked, by priority). */
  brains?: () => Promise<DeviceRow[]>
  /** Wait for this before recovering (the first replication pass, so a lease a peer already took is seen). */
  ready?: () => Promise<void>
  now?: () => number
  heartbeatMs?: number
  staleMs?: number
  watchMs?: number
  maxAttempts?: number
}

export interface Failover {
  health: NonNullable<TurnLeasesDeps['health']>
  brains: NonNullable<TurnLeasesDeps['brains']>
  ready?: TurnLeasesDeps['ready']
}

export class TurnLeases implements LeaseHook {
  private readonly beats = new Map<string, ReturnType<typeof setInterval>>()
  /**
   * Leases this process began. Recovery never takes one of these for a crash leftover: a turn started at start-up
   * (a helper's end notice, an update note) before recovery ran was resumed as if cut off, and its note sent twice.
   */
  private readonly begun = new Set<string>()
  /** Lease ids being resumed: their begin keeps the bumped attempt instead of starting at 1. */
  private readonly resuming = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  private watcher: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  private failover: Failover | null
  private readyGate: (() => Promise<void>) | undefined

  constructor(private readonly deps: TurnLeasesDeps) {
    this.now = deps.now ?? Date.now
    this.failover = deps.health !== undefined && deps.brains !== undefined ? { health: deps.health, brains: deps.brains } : null
    this.readyGate = deps.ready
  }

  /** Devices switched on: probe other brains, rank them, and wait for the first replication before recovering. */
  setFailover(failover: Failover | null): void {
    this.failover = failover
    if (failover?.ready !== undefined) this.readyGate = failover.ready
  }

  private isOwn(brainId: string): boolean {
    return brainId === this.deps.selfId() || (this.deps.ownIds?.() ?? []).includes(brainId)
  }

  private async notice(chat: string, text: string): Promise<void> {
    if (this.deps.notice !== undefined) {
      await this.deps.notice(chat, text)
      return
    }
    await this.deps.store.upsert('chat_item', { kind: 'notice', text, meta: JSON.stringify(chatTag(chat)) })
  }

  begin(info: { kind: 'turn' | 'job'; chatId: string; messageId: string; prompt: string; id?: string }): string {
    const id = info.id ?? (info.kind === 'job' ? `job-${info.messageId}` : `lease-${randomUUID()}`)
    this.begun.add(id)
    const keep = this.resuming.delete(id)
    const at = this.now()
    this.write(async () => {
      await this.deps.store.upsert('turn_lease', {
        id,
        kind: info.kind,
        chatId: info.chatId,
        brainId: this.deps.selfId(),
        status: 'running',
        // A resumed run keeps the message it answers, its attempt count and the request it was started with.
        ...(keep ? {} : { messageId: info.messageId, attempt: 1, startedAt: at, prompt: info.prompt.slice(0, 2000) }),
        heartbeatAt: at,
      })
    })
    this.stopBeat(id)
    const beat = setInterval(() => {
      this.write(async () => {
        const row = await this.deps.store.get('turn_lease', id)
        // Taken over by another brain (we were thought dead): stop claiming it, and stop our run of it.
        if (row === null || row.status !== 'running' || !this.isOwn(row.brainId)) {
          this.stopBeat(id)
          if (row !== null && row.status === 'running') this.deps.lost?.(row)
          return
        }
        await this.deps.store.upsert('turn_lease', { id, heartbeatAt: this.now() })
      })
    }, this.deps.heartbeatMs ?? HEARTBEAT_MS)
    beat.unref?.()
    this.beats.set(id, beat)
    return id
  }

  end(id: string, status: 'done' | 'failed'): void {
    this.stopBeat(id)
    this.write(async () => {
      const row = await this.deps.store.get('turn_lease', id)
      if (row === null || !this.isOwn(row.brainId)) return
      await this.deps.store.upsert('turn_lease', { id, status, heartbeatAt: this.now() })
    })
  }

  async willResume(id: string): Promise<boolean> {
    await this.settled()
    const row = await this.deps.store.get('turn_lease', id)
    return row !== null && row.status === 'running' && this.isOwn(row.brainId) && row.attempt < (this.deps.maxAttempts ?? MAX_ATTEMPTS)
  }

  /** Writes in order, so an end never lands before its begin. */
  settled(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  /** On start: this brain's leases left running by a crash are resumed, each once. Returns how many. */
  async recover(): Promise<number> {
    await this.readyGate?.()
    await this.settled()
    const leases = (await listWhere(this.deps.store, 'turn_lease', { statuses: ['running'] })).filter((row) => row.status === 'running' && this.isOwn(row.brainId) && !this.begun.has(row.id))
    // Mark them all first: a second recover (or a crash during resume) never resumes the same run twice.
    const go: TurnLeaseRow[] = []
    for (const lease of leases) {
      if (await this.giveUpIfSpent(lease)) continue
      await this.deps.store.upsert('turn_lease', { id: lease.id, status: 'interrupted', attempt: lease.attempt + 1, brainId: this.deps.selfId() })
      go.push(lease)
    }
    for (const lease of go) await this.resume(lease)
    return go.length
  }

  /** Every 15 s, look for leases whose brain went away. */
  watch(): void {
    if (this.watcher !== null) return
    this.watcher = setInterval(() => void this.claimStale().catch(() => 0), this.deps.watchMs ?? 15_000)
    this.watcher.unref?.()
  }

  stop(): void {
    if (this.watcher !== null) clearInterval(this.watcher)
    this.watcher = null
    // Stopped (the app quitting): what it began is a leftover for the next start's recovery.
    this.begun.clear()
    for (const id of [...this.beats.keys()]) this.stopBeat(id)
  }

  /** Take over running leases whose brain is gone, when this brain is the best healthy one left. Returns how many. */
  async claimStale(): Promise<number> {
    const failover = this.failover
    if (failover === null) return 0
    const health = failover.health
    const brainsOf = failover.brains
    const self = this.deps.selfId()
    const now = this.now()
    const stale = (await listWhere(this.deps.store, 'turn_lease', { statuses: ['running'] })).filter(
      (row) => row.status === 'running' && !this.isOwn(row.brainId) && now - row.heartbeatAt > (this.deps.staleMs ?? STALE_MS),
    )
    if (stale.length === 0) return 0
    const brains = await brainsOf()
    const rank = brains.findIndex((row) => row.id === self)
    if (rank < 0) return 0
    const probe = new Map<string, Promise<{ up: boolean; ready: boolean }>>()
    const check = (row: DeviceRow): Promise<{ up: boolean; ready: boolean }> => {
      let got = probe.get(row.id)
      if (got === undefined) {
        got = health(row).catch(() => ({ up: false, ready: false }))
        probe.set(row.id, got)
      }
      return got
    }

    let claimed = 0
    for (const lease of stale) {
      // A helper pinned to its device (named on purpose, or a project folder there) waits for that device: taken over
      // here it came back on a brain without its files (25 Oct 2026, a PC helper resumed on a server).
      if (lease.kind === 'job' && (await this.pinnedElsewhere(lease.messageId))) continue
      const owner = brains.find((row) => row.id === lease.brainId)
      if (owner !== undefined && (await check(owner)).up) continue
      let better = false
      for (const row of brains.slice(0, rank)) {
        if (row.id === lease.brainId) continue
        const state = await check(row)
        if (state.up && state.ready) {
          better = true
          break
        }
      }
      if (better) continue
      // Read again just before taking it: it may have finished or been taken while we probed.
      const fresh = await this.deps.store.get('turn_lease', lease.id)
      if (fresh === null || fresh.status !== 'running' || fresh.brainId !== lease.brainId || fresh.heartbeatAt !== lease.heartbeatAt) continue
      if (await this.giveUpIfSpent(fresh)) continue
      await this.deps.store.upsert('turn_lease', { id: fresh.id, brainId: self, attempt: fresh.attempt + 1, status: 'interrupted', heartbeatAt: this.now() })
      await this.resume(fresh)
      claimed++
    }
    return claimed
  }

  /** Is that helper's card pinned to a device other than this brain? */
  private async pinnedElsewhere(helperId: string): Promise<boolean> {
    const row = await this.deps.store.get('chat_item', helperId).catch(() => null)
    if (row === null) return false
    let meta: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(row.meta)
      if (typeof parsed === 'object' && parsed !== null) meta = parsed as Record<string, unknown>
    } catch {
      return false
    }
    const runOn = typeof meta['runOn'] === 'string' ? meta['runOn'] : ''
    return meta['pinned'] === true && runOn !== '' && !this.isOwn(runOn)
  }

  private async giveUpIfSpent(lease: TurnLeaseRow): Promise<boolean> {
    if (lease.attempt < (this.deps.maxAttempts ?? MAX_ATTEMPTS)) return false
    await this.deps.store.upsert('turn_lease', { id: lease.id, status: 'failed', brainId: this.deps.selfId(), heartbeatAt: this.now() })
    await this.notice(lease.chatId, GAVE_UP_NOTE)
    return true
  }

  private async resume(lease: TurnLeaseRow): Promise<void> {
    this.resuming.add(lease.id)
    try {
      if (lease.kind === 'job') await this.deps.resumeJob(lease.messageId, RESUME_NOTE)
      else {
        const task = lease.prompt.trim() === '' ? '' : ` The request was: "${lease.prompt.trim().slice(0, 600)}".`
        await this.deps.resumeTurn(lease.chatId, lease.id, `${RESUME_NOTE.slice(0, -1)}${task}]`)
      }
    } catch {
      this.resuming.delete(lease.id)
      await this.deps.store.upsert('turn_lease', { id: lease.id, status: 'failed', heartbeatAt: this.now() })
    }
  }

  private write(work: () => Promise<void>): void {
    this.chain = this.chain.then(work).catch(() => undefined)
  }

  private stopBeat(id: string): void {
    const beat = this.beats.get(id)
    if (beat !== undefined) clearInterval(beat)
    this.beats.delete(id)
  }
}

/** The brains in rank order from the device rows. */
export async function rankedBrains(store: DataStore): Promise<DeviceRow[]> {
  return (await store.list('device')).filter((row) => !row.revoked && row.roles.includes('brain')).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
}
