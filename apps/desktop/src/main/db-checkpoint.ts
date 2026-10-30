/**
 * WAL checkpoints off the main thread (30 Oct 2026).
 *
 * The store writes on the main thread. With SQLite's default auto-checkpoint, every ~4 MB of log one ordinary
 * write also copies the log into the 400+ MB database and syncs both files, inside that write. On a busy disk (WSL
 * builds, a dozen helpers, little free memory) that one write took 0.3 to 2 s, and with many writes in a row
 * Windows marked the app "Not responding" and killed it. The main connection now never checkpoints
 * (wal_autocheckpoint = 0); a worker thread with its own connection does it every few seconds instead. A PASSIVE
 * checkpoint never takes the write lock, so it never makes a main-thread write wait.
 */
import { Worker } from 'node:worker_threads'

/** The worker's code: plain CommonJS, so it needs no bundle entry of its own. */
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(workerData.file)
db.exec('PRAGMA busy_timeout = 0')
let stopped = false
parentPort.on('message', (m) => { if (m === 'stop') { stopped = true; try { db.close() } catch {} ; process.exit(0) } })
function pass() {
  if (stopped) return
  const started = Date.now()
  try {
    const r = db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() || {}
    const ms = Date.now() - started
    parentPort.postMessage({ ok: true, ms, log: Number(r.log) || 0, done: Number(r.checkpointed) || 0 })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String(error && error.message || error) })
  }
  setTimeout(pass, workerData.everyMs).unref?.()
}
setTimeout(pass, workerData.everyMs)
`

export interface CheckpointReport {
  ok: boolean
  ms?: number
  log?: number
  done?: number
  error?: string
}

export interface Checkpointer {
  stop(): void
}

/**
 * Starts the worker for `file`. `onFail` runs once if the worker cannot start or dies, so the caller can turn the
 * main connection's auto-checkpoint back on (the log must never grow without bound).
 */
export function startCheckpointWorker(
  file: string,
  options: { everyMs?: number; onReport?: (report: CheckpointReport) => void; onFail: (why: string) => void },
): Checkpointer {
  let failed = false
  let stopping = false
  const fail = (why: string): void => {
    if (failed || stopping) return
    failed = true
    options.onFail(why)
  }
  let worker: Worker | null = null
  try {
    worker = new Worker(WORKER_CODE, { eval: true, workerData: { file, everyMs: options.everyMs ?? 2_000 } })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return { stop: () => undefined }
  }
  worker.unref()
  worker.on('message', (report: CheckpointReport) => options.onReport?.(report))
  worker.on('error', (error) => fail(error.message))
  worker.on('exit', (code) => {
    if (!stopping) fail(`checkpoint worker exited (${code})`)
  })
  return {
    stop: () => {
      if (stopping) return
      stopping = true
      try {
        worker?.postMessage('stop')
      } catch {
        // already gone
      }
      void worker?.terminate().catch(() => undefined)
    },
  }
}
