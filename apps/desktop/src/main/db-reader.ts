/**
 * Large SQLite reads off the main thread (30 Oct 2026).
 *
 * One read of a heavy table held the main thread for 54 s with little free memory, because every page of it had to
 * come back from disk while nothing else could run. WAL lets other connections read while the main one writes, so
 * reads of the big tables run in worker threads with their own read-only connection. Rows come back in small chunks,
 * each asked for after the one before was handled, so the main thread only ever parses a little at a time and memory
 * never fills with rows it has not looked at.
 *
 * A worker runs ONE statement at a time on one connection. Two open statements on a connection would share one read
 * snapshot, and the second would miss a write committed after the first began; with one at a time, every read starts
 * after the writes before it and sees them.
 */
import { Worker } from 'node:worker_threads'

/** The worker's code: plain CommonJS, so it needs no bundle entry of its own. */
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(workerData.file, { readOnly: true })
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA cache_size = -' + workerData.cacheKb)
db.exec('PRAGMA mmap_size = 0')
const prepared = new Map()
let open = null
function statementOf(sql) {
  let s = prepared.get(sql)
  if (s === undefined) {
    if (prepared.size >= 64) prepared.clear()
    s = db.prepare(sql)
    prepared.set(sql, s)
  }
  return s
}
function finish(job) {
  open = null
  if (job.bytes > 33554432) { try { db.exec('PRAGMA shrink_memory') } catch {} }
}
function step() {
  const job = open
  if (job === null) return
  const chunk = []
  let size = 0
  try {
    for (;;) {
      const next = job.it.next()
      if (next.done) {
        finish(job)
        parentPort.postMessage({ id: job.id, rows: chunk, done: true })
        return
      }
      const r = next.value
      const payload = typeof r.payload === 'string' ? r.payload : ''
      chunk.push([String(r.cid), String(r.stamp), Number(r.deleted) === 1 ? 1 : 0, payload])
      size += payload.length
      job.bytes += payload.length
      if (size >= workerData.chunkBytes || chunk.length >= workerData.chunkRows) break
    }
    parentPort.postMessage({ id: job.id, rows: chunk, done: false })
  } catch (error) {
    finish(job)
    parentPort.postMessage({ id: job.id, rows: [], done: true, error: String((error && error.message) || error) })
  }
}
parentPort.on('message', (m) => {
  if (m.stop === true) {
    try { if (open !== null) open.it.return() } catch {}
    try { db.close() } catch {}
    process.exit(0)
  }
  if (m.cancel === true) {
    try { if (open !== null) open.it.return() } catch {}
    open = null
    return
  }
  if (m.next === true) return step()
  try {
    open = { id: m.id, it: statementOf(m.sql).iterate(...m.args), bytes: 0 }
    step()
  } catch (error) {
    open = null
    parentPort.postMessage({ id: m.id, rows: [], done: true, error: String((error && error.message) || error) })
  }
})
parentPort.postMessage({ ready: true })
`

/** [cid, stamp, deleted (0 or 1), payload text] */
export type RawRow = [string, string, number, string]

export interface ReadStats {
  rows: number
  bytes: number
  /** Time spent waiting for a free worker. */
  waitMs: number
  ms: number
}

export interface ReaderOptions {
  file: string
  /** Workers at most. The second starts only when the first is busy. */
  size?: number
  chunkBytes?: number
  chunkRows?: number
  /** Page cache per connection, KB. Small: these reads move through a table once, they do not revisit it. */
  cacheKb?: number
  /** A worker failed; nothing more will be read through this reader. */
  onFail?: (why: string) => void
}

interface Job {
  id: number
  sql: string
  args: Array<string | number>
  onRows: (rows: RawRow[]) => void
  resolve: (stats: ReadStats) => void
  reject: (error: Error) => void
  queuedAt: number
  startedAt: number
  rows: number
  bytes: number
}

interface Slot {
  worker: Worker
  job: Job | null
}

export class DbReader {
  private readonly slots: Slot[] = []
  private readonly waiting: Job[] = []
  private nextId = 1
  private stopped = false
  private failed = false

  constructor(private readonly options: ReaderOptions) {
    this.spawn()
  }

  /** False once a worker failed or it was stopped: the caller reads on its own connection instead. */
  get usable(): boolean {
    return !this.stopped && !this.failed
  }

  get workers(): number {
    return this.slots.length
  }

  /** Runs a query in a worker. `onRows` gets each chunk in order, on the main thread, between other events. */
  read(sql: string, args: Array<string | number>, onRows: (rows: RawRow[]) => void): Promise<ReadStats> {
    if (!this.usable) return Promise.reject(new Error('Reader stopped'))
    return new Promise<ReadStats>((resolve, reject) => {
      this.waiting.push({ id: this.nextId++, sql, args, onRows, resolve, reject, queuedAt: performance.now(), startedAt: 0, rows: 0, bytes: 0 })
      this.dispatch()
    })
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    const why = new Error('Reader stopped')
    for (const job of this.waiting.splice(0)) job.reject(why)
    for (const slot of this.slots.splice(0)) {
      slot.job?.reject(why)
      slot.job = null
      try {
        slot.worker.postMessage({ stop: true })
      } catch {
        // already gone
      }
      void slot.worker.terminate().catch(() => undefined)
    }
  }

  private spawn(): Slot | null {
    try {
      const worker = new Worker(WORKER_CODE, {
        eval: true,
        workerData: { file: this.options.file, cacheKb: this.options.cacheKb ?? 8192, chunkBytes: this.options.chunkBytes ?? 128 * 1024, chunkRows: this.options.chunkRows ?? 200 },
      })
      worker.unref()
      const slot: Slot = { worker, job: null }
      worker.on('message', (m: { ready?: boolean; id?: number; rows?: RawRow[]; done?: boolean; error?: string }) => this.onMessage(slot, m))
      worker.on('error', (error) => this.fail(error.message))
      worker.on('exit', (code) => {
        if (!this.stopped) this.fail(`reader worker exited (${code})`)
      })
      this.slots.push(slot)
      return slot
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error))
      return null
    }
  }

  private dispatch(): void {
    while (this.usable && this.waiting.length > 0) {
      let slot = this.slots.find((each) => each.job === null) ?? null
      if (slot === null && this.slots.length < (this.options.size ?? 2)) slot = this.spawn()
      if (slot === null) return
      const job = this.waiting.shift()
      if (job === undefined) return
      slot.job = job
      job.startedAt = performance.now()
      slot.worker.postMessage({ id: job.id, sql: job.sql, args: job.args })
    }
  }

  private onMessage(slot: Slot, m: { ready?: boolean; id?: number; rows?: RawRow[]; done?: boolean; error?: string }): void {
    if (m.ready === true) return
    const job = slot.job
    if (job === null || job.id !== m.id) return
    if (typeof m.error === 'string') {
      slot.job = null
      job.reject(new Error(m.error))
      this.dispatch()
      return
    }
    const rows = m.rows ?? []
    job.rows += rows.length
    for (const row of rows) job.bytes += row[3].length
    try {
      if (rows.length > 0) job.onRows(rows)
    } catch (error) {
      slot.job = null
      try {
        slot.worker.postMessage({ cancel: true })
      } catch {
        // already gone
      }
      job.reject(error instanceof Error ? error : new Error(String(error)))
      this.dispatch()
      return
    }
    if (m.done === true) {
      slot.job = null
      const now = performance.now()
      job.resolve({ rows: job.rows, bytes: job.bytes, waitMs: job.startedAt - job.queuedAt, ms: now - job.queuedAt })
      this.dispatch()
      return
    }
    slot.worker.postMessage({ next: true })
  }

  private fail(why: string): void {
    if (this.failed || this.stopped) return
    this.failed = true
    const error = new Error(why)
    for (const job of this.waiting.splice(0)) job.reject(error)
    for (const slot of this.slots.splice(0)) {
      slot.job?.reject(error)
      slot.job = null
      void slot.worker.terminate().catch(() => undefined)
    }
    this.options.onFail?.(why)
  }
}
