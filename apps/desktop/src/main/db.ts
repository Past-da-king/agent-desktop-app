/**
 * The app's local database. One generic `rows` table holds every synced entity, so the sync code
 * never has to know a row's shape (PLAN.md 4.1). Implements `SyncStore` for the shared engine.
 *
 * A `local` flag marks rows written on this device and not yet acknowledged by the server. Rows
 * applied from another device are stored with `local = 0`, so a pull never pushes itself back.
 * The flag is the one addition to the schema in PLAN.md 4.1; the columns it names are unchanged.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import {
  Hlc,
  compareStamps,
  decodeStamp,
  encodeStamp,
  isEntityName,
  type Change,
  type DataChange,
  type EntityMap,
  type EntityName,
  type ListWhere,
  type MemoryVersion,
  type RowInput,
  type SyncStore,
} from '@agent/core'

import { phoneKeepsChatRow } from '../shared/device-feed'
import { filterRows } from '../shared/list-where'
import { isLiveHelper, isOpenCard } from '../shared/device-list'
import { changedFields, currentWriter, versionFields, type MemoryWriter } from './memory/history'
import { redactDeep } from './vault/redact'
import { startCheckpointWorker, type Checkpointer } from './db-checkpoint'

interface StoredRow {
  cid: string
  stamp: string
  deleted: boolean
  payload: Record<string, unknown>
}

/** A change as listeners hear it: the row as it is now, a deleted id, or a reset (read the list again). */
export type StoreChange = DataChange
export type StoreChangeListener = (change: StoreChange) => void

/** Up to this many rows in one batch or sync are announced one by one; more becomes one reset per entity. */
const MAX_SINGLE_CHANGES = 40

/**
 * A reset carries its changes (DataChange.batch) up to this many, so a window holding the list applies them instead
 * of reading the whole entity again. Past it (a first sync, an import), the list is read again.
 */
const MAX_BATCH_CHANGES = 5000

/** Rows read per slice when a device's chat list is built, so no one slice holds the event loop for long. */
const SLICE_ROWS = 500

/** How many of the newest rows the walk looks through before the quiet chats are read by their own index. */
const WALK_ROWS = 6000

/** How far a page of the main chat looks back through other rows before it gives up. */
const PAGE_WALK_ROWS = 40_000

/**
 * A chat row's chat, read inside SQLite: `meta` is JSON text inside the payload JSON. Rows of the first chat carry
 * no tag. Only well-formed meta is looked into, so a damaged row never breaks a query.
 */
const CHAT_SQL = "CASE WHEN json_valid(json_extract(payload, '$.meta')) THEN json_extract(json_extract(payload, '$.meta'), '$.chat') END"

/**
 * A chat row's chat as one value, 'main' for an untagged row (as chatOfPayload reads it), so every chat, the first
 * one included, is one equality on the chat index.
 */
const CHAT_KEY =
  "COALESCE(NULLIF(CASE WHEN json_valid(json_extract(payload, '$.meta')) AND json_type(json_extract(payload, '$.meta'), '$.chat') = 'text' THEN json_extract(json_extract(payload, '$.meta'), '$.chat') END, ''), 'main')"

const KIND_SQL = "json_extract(payload, '$.kind')"
const STATUS_SQL = "json_extract(payload, '$.status')"
const CREATED_SQL = "json_extract(payload, '$.createdAt')"

/**
 * Rows read per slice by a whole-entity list, with a yield between slices: reading 60,000 chat rows (hundreds of MB)
 * in one go held the main thread for seconds and Windows showed "Not responding" (28 Oct 2026).
 */
const LIST_SLICE_ROWS = 1000

/** Longest stretch of store calls before the event loop gets a turn (Store.turn). */
const STORE_SLICE_MS = 30

export const ENTITY_NAMES: readonly EntityName[] = ['chat_item', 'turn', 'memory', 'goal', 'task', 'trigger', 'project', 'device', 'device_command', 'turn_lease', 'job', 'prompt_rule', 'wakeup', 'miniapp']

/** Versions kept per memory page; the oldest go first. */
const MAX_VERSIONS = 300

const UPDATED_AT_ENTITIES: ReadonlySet<EntityName> = new Set(['memory', 'task', 'prompt_rule'])

/**
 * Whole lists of these are kept in memory (as stored, parsed afresh on every read) until a write to the entity.
 * Every turn and every helper start lists memory, goals, tasks, projects and rules; their rows sit scattered through
 * a 450 MB file, and on a starved disk one list of 521 memory pages took 0.2 to 1 s on the main thread (30 Oct
 * 2026). Chat rows and turns are far too big and are never held.
 */
const LIST_CACHED: ReadonlySet<EntityName> = new Set(ENTITY_NAMES.filter((each) => each !== 'chat_item' && each !== 'turn'))
/**
 * Filtered reads of these are answered from the held list (the scheduler, the offload scan and the job beats read
 * them every few seconds). Device commands and turn leases are written too often to hold and have their own index.
 */
const WHERE_FROM_LIST: ReadonlySet<EntityName> = new Set(['memory', 'goal', 'task', 'trigger', 'project', 'device', 'job', 'prompt_rule', 'wakeup', 'miniapp'])

export class Store implements SyncStore {
  readonly deviceId: string
  private readonly db: DatabaseSync
  private readonly hlc: Hlc
  private readonly now: () => number
  private readonly listeners = new Set<StoreChangeListener>()
  private closed = false
  private readonly file: string
  private checkpointer: Checkpointer | null = null
  /** While a batch runs, changes are collected here and announced once at the end. */
  private batching: StoreChange[] | null = null
  /** Whole lists of the small entities as stored (LIST_CACHED), dropped on any write to the entity. */
  private readonly listCache = new Map<EntityName, Array<Record<string, SQLOutputValue>>>()
  /** Inside an open transaction nothing is cached (it may still roll back). */
  private inTransaction = false

  constructor(file: string, clock: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.now = clock
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    // Writes run on the main thread. FULL synced the log on every commit, and one write on a busy disk took up to
    // 1.4 s (30 Oct 2026 hangs). NORMAL in WAL mode syncs only at checkpoints: never corrupt, at worst the last
    // moments before a power cut are lost. A larger page cache keeps the indexes in memory when the system is short
    // of it and the file cache is gone.
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA cache_size = -32768')
    this.db.exec('PRAGMA journal_size_limit = 67108864')
    this.file = file
    const hadLog = this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'change_log'").get() !== undefined
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rows(
        entity TEXT NOT NULL,
        cid TEXT NOT NULL,
        stamp TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        local INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(entity, cid)
      );
      CREATE INDEX IF NOT EXISTS rows_stamp ON rows(stamp);
      CREATE INDEX IF NOT EXISTS rows_created ON rows(entity, ${CREATED_SQL});
      -- One index per filter, each ending in the created-at, so a filtered list is an index range (28 Oct 2026).
      -- The single-column ones they replace were never picked: SQLite preferred rows_created for the ORDER BY and
      -- scanned every chat row (240 MB) on each query. listWhere names its index (INDEXED BY) so that never returns.
      DROP INDEX IF EXISTS rows_thread;
      DROP INDEX IF EXISTS rows_kind;
      DROP INDEX IF EXISTS rows_chat;
      CREATE INDEX IF NOT EXISTS rows_thread_at ON rows(entity, json_extract(payload, '$.thread'), ${CREATED_SQL});
      CREATE INDEX IF NOT EXISTS rows_kind_at ON rows(entity, ${KIND_SQL}, ${CREATED_SQL});
      CREATE INDEX IF NOT EXISTS rows_chat_kind_at ON rows(entity, ${CHAT_KEY}, ${KIND_SQL}, ${CREATED_SQL});
      -- Device commands and turn leases are polled by status every few seconds; read the open ones, not the history.
      CREATE INDEX IF NOT EXISTS rows_status_at ON rows(entity, ${STATUS_SQL}, ${CREATED_SQL});
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_versions(
        memory_id TEXT NOT NULL,
        n INTEGER NOT NULL,
        at INTEGER NOT NULL,
        by TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        changed TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL,
        PRIMARY KEY(memory_id, n)
      );
      CREATE TABLE IF NOT EXISTS change_log(
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity TEXT NOT NULL,
        cid TEXT NOT NULL,
        via TEXT NOT NULL DEFAULT '',
        UNIQUE(entity, cid)
      );
    `)
    // The change log (docs/devices-protocol.md s7) starts with every row there is, so a new peer gets them all.
    if (!hadLog) this.db.exec("INSERT OR REPLACE INTO change_log(entity, cid, via) SELECT entity, cid, '' FROM rows ORDER BY stamp")

    const existing = this.kv('device_id')
    if (existing === null) {
      const generated = randomUUID()
      this.setKv('device_id', generated)
      this.deviceId = generated
    } else {
      this.deviceId = existing
    }
    this.hlc = new Hlc(this.deviceId, clock)
  }

  // ---- reading ----

  async list<E extends EntityName>(entity: E): Promise<Array<EntityMap[E]>> {
    this.assertEntity(entity)
    await this.turn()
    const rows = (await this.readEntitySliced(entity)).filter((row) => !row.deleted)
    return sortedRows(rows, false).map((row) => ({ id: row.cid, ...row.payload }) as EntityMap[E])
  }

  /**
   * Every row of an entity, read along the primary key in slices with a yield between them, so a big table never
   * holds the event loop (the window, the devices link, timers) for more than a slice.
   */
  private async readEntitySliced(entity: EntityName): Promise<StoredRow[]> {
    const held = this.listCache.get(entity)
    if (held !== undefined) return held.map(rowFromSql)
    const writesBefore = this.writes
    const slice = this.db.prepare('SELECT cid, stamp, deleted, payload FROM rows WHERE entity = ? AND cid > ? ORDER BY cid LIMIT ?')
    const raw: Array<Record<string, SQLOutputValue>> = []
    let after = ''
    for (;;) {
      const rows = slice.all(entity, after, LIST_SLICE_ROWS)
      for (const row of rows) raw.push(row)
      const last = rows[rows.length - 1]
      if (rows.length < LIST_SLICE_ROWS || last === undefined) break
      after = stringField(last['cid'])
      await yieldNow()
    }
    // Kept only when nothing was written while it was read (between slices) and no transaction is open.
    if (LIST_CACHED.has(entity) && !this.inTransaction && this.batching === null && this.writes === writesBefore) this.listCache.set(entity, raw)
    return raw.map(rowFromSql)
  }

  /** Writes so far (a list read across slices is cached only if none happened meanwhile). */
  private writes = 0

  /**
   * Store work chained without a break (a dozen helpers each writing a step, every await resolving at once) held the
   * main thread for 0.6 s and more at a time, so the window's calls waited (30 Oct 2026). Once a stretch of store
   * calls passes STORE_SLICE_MS the next one first gives the event loop a turn. Never inside a transaction.
   */
  private sliceStart = 0
  private sliceArmed = false

  private async turn(): Promise<void> {
    if (this.batching !== null || this.inTransaction) return
    const now = performance.now()
    if (!this.sliceArmed) {
      this.sliceArmed = true
      this.sliceStart = now
      setImmediate(() => {
        this.sliceArmed = false
      })
      return
    }
    if (now - this.sliceStart < STORE_SLICE_MS) return
    await yieldNow()
  }

  /** One commit for a row and its change-log entry (two commits before), unless a transaction is already open. */
  private oneCommit<T>(work: () => T): T {
    if (this.batching !== null || this.inTransaction) return work()
    this.db.exec('BEGIN')
    this.inTransaction = true
    try {
      const out = work()
      this.db.exec('COMMIT')
      return out
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.dropList(null)
      throw error
    } finally {
      this.inTransaction = false
    }
  }

  private dropList(entity: EntityName | null): void {
    this.writes++
    if (entity === null) this.listCache.clear()
    else this.listCache.delete(entity)
  }

  /**
   * The chat rows a linked device needs: the newest `perChat` rows of every chat (the main chat and each project
   * chat), plus every card still waiting for an answer and the helpers working now, oldest first. The table is
   * walked newest first in slices along the created-at index, yielding between slices, so the event loop (and the link's pongs) is never held for more than a few milliseconds and the
   * rest of the table is never parsed.
   */
  async listChatItemsForDevice(perChat: number, now: number = Date.now()): Promise<Array<EntityMap['chat_item']>> {
    const want = Math.max(1, Math.floor(perChat))
    // The chats that exist, from the chat index alone (no row is parsed).
    const counts = new Map<string, number>([['main', 0]])
    for (const row of this.db.prepare(`SELECT DISTINCT ${CHAT_KEY} AS chat FROM rows INDEXED BY rows_chat_kind_at WHERE entity = 'chat_item'`).all()) {
      const chat = row['chat']
      if (typeof chat === 'string' && chat !== '') counts.set(chat, 0)
    }
    const picked = new Map<string, StoredRow>()
    const slice = this.db.prepare(
      `SELECT cid, stamp, deleted, payload FROM rows WHERE entity = 'chat_item' AND deleted = 0 AND json_extract(payload, '$.createdAt') <= ? ORDER BY json_extract(payload, '$.createdAt') DESC, stamp DESC LIMIT ?`,
    )
    let at = Number.MAX_SAFE_INTEGER
    let scanned = 0
    const done = new Set<string>()
    for (;;) {
      const rows = slice.all(at, SLICE_ROWS).map(rowFromSql)
      let fresh = 0
      for (const row of rows) {
        if (done.has(row.cid)) continue
        done.add(row.cid)
        fresh += 1
        const chat = chatOfPayload(row.payload)
        const n = counts.get(chat) ?? 0
        if (n >= want) continue
        counts.set(chat, n + 1)
        picked.set(row.cid, row)
      }
      const last = rows[rows.length - 1]
      scanned += rows.length
      if (rows.length < SLICE_ROWS || fresh === 0 || last === undefined || scanned >= WALK_ROWS || [...counts.values()].every((n) => n >= want)) break
      at = numberField(last.payload.createdAt)
      await yieldNow()
    }
    // A chat that has gone quiet is not in the recent walk: its own rows come by the chat index (small by nature).
    for (const [chat, n] of counts) {
      if (n >= want || chat === 'main') continue
      const own = this.db
        .prepare(
          `SELECT cid, stamp, deleted, payload FROM rows INDEXED BY rows_chat_kind_at WHERE entity = 'chat_item' AND deleted = 0 AND ${CHAT_KEY} = ? ORDER BY ${CREATED_SQL} DESC, stamp DESC LIMIT ?`,
        )
        .all(chat, want)
        .map(rowFromSql)
      for (const row of sortedRows(own, true).slice(0, want)) picked.set(row.cid, row)
      await yieldNow()
    }
    const waiting = this.db
      .prepare(`SELECT cid, stamp, deleted, payload FROM rows INDEXED BY rows_kind_at WHERE entity = 'chat_item' AND deleted = 0 AND ${KIND_SQL} IN ('question', 'approval', 'helper')`)
      .all()
      .map(rowFromSql)
    for (const row of waiting) {
      if (picked.has(row.cid)) continue
      if (isOpenCard(row.payload) || isLiveHelper(row.payload, now)) picked.set(row.cid, row)
    }
    return sortedRows([...picked.values()], false).map((row) => ({ id: row.cid, ...row.payload }) as EntityMap['chat_item'])
  }

  /**
   * A page of the main chat for a phone: the newest `limit` rows created before `before` (a created-at, or none for the
   * newest), oldest first, leaving out what a phone never shows row by row (a helper's steps, other chats' lines).
   * Walks the created-at index in slices and yields between them, like listChatItemsForDevice.
   */
  async phoneChatPage(before: number | undefined, limit: number): Promise<{ rows: Array<EntityMap['chat_item']>; more: boolean }> {
    const want = Math.max(1, Math.min(200, Math.floor(limit)))
    const slice = this.db.prepare(
      `SELECT cid, stamp, deleted, payload FROM rows WHERE entity = 'chat_item' AND deleted = 0 AND json_extract(payload, '$.createdAt') < ? ORDER BY json_extract(payload, '$.createdAt') DESC, stamp DESC LIMIT ?`,
    )
    let at = before === undefined ? Number.MAX_SAFE_INTEGER : before
    const out: StoredRow[] = []
    let scanned = 0
    let more = false
    for (;;) {
      const rows = slice.all(at, SLICE_ROWS).map(rowFromSql)
      for (const row of rows) {
        if (!phoneKeepsChatRow(row.payload as { kind?: unknown; meta?: unknown })) continue
        if (out.length >= want) {
          more = true
          break
        }
        out.push(row)
      }
      const last = rows[rows.length - 1]
      scanned += rows.length
      if (more || rows.length < SLICE_ROWS || last === undefined || scanned >= PAGE_WALK_ROWS) break
      at = numberField(last.payload.createdAt)
      await yieldNow()
    }
    return { rows: sortedRows(out, false).map((row) => ({ id: row.cid, ...row.payload }) as EntityMap['chat_item']), more }
  }

  /**
   * The rows that match, read inside SQLite (indexed), instead of every row of the entity parsed and filtered in
   * JavaScript: a conversation's own turns, a chat's dividers, the newest user message.
   */
  async listWhere<E extends EntityName>(entity: E, where: ListWhere): Promise<Array<EntityMap[E]>> {
    this.assertEntity(entity)
    await this.turn()
    if (WHERE_FROM_LIST.has(entity) && !this.inTransaction && this.batching === null) return filterRows(await this.list(entity), where)
    const query = listWhereSql(entity, where)
    if (query === null) return []
    const rows = this.db.prepare(query.sql).all(...query.args).map(rowFromSql)
    return sortedRows(rows, where.newestFirst === true).map((row) => ({ id: row.cid, ...row.payload }) as EntityMap[E])
  }

  /** How SQLite runs a listWhere (EXPLAIN QUERY PLAN lines), so a test can hold every shape to an index. */
  listWherePlan(entity: EntityName, where: ListWhere): string[] {
    this.assertEntity(entity)
    const query = listWhereSql(entity, where)
    if (query === null) return []
    return this.db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...query.args)
      .map((row) => stringField(row['detail']))
  }

  async get<E extends EntityName>(entity: E, id: string): Promise<EntityMap[E] | null> {
    this.assertEntity(entity)
    await this.turn()
    const row = this.readRow(entity, id)
    if (row === null || row.deleted) return null
    return { id: row.cid, ...row.payload } as EntityMap[E]
  }

  /** Ids of rows deleted on this device or by a sync (tombstones), so an importer can leave them deleted. */
  deletedIds(entity: EntityName): Set<string> {
    this.assertEntity(entity)
    const rows = this.db.prepare('SELECT cid FROM rows WHERE entity = ? AND deleted = 1').all(entity)
    return new Set(rows.map((row) => stringField(row['cid'])))
  }

  // ---- writing ----

  async upsert<E extends EntityName>(entity: E, input: RowInput<E>): Promise<EntityMap[E]> {
    this.assertEntity(entity)
    await this.turn()
    const raw = input as Record<string, unknown>
    const suppliedId = raw.id
    const id = typeof suppliedId === 'string' && suppliedId !== '' ? suppliedId : randomUUID()
    const existing = this.readRow(entity, id)
    const timestamp = this.now()

    const payload: Record<string, unknown> = { ...defaultsFor(entity) }
    if (existing !== null) Object.assign(payload, existing.payload)
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'id' || value === undefined) continue
      // No vault value is ever written into a synced row (vault/redact.ts): chat items, turns, memory, tasks.
      payload[key] = redactDeep(value)
    }
    if (existing === null && typeof payload.createdAt !== 'number') payload.createdAt = timestamp
    if (UPDATED_AT_ENTITIES.has(entity)) payload.updatedAt = timestamp

    const writer = currentWriter()
    this.oneCommit(() => {
      if (entity === 'memory') this.keepVersion(id, existing === null || existing.deleted ? null : existing.payload, payload, writer)
      const stamp = encodeStamp(this.hlc.now())
      this.db
        .prepare(
          `INSERT INTO rows(entity, cid, stamp, deleted, payload, local)
           VALUES(?, ?, ?, 0, ?, 1)
           ON CONFLICT(entity, cid) DO UPDATE SET
             stamp = excluded.stamp,
             deleted = 0,
             payload = excluded.payload,
             local = 1`,
        )
        .run(entity, id, stamp, JSON.stringify(payload))
      this.logChange(entity, id, '')
    })

    const saved = { id, ...payload } as EntityMap[E]
    this.emit({ entity, row: saved })
    return saved
  }

  async remove(entity: EntityName, id: string): Promise<void> {
    this.assertEntity(entity)
    await this.turn()
    const existing = this.readRow(entity, id)
    if (existing === null) return
    const writer = currentWriter()
    this.oneCommit(() => {
      if (entity === 'memory' && !existing.deleted) this.keepVersion(id, existing.payload, null, writer)
      const stamp = encodeStamp(this.hlc.now())
      this.db
        .prepare('UPDATE rows SET stamp = ?, deleted = 1, local = 1 WHERE entity = ? AND cid = ?')
        .run(stamp, entity, id)
      this.logChange(entity, id, '')
    })
    this.emit({ entity, id, deleted: true })
  }

  /** Wipe the synced rows and the watermarks. The device id is kept so HLC stamps stay stable. */
  async clearAll(): Promise<void> {
    this.dropList(null)
    this.db.exec('DELETE FROM rows')
    this.db.exec('DELETE FROM memory_versions')
    this.db.exec('DELETE FROM change_log')
    this.db.prepare("DELETE FROM kv WHERE k IN ('push_mark', 'cursor')").run()
    for (const entity of ENTITY_NAMES) this.emit({ entity, reset: true })
  }

  /**
   * Many writes as one: a single transaction, and one change event per entity at the end (an import of
   * thousands of rows must not make the window reload thousands of times).
   */
  async batch<T>(work: () => Promise<T>): Promise<T> {
    if (this.batching !== null) return work()
    const touched: StoreChange[] = []
    this.batching = touched
    this.db.exec('BEGIN')
    this.inTransaction = true
    try {
      const result = await work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.dropList(null)
      throw error
    } finally {
      this.inTransaction = false
      this.batching = null
      this.announce(touched)
    }
  }

  /** A few changes go out one by one; a flood becomes one reset per entity, so the window reads the list once. */
  private announce(changes: StoreChange[]): void {
    const perEntity = new Map<EntityName, StoreChange[]>()
    for (const change of changes) {
      const list = perEntity.get(change.entity)
      if (list === undefined) perEntity.set(change.entity, [change])
      else list.push(change)
    }
    for (const [entity, list] of perEntity) {
      if (list.length > MAX_BATCH_CHANGES) this.emit({ entity, reset: true })
      else if (list.length > MAX_SINGLE_CHANGES) this.emit({ entity, reset: true, batch: lastPerRow(list) })
      else for (const change of list) this.emit(change)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.checkpointer?.stop()
    this.checkpointer = null
    this.db.close()
  }

  /**
   * Checkpoints move to a worker thread (db-checkpoint.ts): the main connection stops checkpointing inside its own
   * writes. If the worker cannot run, the main connection checkpoints again as before.
   */
  startCheckpointer(options: { everyMs?: number; log?: (line: string, detail?: Record<string, unknown>) => void } = {}): boolean {
    if (this.closed || this.checkpointer !== null || this.file === ':memory:' || this.file === '') return false
    this.db.exec('PRAGMA wal_autocheckpoint = 0')
    let slowLogged = 0
    this.checkpointer = startCheckpointWorker(this.file, {
      everyMs: options.everyMs,
      onReport: (report) => {
        if (report.ok && (report.ms ?? 0) > 1_000 && Date.now() - slowLogged > 60_000) {
          slowLogged = Date.now()
          options.log?.('Slow checkpoint (off the main thread)', { ms: report.ms, pages: report.log })
        }
      },
      onFail: (why) => {
        this.checkpointer = null
        if (this.closed) return
        try {
          this.db.exec('PRAGMA wal_autocheckpoint = 1000')
        } catch {
          // closed meanwhile
        }
        options.log?.('Checkpoint worker stopped; checkpoints run inline again', { why })
      },
    })
    return true
  }

  /** The connection's settings that matter for speed (tests and diagnostics). */
  pragmas(): { synchronous: number; autocheckpoint: number; cacheSize: number } {
    const one = (name: string): number => numberField(Object.values(this.db.prepare(`PRAGMA ${name}`).get() ?? {})[0])
    return { synchronous: one('synchronous'), autocheckpoint: one('wal_autocheckpoint'), cacheSize: one('cache_size') }
  }

  // ---- memory versions ----

  /** Every kept version of one memory page, newest first. Kept on this device (each device keeps what it saw). */
  memoryHistory(memoryId: string): MemoryVersion[] {
    return this.db
      .prepare('SELECT memory_id, n, at, by, reason, changed, deleted, payload FROM memory_versions WHERE memory_id = ? ORDER BY n DESC')
      .all(memoryId)
      .map((row) => {
        let payload: Record<string, unknown> = {}
        let changed: string[] = []
        try {
          payload = JSON.parse(stringField(row['payload'])) as Record<string, unknown>
          changed = JSON.parse(stringField(row['changed'])) as string[]
        } catch {
          // A damaged entry still shows when and who.
        }
        return {
          memoryId: stringField(row['memory_id']),
          n: numberField(row['n']),
          at: numberField(row['at']),
          by: stringField(row['by']),
          reason: stringField(row['reason']),
          changed,
          deleted: numberField(row['deleted']) === 1,
          ...versionFields(payload),
        }
      })
  }

  /** The newest version number of a page (0 when it has none yet). */
  memoryVersionCount(memoryId: string): number {
    const row = this.db.prepare('SELECT MAX(n) AS n FROM memory_versions WHERE memory_id = ?').get(memoryId)
    return row === undefined ? 0 : numberField(row['n'])
  }

  /**
   * Keeps a version of a memory page as it is written: `after` null means deleted. A page written before
   * versions existed first gets its old text kept as version 1, so its first change is never lost. A write that
   * changes none of the kept fields (only a timestamp) keeps nothing.
   */
  private keepVersion(memoryId: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null, who: MemoryWriter): void {
    let n = this.memoryVersionCount(memoryId)
    const at = this.now()
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO memory_versions(memory_id, n, at, by, reason, changed, deleted, payload) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
    )
    if (n === 0 && before !== null) {
      n = 1
      const when = numberField(before['updatedAt']) || numberField(before['createdAt']) || at
      insert.run(memoryId, n, when, 'earlier', '', JSON.stringify(['created']), 0, JSON.stringify(versionFields(before)))
    }
    let changed: string[]
    if (after === null) changed = ['deleted']
    else if (before === null) changed = ['created']
    else changed = changedFields(versionFields(before), versionFields(after))
    if (changed.length === 0) return
    n += 1
    const fields = versionFields(after ?? before ?? {})
    insert.run(memoryId, n, at, who.by.slice(0, 80), who.reason ?? '', JSON.stringify(changed), after === null ? 1 : 0, JSON.stringify(fields))
    if (n > MAX_VERSIONS) this.db.prepare('DELETE FROM memory_versions WHERE memory_id = ? AND n <= ?').run(memoryId, n - MAX_VERSIONS)
  }

  // ---- SyncStore ----

  async localChanges(afterStamp: string | null): Promise<Change[]> {
    const after = afterStamp === null ? null : decodeStamp(afterStamp)
    const changes: Change[] = []
    const statement = this.db.prepare(
      'SELECT cid, stamp, deleted, payload FROM rows WHERE entity = ? AND local = 1',
    )
    for (const entity of ENTITY_NAMES) {
      for (const row of statement.all(entity)) {
        const stored = rowFromSql(row)
        const stamp = decodeStamp(stored.stamp)
        if (stamp === null) continue
        if (after !== null && compareStamps(stamp, after) <= 0) continue
        changes.push({
          entity,
          id: stored.cid,
          deleted: stored.deleted,
          stamp: stored.stamp,
          payload: { ...stored.payload },
        })
      }
    }
    changes.sort((a, b) => compareStampStrings(a.stamp, b.stamp))
    return changes
  }

  /**
   * Apply changes from another device. `via` names the peer node that handed them over ('' for the sync service),
   * so the change log never hands a change back to the peer it came from.
   */
  async applyRemote(changes: Change[], via = ''): Promise<void> {
    await this.turn()
    // One transaction for the whole page, not two commits per change: a pull of 200 changes was 400 commits on the
    // main thread (30 Oct 2026). Inside a batch() the batch's transaction already covers it.
    if (this.batching !== null || this.inTransaction || changes.length < 2) return this.applyRemoteRows(changes, via)
    this.db.exec('BEGIN')
    this.inTransaction = true
    try {
      const touched = this.applyRemoteRows(changes, via, true)
      this.db.exec('COMMIT')
      this.inTransaction = false
      this.announce(touched)
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.inTransaction = false
      this.dropList(null)
      throw error
    }
  }

  private applyRemoteRows(changes: Change[], via: string): void
  private applyRemoteRows(changes: Change[], via: string, hold: true): StoreChange[]
  private applyRemoteRows(changes: Change[], via: string, hold = false): StoreChange[] | void {
    const touched: StoreChange[] = []
    /** Helper cards (chat_item ids) whose end is kept over an incoming stale "working" write. */
    const keep: string[] = []
    for (const change of changes) {
      if (!isEntityName(change.entity)) continue
      const remote = decodeStamp(change.stamp)
      if (remote === null) continue
      // Our own echo: do not fold it into the clock and do not clobber newer local work.
      if (remote.device === this.deviceId) continue

      this.hlc.observe(remote)
      const existing = this.readRow(change.entity, change.id)
      if (existing !== null) {
        const local = decodeStamp(existing.stamp)
        if (local !== null && compareStamps(local, remote) >= 0) continue
        // A helper's end beats a stale "working" write of the same run (another device wrote it from the card as it
        // was before the end reached it): ours is kept and stamped again, so it reaches that device and wins there too.
        if (!existing.deleted && !change.deleted && endedBeatsWorking(change.entity, existing.payload, change.payload)) {
          keep.push(change.id)
          continue
        }
      }
      const payload = { ...change.payload }
      if (typeof payload.createdAt !== 'number') payload.createdAt = this.now()
      if (change.entity === 'memory') {
        const before = existing === null || existing.deleted ? null : existing.payload
        if (!(before === null && change.deleted)) this.keepVersion(change.id, before, change.deleted ? null : payload, { by: 'another device' })
      }

      this.db
        .prepare(
          `INSERT INTO rows(entity, cid, stamp, deleted, payload, local)
           VALUES(?, ?, ?, ?, ?, 0)
           ON CONFLICT(entity, cid) DO UPDATE SET
             stamp = excluded.stamp,
             deleted = excluded.deleted,
             payload = excluded.payload,
             local = 0`,
        )
        .run(change.entity, change.id, change.stamp, change.deleted ? 1 : 0, JSON.stringify(payload))
      this.logChange(change.entity, change.id, via)
      touched.push(change.deleted ? { entity: change.entity, id: change.id, deleted: true } : { entity: change.entity, row: { id: change.id, ...payload } as EntityMap[EntityName] })
    }
    for (const id of new Set(keep)) {
      const kept = this.readRow('chat_item', id)
      if (kept === null) continue
      // Stamped after the clock saw the stale write, so it is newer than it everywhere.
      this.db.prepare('UPDATE rows SET stamp = ?, local = 1 WHERE entity = ? AND cid = ?').run(encodeStamp(this.hlc.now()), 'chat_item', id)
      this.logChange('chat_item', id, '')
    }
    if (hold) return touched
    this.announce(touched)
  }

  async pushMark(): Promise<string | null> {
    return this.kv('push_mark')
  }

  async setPushMark(stamp: string): Promise<void> {
    this.setKv('push_mark', stamp)
  }

  async cursor(): Promise<number> {
    const value = this.kv('cursor')
    if (value === null) return 0
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }

  async setCursor(seq: number): Promise<void> {
    this.setKv('cursor', String(Math.max(0, Math.floor(seq))))
  }

  // ---- change log (replication between nodes, docs/devices-protocol.md s7) ----

  /** The newest change-log sequence number (0 when nothing has changed yet). */
  logSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS seq FROM change_log').get()
    return row === undefined ? 0 : numberField(row['seq'])
  }

  /**
   * Rows changed after `seq`, oldest first, as they are now, each with its log seq. Entries that came from
   * `skipVia` are passed over (the peer already has them) but still move the cursor. Nothing while a batch is
   * open, so a change that may yet roll back never leaves this device.
   */
  changesAfter(seq: number, limit = 500, skipVia = '', entities?: readonly string[]): { changes: Change[]; cursor: number } {
    const after = Math.max(0, Math.floor(seq))
    if (this.batching !== null) return { changes: [], cursor: after }
    // Only some entities (a peer backfilling kinds of rows it did not know before): read just those.
    const only = entities === undefined ? null : [...new Set(entities.filter(isEntityName))]
    if (only !== null && only.length === 0) return { changes: [], cursor: after }
    const entries = this.db
      .prepare(
        `SELECT l.seq AS seq, l.entity AS entity, l.cid AS cid, l.via AS via, r.stamp AS stamp, r.deleted AS deleted, r.payload AS payload
         FROM change_log l LEFT JOIN rows r ON r.entity = l.entity AND r.cid = l.cid
         WHERE l.seq > ?${only === null ? '' : ` AND l.entity IN (${only.map(() => '?').join(', ')})`} ORDER BY l.seq LIMIT ?`,
      )
      .all(after, ...(only ?? []), Math.max(1, Math.floor(limit)))
    const changes: Change[] = []
    let cursor = after
    for (const entry of entries) {
      cursor = numberField(entry['seq'])
      const entity = stringField(entry['entity'])
      if (!isEntityName(entity) || typeof entry['stamp'] !== 'string') continue
      if (skipVia !== '' && stringField(entry['via']) === skipVia) continue
      changes.push({
        entity,
        id: stringField(entry['cid']),
        deleted: numberField(entry['deleted']) === 1,
        stamp: stringField(entry['stamp']),
        payload: parsePayload(entry['payload']),
        seq: cursor,
      })
    }
    return { changes, cursor }
  }

  /** A small value kept on this device only (replication cursors). */
  localValue(key: string): string | null {
    return this.kv(`local:${key}`)
  }

  setLocalValue(key: string, value: string): void {
    this.setKv(`local:${key}`, value)
  }

  private logChange(entity: EntityName, cid: string, via: string): void {
    this.dropList(entity)
    this.db.prepare('INSERT OR REPLACE INTO change_log(entity, cid, via) VALUES(?, ?, ?)').run(entity, cid, via)
  }

  // ---- events ----

  onChange(listener: StoreChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(change: StoreChange): void {
    if (this.batching !== null) {
      this.batching.push(change)
      return
    }
    for (const listener of this.listeners) {
      try {
        listener(change)
      } catch {
        // A listener is UI code; one failing must not break a write.
      }
    }
  }

  // ---- internals ----

  private readEntity(entity: EntityName): StoredRow[] {
    return this.db
      .prepare('SELECT cid, stamp, deleted, payload FROM rows WHERE entity = ?')
      .all(entity)
      .map(rowFromSql)
  }

  private readRow(entity: EntityName, id: string): StoredRow | null {
    const row = this.db
      .prepare('SELECT cid, stamp, deleted, payload FROM rows WHERE entity = ? AND cid = ?')
      .get(entity, id)
    return row === undefined ? null : rowFromSql(row)
  }

  private kv(key: string): string | null {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key)
    const value = row === undefined ? undefined : row['v']
    return typeof value === 'string' ? value : null
  }

  private setKv(key: string, value: string): void {
    this.db
      .prepare('INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(key, value)
  }

  private assertEntity(entity: string): asserts entity is EntityName {
    if (!isEntityName(entity)) throw new Error(`Unknown entity: ${entity}`)
  }
}

/** The SQL of a listWhere, or null when nothing can match (an empty kinds list, a kind outside it). */
function listWhereSql(entity: EntityName, where: ListWhere): { sql: string; args: Array<string | number> } | null {
  const clauses = ['entity = ?', 'deleted = 0']
  const args: Array<string | number> = [entity]
  if (where.thread !== undefined) {
    clauses.push("json_extract(payload, '$.thread') = ?")
    args.push(where.thread)
  }
  if (where.kinds !== undefined && where.kinds.length === 0) return null
  if (where.kind !== undefined && where.kinds !== undefined && !where.kinds.includes(where.kind)) return null
  const wanted = [...new Set(where.kind !== undefined ? [where.kind] : (where.kinds ?? []))]
  if (wanted.length === 1) {
    clauses.push(`${KIND_SQL} = ?`)
    args.push(wanted[0]!)
  } else if (wanted.length > 1) {
    clauses.push(`${KIND_SQL} IN (${wanted.map(() => '?').join(', ')})`)
    args.push(...wanted)
  }
  const except = where.exceptKinds ?? []
  if (except.length > 0) {
    clauses.push(`${KIND_SQL} NOT IN (${except.map(() => '?').join(', ')})`)
    args.push(...except)
  }
  if (where.statuses !== undefined) {
    if (where.statuses.length === 0) return null
    const statuses = [...new Set(where.statuses)]
    clauses.push(`${STATUS_SQL} IN (${statuses.map(() => '?').join(', ')})`)
    args.push(...statuses)
  }
  if (where.contains !== undefined && where.contains !== '') {
    clauses.push('instr(payload, ?) > 0')
    args.push(where.contains)
  }
  if (where.chat !== undefined) {
    clauses.push(`${CHAT_KEY} = ?`)
    args.push(where.chat === '' ? 'main' : where.chat)
  }
  if (where.since !== undefined && where.since > 0) {
    clauses.push(`${CREATED_SQL} > ?`)
    args.push(where.since)
  }
  if (where.before !== undefined && where.before > 0) {
    clauses.push(`${CREATED_SQL} < ?`)
    args.push(where.before)
  }
  // The index is named, never left to the planner: with no statistics SQLite picked rows_created (to skip a sort)
  // and read every row of the entity, 0.4 to 1.8 s on the main thread per query on 60,000 chat rows (28 Oct 2026).
  const index =
    where.thread !== undefined
      ? 'rows_thread_at'
      : where.chat !== undefined
        ? 'rows_chat_kind_at'
        : wanted.length > 0 || except.length > 0
          ? 'rows_kind_at'
          : where.statuses !== undefined
            ? 'rows_status_at'
            : 'rows_created'
  const order = where.newestFirst === true ? 'DESC' : 'ASC'
  let sql = `SELECT cid, stamp, deleted, payload FROM rows INDEXED BY ${index} WHERE ${clauses.join(' AND ')} ORDER BY ${CREATED_SQL} ${order}, stamp ${order}`
  if (where.limit !== undefined && where.limit > 0) {
    sql += ' LIMIT ?'
    args.push(Math.floor(where.limit))
  }
  return { sql, args }
}

/** One change per row (the last one), in the order they happened. */
function lastPerRow(changes: StoreChange[]): StoreChange[] {
  const last = new Map<string, StoreChange>()
  changes.forEach((change, at) => {
    const id = change.id ?? (change.row as { id?: string } | undefined)?.id ?? `#${at}`
    last.delete(id)
    last.set(id, change)
  })
  return [...last.values()]
}

function yieldNow(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** A chat row's chat ('main' when untagged), read from its payload. */
function chatOfPayload(payload: Record<string, unknown>): string {
  const meta = payload['meta']
  if (typeof meta !== 'string' || !meta.includes('"chat"')) return 'main'
  try {
    const chat = (JSON.parse(meta) as { chat?: unknown }).chat
    return typeof chat === 'string' && chat !== '' ? chat : 'main'
  } catch {
    return 'main'
  }
}

function rowFromSql(row: Record<string, SQLOutputValue>): StoredRow {
  return {
    cid: stringField(row['cid']),
    stamp: stringField(row['stamp']),
    deleted: numberField(row['deleted']) === 1,
    payload: parsePayload(row['payload']),
  }
}

function stringField(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

function numberField(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function parsePayload(value: SQLOutputValue | undefined): Record<string, unknown> {
  if (typeof value !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Rows in store order (createdAt, then stamp), each stamp decoded once rather than on every comparison. */
function sortedRows(rows: StoredRow[], newestFirst: boolean): StoredRow[] {
  const keyed = rows.map((row) => ({ row, at: numberField(row.payload.createdAt), stamp: decodeStamp(row.stamp) }))
  keyed.sort((a, b) => {
    const byTime =
      a.at === b.at
        ? a.stamp === null || b.stamp === null
          ? a.row.stamp < b.row.stamp
            ? -1
            : a.row.stamp > b.row.stamp
              ? 1
              : 0
          : compareStamps(a.stamp, b.stamp)
        : a.at < b.at
          ? -1
          : 1
    return newestFirst ? -byTime : byTime
  })
  return keyed.map((entry) => entry.row)
}

function compareStampStrings(a: string, b: string): number {
  const left = decodeStamp(a)
  const right = decodeStamp(b)
  if (left === null || right === null) return a < b ? -1 : a > b ? 1 : 0
  return compareStamps(left, right)
}

const HELPER_ENDED: ReadonlySet<unknown> = new Set(['done', 'failed', 'stopped'])

function helperMeta(payload: Record<string, unknown>): Record<string, unknown> | null {
  if (payload['kind'] !== 'helper' || typeof payload['meta'] !== 'string') return null
  try {
    const meta = JSON.parse(payload['meta']) as unknown
    return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Is `ours` a helper card that ended, and `incoming` the same run's card still saying working? Then the end wins
 * whatever the stamps say. A new run (a push, a resume) carries a new runToken, so it is never held back by this.
 * Exported for tests.
 */
export function endedBeatsWorking(entity: string, ours: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  if (entity !== 'chat_item') return false
  const mine = helperMeta(ours)
  const theirs = helperMeta(incoming)
  if (mine === null || theirs === null) return false
  if (!HELPER_ENDED.has(mine['state']) || theirs['state'] !== 'working') return false
  const token = typeof mine['runToken'] === 'string' ? mine['runToken'] : ''
  return token !== '' && theirs['runToken'] === token
}

/** Sensible starting values so a partial input still produces a complete row. */
function defaultsFor(entity: EntityName): Record<string, unknown> {
  switch (entity) {
    case 'chat_item':
      return { kind: 'user', text: '', meta: '{}' }
    case 'turn':
      return { thread: 'main', json: '{}' }
    case 'memory':
      return {
        title: '',
        body: '',
        kind: 'fact',
        topics: '',
        pinned: false,
        source: 'user',
        updatedAt: 0,
      }
    case 'goal':
      return { title: '', why: '', status: 'open' }
    case 'task':
      return {
        goalId: null,
        title: '',
        notes: '',
        status: 'todo',
        dueAt: null,
        owner: 'user',
        blocker: '',
        updatedAt: 0,
      }
    case 'trigger':
      return {
        name: '',
        kind: 'daily',
        spec: '',
        prompt: '',
        enabled: true,
        lastRunAt: null,
        lastResult: '',
      }
    case 'project':
      return { name: '', description: '', icon: { glyph: 'folder', color: 'iris' }, path: '', profile: '', hidden: false, chats: [] }
    case 'device':
      return { name: '', kind: 'desktop', platform: 'linux', roles: [], priority: 0, urls: [], fp: '', facts: {}, pairedAt: 0, lastSeen: 0, revoked: false }
    case 'device_command':
      return { target: '', kind: 'notify', status: 'queued', note: '', chat: 'main', brainId: '', expiresAt: 0, updatedAt: 0 }
    case 'turn_lease':
      return { kind: 'turn', chatId: 'main', messageId: '', brainId: '', status: 'running', attempt: 1, heartbeatAt: 0, startedAt: 0, prompt: '' }
    case 'job':
      return { kind: 'msg', device: '', from: '', helper: '', op: '', text: '', item: '', status: 'sent', info: '', at: 0 }
    case 'prompt_rule':
      return { text: '', reason: '', status: 'active', updatedAt: 0, history: [] }
    case 'wakeup':
      return {
        kind: 'wake', wake: '', severity: 'urgent', title: '', whatToDo: '', source: { kind: 'agent', ref: '', link: '' }, devices: 'auto', targets: [],
        dedupeKey: '', rateKey: '', at: 0, firedBy: '', firedOn: '', withdrawn: false, cancelled: false, repeats: 0, updatedAt: 0,
        by: '', byName: '', n: 0, until: 0, device: '',
      }
    case 'miniapp':
      return {
        name: '', description: '', icon: 'apps', profile: '', files: {}, permissions: [], subscribe: [], refreshMinutes: 0, version: 1, history: [],
        pinned: 0, allowed: [], data: {}, check: { version: 0, at: 0, ok: false, issues: [], shots: [] }, by: '', openedAt: 0, updatedAt: 0,
      }
  }
}
