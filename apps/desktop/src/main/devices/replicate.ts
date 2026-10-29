/**
 * Replication between nodes (docs/devices-protocol.md s7).
 *
 * Every node keeps a change log (db.ts change_log: each applied row change gets a local seq and the peer it came
 * from) and serves it with the same wire format as the sync service (packages/core/src/sync/client.ts):
 *   POST /v1/sync/push            { device, changes }  ->  { cursor }
 *   GET  /v1/sync/pull?since=&wait=                    ->  { changes, cursor, bundle }
 * (`cursor=` is accepted as another name for `since=`.)
 *
 * And it runs one link per other node it can reach (brain or hands, not revoked, with addresses): push what the
 * peer has not seen, pull what it has, cursors kept per peer. Changes are relayed (what B pulled from A is in B's
 * log and goes on to C), never handed back to the peer they came from, and applying is idempotent (HLC, last writer
 * wins), so A <-> B <-> C converges when A cannot reach C, with no echo storm. Whichever side can reach the other
 * does both directions, so a node behind a firewall still syncs.
 */
import { SyncClient, changeFromJson, changeToJson, type Change, type DeviceRow } from '@agent/core'

import { ENTITY_NAMES } from '../db'
import type { DevicesHost } from './types'
import { pinnedFetch } from './pinned-fetch'

/** What replication needs from the local database (db.ts Store). */
export interface ReplicaStore {
  readonly deviceId: string
  changesAfter(seq: number, limit?: number, skipVia?: string, entities?: readonly string[]): { changes: Change[]; cursor: number }
  applyRemote(changes: Change[], via?: string): Promise<void>
  logSeq(): number
  onChange(listener: (change?: { entity?: string }) => void): () => void
  localValue(key: string): string | null
  setLocalValue(key: string, value: string): void
  list(entity: 'device'): Promise<DeviceRow[]>
}

const MAX_WAIT_SECONDS = 55
const PAGE = 500

/**
 * The entities the first replicating nodes knew (0.2.42). A node only drops a change of an entity it does not know, and
 * its peer still counts it as sent, so a node upgraded from an older version never gets those rows on its own: on its
 * first pass after the upgrade it pulls them once (PeerLink.backfill). Kept per link as `peer_known:<peer>`; a link with
 * no record that has pulled before was made by a version that knew only these.
 */
const FIRST_ENTITIES: readonly string[] = ['chat_item', 'turn', 'memory', 'goal', 'task', 'trigger', 'project', 'device', 'device_command', 'turn_lease']

/** The two sync routes on this node. `bundleVersion` rides along on pull answers so peers know when to re-read it. */
export function registerSyncRoutes(host: DevicesHost, store: ReplicaStore, bundleVersion: () => string = () => ''): void {
  host.addRoute({
    method: 'POST',
    path: '/v1/sync/push',
    auth: 'node',
    async handle(req) {
      const caller = req.deviceId ?? ''
      const body = isRecord(req.body) ? req.body : {}
      const raw = Array.isArray(body['changes']) ? body['changes'] : []
      const changes: Change[] = []
      for (const item of raw) {
        const change = changeFromJson(item)
        if (change !== null) changes.push(change)
      }
      if (changes.length > 0) await store.applyRemote(changes, caller)
      return { status: 200, json: { cursor: store.logSeq() } }
    },
  })

  host.addRoute({
    method: 'GET',
    path: '/v1/sync/pull',
    auth: 'node',
    async handle(req) {
      const caller = req.deviceId ?? ''
      const since = whole(req.query.get('since') ?? req.query.get('cursor'))
      const wait = Math.min(MAX_WAIT_SECONDS, whole(req.query.get('wait')))
      // Only some entities: a peer backfilling kinds of rows it did not know before. Named back so it knows we did.
      const raw = req.query.get('entities')
      const entities = raw === null || raw === '' ? undefined : raw.split(',').map((e) => e.trim()).filter((e) => e !== '')
      const result = await pullFrom(store, since, wait, caller, req.signal, entities)
      // The caller went away (or the node is stopping): nothing to answer, and the database may be closing.
      if (req.signal.aborted) return { status: 499, json: {} }
      return {
        status: 200,
        json: { changes: result.changes.map(changeToJson), cursor: result.cursor, bundle: bundleVersion(), ...(entities === undefined ? {} : { entities }) },
      }
    },
  })
}

/** Read the log after `since`, holding the request open up to `wait` seconds when there is nothing new. */
export async function pullFrom(store: ReplicaStore, since: number, wait: number, caller: string, signal?: AbortSignal, entities?: readonly string[]): Promise<{ changes: Change[]; cursor: number }> {
  // A peer whose cursor is ahead of our log has an old copy of a log we no longer have (this database was reset):
  // start it again from the beginning.
  let cursor = since > store.logSeq() ? 0 : since
  const deadline = Date.now() + wait * 1000
  for (;;) {
    if (signal?.aborted === true) return { changes: [], cursor }
    const page = entities === undefined ? store.changesAfter(cursor, PAGE, caller) : store.changesAfter(cursor, PAGE, caller, entities)
    const moved = page.cursor > cursor
    cursor = page.cursor
    if (page.changes.length > 0) return page
    // Everything read was the caller's own: keep reading until the log is drained.
    if (moved && store.logSeq() > cursor) continue
    const left = deadline - Date.now()
    if (left <= 0) return { changes: [], cursor }
    await changedOrTimeout(store, left, signal)
  }
}

function changedOrTimeout(store: ReplicaStore, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let off: () => void = () => undefined
    const done = (): void => {
      clearTimeout(timer)
      off()
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    off = store.onChange(() => {
      // Let the write that announced itself finish (a batch announces after it commits).
      setTimeout(done, 0)
    })
    signal?.addEventListener('abort', done, { once: true })
  })
}

// ---- the peer links ----------------------------------------------------------------------------------------

export interface PeerTarget {
  id: string
  name: string
  urls: string[]
  fp: string
}

export interface ReplicatorDeps {
  store: ReplicaStore
  /** This node's device id (the id other nodes know it by). */
  selfId: () => string
  /** The pass this node was given when it paired (valid at every brain in the mesh), or null before pairing. */
  pass: () => string | null
  /** A sync client for one address of a peer. Default: pinned https (the peer's fingerprint). Tests pass plain http. */
  clientFor?: (url: string, peer: PeerTarget, pass: string) => SyncClient
  /** The peers to replicate with. Default: the device rows (brain or hands, not revoked, not us, with addresses). */
  peers?: () => Promise<PeerTarget[]>
  /** A peer's bundle version changed (or it was seen for the first time): read its bundle. */
  onBundleVersion?: (peer: PeerTarget, version: string, url: string) => void
  /** A peer link went from working to failing or back (Settings, Home and the rail show it). */
  onLinkState?: () => void
  /**
   * After every good pull, with the peer's bundle version (may be ''). Lets this node push its own bundle to a peer
   * that cannot reach it to read it (a joining node behind a userspace VPN or a firewall that only hears from us).
   */
  afterPull?: (peer: PeerTarget, version: string, url: string) => void
  /** The entities this node replicates (default: all it knows, db.ts). Tests pass fewer to act as an older node. */
  entities?: readonly string[]
  /** Long-poll window, seconds. */
  waitSeconds?: number
  /** How often the peer list is read again. */
  refreshMs?: number
  initialBackoffMs?: number
  maxBackoffMs?: number
  log?: (line: string) => void
}

/** A node's rows as a peer should see them: everything a brain or hands device replicates with. */
export async function peersFromRows(store: ReplicaStore, selfId: string): Promise<PeerTarget[]> {
  const rows = await store.list('device')
  return rows
    .filter((row) => !row.revoked && row.id !== selfId && row.urls.length > 0 && (row.roles.includes('brain') || row.roles.includes('hands')))
    .sort((a, b) => a.priority - b.priority)
    .map((row) => ({ id: row.id, name: row.name, urls: [...row.urls], fp: row.fp }))
}

/**
 * The device rows' peers plus the peers known from pairing (headless node.json brains, joined peers). A row wins on
 * who the peer is (revoked stays revoked, its fingerprint, its name), but the addresses known from pairing are still
 * tried after the row's own. Without that, a row written while the peer's VPN was down (LAN address only) cuts this
 * node off for good: the fresh row can only come from the peer it can no longer reach.
 */
export function mergePeers(rows: DeviceRow[], extra: PeerTarget[], selfId: string): PeerTarget[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const given = new Map<string, PeerTarget>()
  for (const peer of extra) if (peer.id !== selfId && peer.fp !== '' && peer.urls.length > 0 && !given.has(peer.id)) given.set(peer.id, peer)
  const out: PeerTarget[] = []
  for (const row of [...rows].sort((a, b) => a.priority - b.priority)) {
    if (row.revoked || row.id === selfId || !(row.roles.includes('brain') || row.roles.includes('hands'))) continue
    const known = given.get(row.id)
    const sameKey = known !== undefined && known.fp === row.fp
    const urls = [...row.urls, ...(sameKey ? known.urls.filter((url) => !row.urls.includes(url)) : [])]
    if (urls.length === 0) continue
    out.push({ id: row.id, name: row.name, urls, fp: row.fp })
  }
  for (const peer of given.values()) if (!byId.has(peer.id)) out.push({ ...peer, urls: [...peer.urls] })
  return out
}

export class Replicator {
  private readonly links = new Map<string, PeerLink>()
  private timer: ReturnType<typeof setInterval> | null = null
  private offChange: (() => void) | null = null
  private peersTimer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(private readonly deps: ReplicatorDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.offChange = this.deps.store.onChange((change) => {
      for (const link of this.links.values()) link.nudge()
      // A device paired, changed or was taken out: read the peers again now, not at the next 15 s check, so a brain
      // that just joined is replicated with from its first turn.
      if (change?.entity === 'device' && this.peersTimer === null) {
        this.peersTimer = setTimeout(() => {
          this.peersTimer = null
          if (this.running) void this.reconcile(true)
        }, 100)
      }
    })
    void this.reconcile(true)
    this.timer = setInterval(() => void this.reconcile(true), this.deps.refreshMs ?? 15_000)
  }

  stop(): void {
    this.running = false
    if (this.peersTimer !== null) clearTimeout(this.peersTimer)
    this.peersTimer = null
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.offChange?.()
    this.offChange = null
    for (const link of this.links.values()) link.stop()
    this.links.clear()
  }

  /** Read the peer list again: start links to new peers, stop links to ones that went away or were revoked. */
  refresh(): Promise<void> {
    return this.reconcile(this.running)
  }

  private async reconcile(startLoops: boolean): Promise<void> {
    let peers: PeerTarget[]
    try {
      peers = this.deps.peers !== undefined ? await this.deps.peers() : await peersFromRows(this.deps.store, this.deps.selfId())
    } catch {
      return
    }
    const wanted = new Set(peers.map((peer) => peer.id))
    for (const [id, link] of this.links) {
      if (!wanted.has(id)) {
        link.stop()
        this.links.delete(id)
      }
    }
    for (const peer of peers) {
      const existing = this.links.get(peer.id)
      if (existing !== undefined) {
        existing.update(peer)
        continue
      }
      const link = new PeerLink(peer, this.deps)
      this.links.set(peer.id, link)
      if (startLoops) link.start()
    }
  }

  /** One push and pull with every peer, now, without a long poll. For tests and "sync now". */
  async syncOnce(): Promise<void> {
    await this.reconcile(this.running)
    await Promise.all([...this.links.values()].map((link) => link.passNow()))
  }

  status(): Array<{ peer: string; ok: boolean; error: string | null; lastAt: number | null }> {
    return [...this.links.values()].map((link) => link.status())
  }
}

class PeerLink {
  private stopped = false
  private pullController: AbortController | null = null
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null
  /** Local changes not yet pushed (set by nudge, cleared as a push starts). */
  private dirty = false
  private wake: (() => void) | null = null
  private lock: Promise<unknown> = Promise.resolve()
  private lastError: string | null = null
  private lastOkAt: number | null = null
  private goodUrl = 0
  private bundleSeen: string | null = null
  /** The client of the long poll in flight: a local change is pushed on it beside the poll instead of cutting it. */
  private polling: SyncClient | null = null
  private sidePushing = false
  private sideAgain = false
  private pushLock: Promise<unknown> = Promise.resolve()

  constructor(
    private peer: PeerTarget,
    private readonly deps: ReplicatorDeps,
  ) {}

  update(peer: PeerTarget): void {
    this.peer = peer
  }

  start(): void {
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.pullController?.abort()
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer)
    this.wake?.()
  }

  /**
   * A local change: cut the long poll short so it is pushed now. The first change after a quiet spell goes at once
   * (a brain that dies right after starting a turn has still handed its lease on); more changes within 200 ms are
   * pushed together right after.
   */
  nudge(): void {
    this.dirty = true
    // A long poll is open: push beside it. Cutting the poll short closed its connection, and over a relayed VPN path
    // every new connection is a handshake that may time out (29 Oct 2026).
    if (this.polling !== null) {
      this.sidePush(this.polling)
      return
    }
    if (this.nudgeTimer !== null) return
    this.pullController?.abort()
    this.wake?.()
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null
      if (!this.dirty) return
      this.pullController?.abort()
      this.wake?.()
    }, 200)
  }

  status(): { peer: string; ok: boolean; error: string | null; lastAt: number | null } {
    return { peer: this.peer.id, ok: this.lastError === null && this.lastOkAt !== null, error: this.lastError, lastAt: this.lastOkAt }
  }

  /** Whether the link last worked, to tell when that changes. */
  private wasUp = false

  passNow(): Promise<boolean> {
    this.pullController?.abort()
    return this.serial(() => this.pass(0)).then((ok) => {
      this.noteState()
      return ok
    })
  }

  private noteState(): void {
    const up = this.status().ok
    if (up === this.wasUp) return
    this.wasUp = up
    this.deps.onLinkState?.()
  }

  private async loop(): Promise<void> {
    const initial = this.deps.initialBackoffMs ?? 2_000
    const max = this.deps.maxBackoffMs ?? 60_000
    let backoff = initial
    while (!this.stopped) {
      const ok = await this.serial(() => this.pass(this.deps.waitSeconds ?? 25))
      if (this.stopped) break
      this.noteState()
      if (ok) {
        backoff = initial
        continue
      }
      await this.sleep(backoff)
      backoff = Math.min(backoff * 2, max)
    }
  }

  /** Push what is new on the poll's client; more changes while it runs go right after. A failure hands it to the loop. */
  private sidePush(client: SyncClient): void {
    if (this.sidePushing) {
      this.sideAgain = true
      return
    }
    this.sidePushing = true
    void (async () => {
      try {
        do {
          this.sideAgain = false
          this.dirty = false
          await this.pushLocked(client)
        } while (this.sideAgain && !this.stopped)
      } catch {
        // The loop takes it from here: cut the poll, and the next pass pushes and reports the error.
        this.dirty = true
        this.pullController?.abort()
      } finally {
        this.sidePushing = false
      }
    })()
  }

  /** One push at a time per link (the loop's and a side push), so the push cursor only moves forward. */
  private pushLocked(client: SyncClient): Promise<void> {
    const result = this.pushLock.then(
      () => this.pushAll(client),
      () => this.pushAll(client),
    )
    this.pushLock = result.catch(() => undefined)
    return result
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lock.then(work, work)
    this.lock = result.catch(() => undefined)
    return result
  }

  private key(which: 'push' | 'pull' | 'known' | 'backfill'): string {
    return `peer_${which}:${this.peer.id}`
  }

  private cursorOf(which: 'push' | 'pull'): number {
    return whole(this.deps.store.localValue(this.key(which)))
  }

  /** Push what the peer has not seen, then pull what it has. False when the peer could not be reached. */
  private async pass(waitSeconds: number): Promise<boolean> {
    const pass = this.deps.pass()
    if (pass === null || pass === '' || this.peer.urls.length === 0) {
      this.lastError = 'Not paired yet.'
      return false
    }
    const order = this.peer.urls.map((_, i) => (i + this.goodUrl) % this.peer.urls.length)
    let lastError = 'unreachable'
    for (const index of order) {
      const url = this.peer.urls[index] ?? ''
      try {
        const client = this.client(url, pass)
        this.dirty = false
        await this.pushLocked(client)
        if (this.stopped) return false
        await this.backfill(client)
        if (this.stopped) return false
        const controller = new AbortController()
        this.pullController = controller
        // A nudge that landed while we pushed: do not sit in a long poll with fresh local work waiting.
        const wait = this.dirty ? 0 : waitSeconds
        let pulled
        try {
          if (wait > 0) this.polling = client
          pulled = await client.pull(this.cursorOf('pull'), { wait, signal: controller.signal })
        } catch (error) {
          if (isAbort(error) && !this.stopped) {
            // Cut short by a nudge: a good pass, go round again to push.
            this.goodUrl = index
            this.lastError = null
            return true
          }
          throw error
        } finally {
          if (this.pullController === controller) this.pullController = null
          this.polling = null
        }
        if (pulled.changes.length > 0) await this.deps.store.applyRemote(pulled.changes, this.peer.id)
        // Taken as given, even when it went back: the peer's log was reset and it starts us again from there.
        this.deps.store.setLocalValue(this.key('pull'), String(pulled.cursor))
        const version = pulled.bundle ?? ''
        if (version !== '' && version !== this.bundleSeen) {
          this.bundleSeen = version
          this.deps.onBundleVersion?.(this.peer, version, url)
        }
        this.deps.afterPull?.(this.peer, version, url)
        this.goodUrl = index
        this.lastError = null
        this.lastOkAt = Date.now()
        return true
      } catch (error) {
        if (this.stopped) return false
        lastError = error instanceof Error ? error.message : 'unreachable'
      }
    }
    this.lastError = lastError
    this.deps.log?.(`devices: could not reach ${this.peer.name}: ${lastError}`)
    return false
  }

  /**
   * Rows of entities this node did not know when it last pulled from the peer (it was upgraded): the peer counted them
   * as sent, so read them once, only those entities, from the start of its log. A peer too old to filter answers with
   * everything, which applies the same (idempotent) and only costs a full read once.
   */
  private async backfill(client: SyncClient): Promise<void> {
    const mine = this.deps.entities ?? ENTITY_NAMES
    const recorded = this.deps.store.localValue(this.key('known'))
    const known = recorded !== null && recorded !== '' ? recorded.split(',') : this.cursorOf('pull') > 0 ? FIRST_ENTITIES : mine
    const missing = mine.filter((entity) => !known.includes(entity))
    if (missing.length > 0) {
      let cursor = whole(this.deps.store.localValue(this.key('backfill')))
      let rows = 0
      for (let round = 0; round < 100_000 && !this.stopped; round++) {
        const page = await client.pull(cursor, { wait: 0, entities: missing })
        if (page.changes.length > 0) await this.deps.store.applyRemote(page.changes, this.peer.id)
        rows += page.changes.length
        if (page.cursor <= cursor) break
        cursor = page.cursor
        this.deps.store.setLocalValue(this.key('backfill'), String(cursor))
      }
      if (this.stopped) return
      this.deps.store.setLocalValue(this.key('backfill'), '0')
      this.deps.log?.(`devices: read ${missing.join(', ')} from ${this.peer.name} once (${rows} changes): this node did not know them before`)
    }
    if (recorded !== mine.join(',')) this.deps.store.setLocalValue(this.key('known'), mine.join(','))
  }

  private async pushAll(client: SyncClient): Promise<void> {
    for (let round = 0; round < 1000; round++) {
      const from = this.cursorOf('push')
      const page = this.deps.store.changesAfter(from, PAGE, this.peer.id)
      if (page.cursor === from) return
      if (page.changes.length > 0) await client.push(this.deps.selfId(), page.changes)
      this.deps.store.setLocalValue(this.key('push'), String(page.cursor))
    }
  }

  private client(url: string, pass: string): SyncClient {
    if (this.deps.clientFor !== undefined) return this.deps.clientFor(url, this.peer, pass)
    return new SyncClient(url, pass, pinnedFetch(this.peer.fp))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        if (this.wake === done) this.wake = null
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }
}

function whole(value: string | null | undefined): number {
  const n = Number(value ?? '')
  return Number.isSafeInteger(n) && n > 0 ? n : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
