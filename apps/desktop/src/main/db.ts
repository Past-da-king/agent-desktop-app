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
  type EntityMap,
  type EntityName,
  type RowInput,
  type SyncStore,
} from '@agent/core'

interface StoredRow {
  cid: string
  stamp: string
  deleted: boolean
  payload: Record<string, unknown>
}

export type StoreChangeListener = (entity: EntityName) => void

const ENTITY_NAMES: readonly EntityName[] = ['chat_item', 'turn', 'memory', 'goal', 'task', 'trigger', 'project']

const UPDATED_AT_ENTITIES: ReadonlySet<EntityName> = new Set(['memory', 'task'])

export class Store implements SyncStore {
  readonly deviceId: string
  private readonly db: DatabaseSync
  private readonly hlc: Hlc
  private readonly now: () => number
  private readonly listeners = new Set<StoreChangeListener>()
  private closed = false
  /** While a batch runs, changes are collected here and announced once at the end. */
  private batching: Set<EntityName> | null = null

  constructor(file: string, clock: () => number = Date.now) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.now = clock
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
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
      CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `)

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
    rows.sort((a, b) => {
      const left = numberField(a.payload.createdAt)
      const right = numberField(b.payload.createdAt)
      if (left !== right) return left < right ? -1 : 1
      return compareStampStrings(a.stamp, b.stamp)
    })
    return rows.map((row) => ({ id: row.cid, ...row.payload }) as EntityMap[E])
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
      payload[key] = value
    }
    if (existing === null && typeof payload.createdAt !== 'number') payload.createdAt = timestamp
    if (UPDATED_AT_ENTITIES.has(entity)) payload.updatedAt = timestamp

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

    this.emit(entity)
    return { id, ...payload } as EntityMap[E]
  }

  async remove(entity: EntityName, id: string): Promise<void> {
    this.assertEntity(entity)
    const existing = this.readRow(entity, id)
    if (existing === null) return
    const stamp = encodeStamp(this.hlc.now())
    this.db
      .prepare('UPDATE rows SET stamp = ?, deleted = 1, local = 1 WHERE entity = ? AND cid = ?')
      .run(stamp, entity, id)
    this.emit(entity)
  }

  /** Wipe the synced rows and the watermarks. The device id is kept so HLC stamps stay stable. */
  async clearAll(): Promise<void> {
    this.db.exec('DELETE FROM rows')
    this.db.prepare("DELETE FROM kv WHERE k IN ('push_mark', 'cursor')").run()
    for (const entity of ENTITY_NAMES) this.emit(entity)
  }

  /**
   * Many writes as one: a single transaction, and one change event per entity at the end (an import of
   * thousands of rows must not make the window reload thousands of times).
   */
  async batch<T>(work: () => Promise<T>): Promise<T> {
    if (this.batching !== null) return work()
    const touched = new Set<EntityName>()
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
      for (const entity of touched) this.emit(entity)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.db.close()
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

  async applyRemote(changes: Change[]): Promise<void> {
    const touched = new Set<EntityName>()
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
      touched.add(change.entity)
    }
    for (const entity of touched) this.emit(entity)
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

  // ---- events ----

  onChange(listener: StoreChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(entity: EntityName): void {
    if (this.batching !== null) {
      this.batching.add(entity)
      return
    }
    for (const listener of this.listeners) {
      try {
        listener(entity)
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
  }
}
