/**
 * A long-lived child process started from a worker thread. Node's spawn is synchronous: on a computer short of memory,
 * starting PowerShell held the main thread for 1.8 to 4.3 s (seen by the watchdog, 30 Oct 2026). The worker starts it
 * and passes its pipes across; to the caller it looks like the child itself.
 */
import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const child = spawn(workerData.file, workerData.args, { windowsHide: true, stdio: 'pipe' })
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (data) => parentPort.postMessage({ out: data }))
child.stderr.on('data', (data) => parentPort.postMessage({ err: data }))
child.stdin.on('error', () => undefined)
child.on('error', (error) => { parentPort.postMessage({ failed: String(error && error.message || error) }); process.exit(0) })
child.on('exit', (code) => { parentPort.postMessage({ exit: code === null ? -1 : code }); process.exit(0) })
parentPort.on('message', (m) => {
  try {
    if (typeof m.write === 'string') child.stdin.write(m.write)
    if (m.end === true) child.stdin.end()
    if (m.kill === true) child.kill()
  } catch {}
})
parentPort.postMessage({ started: child.pid })
`

/** Starts `file` from a worker. Throws only if the worker itself cannot start (the caller then spawns directly). */
export function spawnOffThread(file: string, args: string[]): ChildProcessWithoutNullStreams {
  const worker = new Worker(WORKER_CODE, { eval: true, workerData: { file, args } })
  worker.unref()
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  const stdout = Object.assign(new EventEmitter(), { setEncoding: () => stdout })
  const stderr = Object.assign(new EventEmitter(), { setEncoding: () => stderr })
  const post = (message: Record<string, unknown>): void => {
    try {
      worker.postMessage(message)
    } catch {
      // Already gone.
    }
  }
  const stdin = Object.assign(new EventEmitter(), {
    write: (text: string): boolean => {
      post({ write: text })
      return true
    },
    end: (): void => post({ end: true }),
  })
  let ended = false
  const end = (code: number): void => {
    if (ended) return
    ended = true
    child.emit('exit', code, null)
    void worker.terminate().catch(() => undefined)
  }
  worker.on('message', (m: { out?: string; err?: string; failed?: string; exit?: number; started?: number }) => {
    if (typeof m.started === 'number') child['pid'] = m.started
    if (typeof m.out === 'string') stdout.emit('data', m.out)
    if (typeof m.err === 'string') stderr.emit('data', m.err)
    if (typeof m.failed === 'string') {
      child.emit('error', new Error(m.failed))
      end(-1)
    }
    if (typeof m.exit === 'number') end(m.exit)
  })
  worker.on('error', (error) => {
    child.emit('error', error)
    end(-1)
  })
  worker.on('exit', () => end(-1))
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    kill: (): boolean => {
      post({ kill: true })
      return true
    },
  })
  return child as unknown as ChildProcessWithoutNullStreams
}
