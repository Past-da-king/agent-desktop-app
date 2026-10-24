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

import { changedFields, currentWriter, versionFields, type MemoryWriter } from './memory/history'
import { redactDeep } from './vault/redact'

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
 * A chat row's chat, read inside SQLite: `meta` is JSON text inside the payload JSON. Rows of the first chat carry
 * no tag. Only well-formed meta is looked into, so a damaged row never breaks a query.
 */
const CHAT_SQL = "CASE WHEN json_valid(json_extract(payload, '$.meta')) THEN json_extract(json_extract(payload, '$.meta'), '$.chat') END"

const ENTITY_NAMES: readonly EntityName[] = ['chat_item', 'turn', 'memory', 'goal', 'task', 'trigger', 'project', 'device', 'device_command', 'turn_lease', 'job', 'prompt_rule']

/** Versions kept per memory page; the oldest go first. */
const MAX_VERSIONS = 300

const UPDATED_AT_ENTITIES: ReadonlySet<EntityName> = new Set(['memory', 'task', 'prompt_rule'])

export class Store implements SyncStore {
  readonly deviceId: string
  private readonly db: DatabaseSync
  private readonly hlc: Hlc
  private readonly now: () => number
  private readonly listeners = new Set<StoreChangeListener>()
  private closed = false
  /** While a batch runs, changes are collected here and announced once at the end. */
  private batching: StoreChange[] | null = null

  constructor(file: string, clock: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.now = clock
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
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
      CREATE INDEX IF NOT EXISTS rows_thread ON rows(entity, json_extract(payload, '$.thread'));
      CREATE INDEX IF NOT EXISTS rows_kind ON rows(entity, json_extract(payload, '$.kind'));
      CREATE INDEX IF NOT EXISTS rows_created ON rows(entity, json_extract(payload, '$.createdAt'));
      CREATE INDEX IF NOT EXISTS rows_chat ON rows(entity, ${CHAT_SQL});
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
    const rows = this.readEntity(entity).filter((row) => !row.deleted)
    return sortedRows(rows, false).map((row) => ({ id: row.cid, ...row.payload }) as EntityMap[E])
  }

  /**
   * The rows that match, read inside SQLite (indexed), instead of every row of the entity parsed and filtered in
   * JavaScript: a conversation's own turns, a chat's dividers, the newest user message.
   */
  async listWhere<E extends EntityName>(entity: E, where: ListWhere): Promise<Array<EntityMap[E]>> {
    this.assertEntity(entity)
    const clauses = ['entity = ?', 'deleted = 0']
    const args: Array<string | number> = [entity]
    if (where.thread !== undefined) {
      clauses.push("json_extract(payload, '$.thread') = ?")
      args.push(where.thread)
    }
    if (where.kind !== undefined) {
      clauses.push("json_extract(payload, '$.kind') = ?")
      args.push(where.kind)
    }
    if (where.chat !== undefined) {
      if (where.chat === 'main') clauses.push(`(${CHAT_SQL} IS NULL OR ${CHAT_SQL} = '' OR ${CHAT_SQL} = 'main')`)
      else {
        clauses.push(`${CHAT_SQL} = ?`)
        args.push(where.chat)
      }
    }
    if (where.since !== undefined && where.since > 0) {
      clauses.push("json_extract(payload, '$.createdAt') > ?")
      args.push(where.since)
    }
    const order = where.newestFirst === true ? 'DESC' : 'ASC'
    let sql = `SELECT cid, stamp, deleted, payload FROM rows WHERE ${clauses.join(' AND ')} ORDER BY json_extract(payload, '$.createdAt') ${order}, stamp ${order}`
    if (where.limit !== undefined && where.limit > 0) {
      sql += ' LIMIT ?'
      args.push(Math.floor(where.limit))
    }
    const rows = this.db.prepare(sql).all(...args).map(rowFromSql)
    return sortedRows(rows, where.newestFirst === true).map((row) => ({ id: row.cid, ...row.payload }) as EntityMap[E])
  }

  async get<E extends EntityName>(entity: E, id: string): Promise<EntityMap[E] | null> {
    this.assertEntity(entity)
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

    if (entity === 'memory') this.keepVersion(id, existing === null || existing.deleted ? null : existing.payload, payload, currentWriter())
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

    const saved = { id, ...payload } as EntityMap[E]
    this.emit({ entity, row: saved })
    return saved
  }

  async remove(entity: EntityName, id: string): Promise<void> {
    this.assertEntity(entity)
    const existing = this.readRow(entity, id)
    if (existing === null) return
    if (entity === 'memory' && !existing.deleted) this.keepVersion(id, existing.payload, null, currentWriter())
    const stamp = encodeStamp(this.hlc.now())
    this.db
      .prepare('UPDATE rows SET stamp = ?, deleted = 1, local = 1 WHERE entity = ? AND cid = ?')
      .run(stamp, entity, id)
    this.logChange(entity, id, '')
    this.emit({ entity, id, deleted: true })
  }

  /** Wipe the synced rows and the watermarks. The device id is kept so HLC stamps stay stable. */
  async clearAll(): Promise<void> {
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
    try {
      const result = await work()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    } finally {
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
      if (list.length > MAX_SINGLE_CHANGES) this.emit({ entity, reset: true })
      else for (const change of list) this.emit(change)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
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
    const touched: StoreChange[] = []
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
  changesAfter(seq: number, limit = 500, skipVia = ''): { changes: Change[]; cursor: number } {
    const after = Math.max(0, Math.floor(seq))
    if (this.batching !== null) return { changes: [], cursor: after }
    const entries = this.db
      .prepare(
        `SELECT l.seq AS seq, l.entity AS entity, l.cid AS cid, l.via AS via, r.stamp AS stamp, r.deleted AS deleted, r.payload AS payload
         FROM change_log l LEFT JOIN rows r ON r.entity = l.entity AND r.cid = l.cid
         WHERE l.seq > ? ORDER BY l.seq LIMIT ?`,
      )
      .all(after, Math.max(1, Math.floor(limit)))
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
  }
}
