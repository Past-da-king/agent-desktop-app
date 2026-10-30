/**
 * Where workers live (docs/workers-and-triggers.md): one folder per worker under `<userData>/workers/<id>/` with its
 * worker.json and code, plus one local database for what the app learns about them (cursor, last stop, counts) and
 * the events they emit. Nothing here syncs: event payloads are other people's messages and stay on this computer.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { join, normalize, relative, sep } from 'node:path'

import {
  WORKER_ID,
  parseManifest,
  payloadText,
  type WorkerEvent,
  type WorkerEventInput,
  type WorkerEventStatus,
  type WorkerLogLine,
  type WorkerManifest,
} from '@agent/core'

/** What the app remembers about a worker between runs. */
export interface WorkerRuntimeState {
  cursor: string
  /** When it last stopped for any reason; handed back on the next start. */
  stoppedAt: number | null
  lastEventAt: number | null
  lastLineAt: number | null
  lastError: string
  /** Day key (local date) the two counters below belong to. */
  day: string
  eventsToday: number
  restartsToday: number
  lastGap: { from: number; to: number; caughtUp: number } | null
  /** The process id while it runs, so a worker left behind by a crashed app can be found and ended. */
  pid: number | null
}

const EMPTY_STATE: WorkerRuntimeState = {
  cursor: '',
  stoppedAt: null,
  lastEventAt: null,
  lastLineAt: null,
  lastError: '',
  day: '',
  eventsToday: 0,
  restartsToday: 0,
  lastGap: null,
  pid: null,
}

export const EVENT_KEEP_DAYS = 14
export const EVENT_KEEP_ROWS = 10_000
const LOG_MAX_BYTES = 512_000
const MANIFEST = 'worker.json'
const SECRET_DROP = 'secrets.drop.json'
const MAX_FILE_BYTES = 400_000
const MAX_FILES = 40

export class WorkerStore {
  readonly root: string
  private readonly db: DatabaseSync
  private readonly now: () => number
  /** False once closed (the app is quitting): late writes from a dying worker are dropped, never thrown. */
  private open = true

  constructor(root: string, now: () => number = Date.now) {
    this.root = root
    this.now = now
    mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(join(root, 'workers.db'))
    this.db.exec('PRAGMA journal_mode = WAL')
    // Main-thread writes: sync only at checkpoints, not on every commit (30 Oct 2026 hangs, see db.ts).
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS worker_state(id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_events(
        id TEXT PRIMARY KEY,
        worker TEXT NOT NULL,
        source TEXT NOT NULL,
        event TEXT NOT NULL,
        payload TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        routine TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        UNIQUE(worker, dedupe_key)
      );
      CREATE INDEX IF NOT EXISTS worker_events_received ON worker_events(received_at);
      CREATE INDEX IF NOT EXISTS worker_events_status ON worker_events(status);
    `)
  }

  close(): void {
    this.open = false
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }

  // ---- folders and manifests ----

  dirOf(id: string): string {
    if (!WORKER_ID.test(id)) throw new Error(`Not a worker id: ${id}`)
    return join(this.root, id)
  }

  newId(): string {
    let id = ''
    do id = `w_${randomBytes(4).toString('hex')}`
    while (existsSync(join(this.root, id)))
    return id
  }

  /** Every worker folder with a readable worker.json. A broken one is listed with its problem, never hidden. */
  manifests(): Array<{ manifest: WorkerManifest | null; id: string; problem: string }> {
    const out: Array<{ manifest: WorkerManifest | null; id: string; problem: string }> = []
    for (const name of safeReaddir(this.root)) {
      if (!WORKER_ID.test(name)) continue
      const file = join(this.root, name, MANIFEST)
      if (!existsSync(file)) continue
      const parsed = parseManifest(readFileSync(file, 'utf8'), name)
      if (typeof parsed === 'string') out.push({ manifest: null, id: name, problem: parsed })
      else out.push({ manifest: parsed, id: name, problem: '' })
    }
    return out
  }

  manifest(id: string): WorkerManifest | null {
    const file = join(this.dirOf(id), MANIFEST)
    if (!existsSync(file)) return null
    const parsed = parseManifest(readFileSync(file, 'utf8'), id)
    return typeof parsed === 'string' ? null : parsed
  }

  /** Writes the manifest and the given files into the worker's folder. Paths must stay inside it. */
  write(manifest: WorkerManifest, files: Record<string, string>): void {
    const dir = this.dirOf(manifest.id)
    const entries = Object.entries(files)
    if (entries.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files.`)
    for (const [name, content] of entries) {
      if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error(`${name} is too big (at most ${MAX_FILE_BYTES} bytes).`)
      this.insidePath(dir, name)
      if (name === MANIFEST) throw new Error('worker.json is written from the manifest fields, not as a file.')
    }
    mkdirSync(join(dir, 'state'), { recursive: true })
    for (const [name, content] of entries) {
      const target = this.insidePath(dir, name)
      mkdirSync(join(target, '..'), { recursive: true })
      writeFileSync(target, content, 'utf8')
    }
    writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  }

  setEnabled(id: string, enabled: boolean): void {
    const manifest = this.manifest(id)
    if (manifest === null) return
    this.write({ ...manifest, enabled, updatedAt: this.now() }, {})
  }

  /** The text of a file in the worker's folder, for showing a change before it is approved. */
  readFile(id: string, name: string): string | null {
    const target = this.insidePath(this.dirOf(id), name)
    return existsSync(target) ? readFileSync(target, 'utf8') : null
  }

  remove(id: string): void {
    rmSync(this.dirOf(id), { recursive: true, force: true })
    this.db.prepare('DELETE FROM worker_state WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM worker_events WHERE worker = ?').run(id)
  }

  /**
   * Secrets dropped into the folder by a script (secrets.drop.json, {"NAME": "value"}) are taken into the encrypted
   * store and the file is deleted, so a key never has to pass through a chat.
   */
  takeSecretDrop(id: string): Record<string, string> {
    const file = join(this.dirOf(id), SECRET_DROP)
    if (!existsSync(file)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      const out: Record<string, string> = {}
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) if (typeof value === 'string') out[name] = value
      }
      return out
    } catch {
      return {}
    } finally {
      rmSync(file, { force: true })
    }
  }

  private insidePath(dir: string, name: string): string {
    const target = normalize(join(dir, name))
    const rel = relative(dir, target)
    if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || /^([a-zA-Z]:|[/\\])/.test(name)) {
      throw new Error(`${name} must be a file inside the worker folder.`)
    }
    return target
  }

  // ---- runtime state ----

  state(id: string): WorkerRuntimeState {
    if (!this.open) return { ...EMPTY_STATE }
    const row = this.db.prepare('SELECT json FROM worker_state WHERE id = ?').get(id)
    const base = { ...EMPTY_STATE }
    if (row === undefined) return base
    try {
      const parsed = JSON.parse(String(row['json'])) as Partial<WorkerRuntimeState>
      const merged = { ...base, ...parsed }
      const today = dayKey(this.now())
      if (merged.day !== today) return { ...merged, day: today, eventsToday: 0, restartsToday: 0 }
      return merged
    } catch {
      return base
    }
  }

  patchState(id: string, patch: Partial<WorkerRuntimeState>): WorkerRuntimeState {
    const next = { ...this.state(id), ...patch, day: dayKey(this.now()) }
    if (!this.open) return next
    this.db
      .prepare('INSERT INTO worker_state(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
      .run(id, JSON.stringify(next))
    return next
  }

  // ---- events ----

  /** Stores an event. Null when the same worker already sent this dedupeKey (a duplicate, dropped). */
  addEvent(worker: string, input: WorkerEventInput): WorkerEvent | null {
    if (!this.open) return null
    const receivedAt = this.now()
    const event: WorkerEvent = {
      id: `e_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      worker,
      source: input.source.slice(0, 80),
      event: input.event.slice(0, 120),
      payload: payloadText(input.payload),
      dedupeKey: input.dedupeKey,
      seenAt: input.seenAt ?? receivedAt,
      receivedAt,
      status: 'new',
      routine: '',
      note: '',
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO worker_events(id, worker, source, event, payload, dedupe_key, seen_at, received_at, status, routine, note)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
      )
      .run(event.id, worker, event.source, event.event, event.payload, event.dedupeKey, event.seenAt, receivedAt, 'new')
    if (Number(result.changes) === 0) return null
    return event
  }

  setStatus(ids: string[], status: WorkerEventStatus, routine: string, note: string): void {
    if (!this.open) return
    const statement = this.db.prepare('UPDATE worker_events SET status = ?, routine = ?, note = ? WHERE id = ?')
    for (const id of ids) statement.run(status, routine, note.slice(0, 500), id)
  }

  events(options: { worker?: string; status?: WorkerEventStatus; routine?: string; limit?: number; oldestFirst?: boolean } = {}): WorkerEvent[] {
    if (!this.open) return []
    const clauses: string[] = []
    const args: Array<string | number> = []
    if (options.worker !== undefined) {
      clauses.push('worker = ?')
      args.push(options.worker)
    }
    if (options.status !== undefined) {
      clauses.push('status = ?')
      args.push(options.status)
    }
    if (options.routine !== undefined) {
      clauses.push('routine = ?')
      args.push(options.routine)
    }
    const where = clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`
    // Arrival order is the row order. Never the wall clock: it can jump back (sleep, time sync) and reorder events.
    const order = options.oldestFirst === true ? 'ASC' : 'DESC'
    const limit = Math.max(1, Math.min(options.limit ?? 100, 5000))
    return this.db
      .prepare(`SELECT * FROM worker_events ${where} ORDER BY rowid ${order} LIMIT ${limit}`)
      .all(...args)
      .map(eventFromSql)
  }

  /** Events since a moment, for "caught up N" after a start. */
  countSince(worker: string, since: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM worker_events WHERE worker = ? AND received_at >= ?').get(worker, since)
    return Number(row?.['n'] ?? 0)
  }

  /** Keeps the last 14 days and at most 10,000 rows. */
  prune(): number {
    const before = this.now() - EVENT_KEEP_DAYS * 86_400_000
    let removed = Number(this.db.prepare("DELETE FROM worker_events WHERE received_at < ? AND status != 'new'").run(before).changes)
    const count = Number(this.db.prepare('SELECT COUNT(*) AS n FROM worker_events').get()?.['n'] ?? 0)
    if (count > EVENT_KEEP_ROWS) {
      removed += Number(
        this.db
          .prepare(`DELETE FROM worker_events WHERE id IN (SELECT id FROM worker_events WHERE status != 'new' ORDER BY rowid ASC LIMIT ?)`)
          .run(count - EVENT_KEEP_ROWS).changes,
      )
    }
    return removed
  }

  // ---- logs ----

  log(id: string, line: WorkerLogLine): void {
    const dir = join(this.dirOf(id), 'logs')
    const file = join(dir, 'worker.log')
    try {
      mkdirSync(dir, { recursive: true })
      if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) renameSync(file, join(dir, 'worker.1.log'))
      appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8')
    } catch {
      // A log that cannot be written must not stop the worker.
    }
  }

  logs(id: string, limit = 200): WorkerLogLine[] {
    const dir = join(this.dirOf(id), 'logs')
    const lines: string[] = []
    for (const name of ['worker.1.log', 'worker.log']) {
      const file = join(dir, name)
      if (existsSync(file)) lines.push(...readFileSync(file, 'utf8').split('\n').filter((l) => l !== ''))
    }
    return lines.slice(-Math.max(1, Math.min(limit, 2000))).map((line) => {
      try {
        return JSON.parse(line) as WorkerLogLine
      } catch {
        return { at: 0, level: 'info', text: line }
      }
    })
  }
}

function eventFromSql(row: Record<string, SQLOutputValue>): WorkerEvent {
  return {
    id: String(row['id']),
    worker: String(row['worker']),
    source: String(row['source']),
    event: String(row['event']),
    payload: String(row['payload']),
    dedupeKey: String(row['dedupe_key']),
    seenAt: Number(row['seen_at']),
    receivedAt: Number(row['received_at']),
    status: String(row['status']) as WorkerEventStatus,
    routine: String(row['routine'] ?? ''),
    note: String(row['note'] ?? ''),
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function dayKey(stamp: number): string {
  const date = new Date(stamp)
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
}
