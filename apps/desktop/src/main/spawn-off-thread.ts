import { createPipeGuard, reportPipeFailure, terminatePipeChild } from './runtime/safe-pipe'
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
const terminatePipeChild = ${terminatePipeChild.toString()}
let pipeEnded = false
let pipeFailureMessage = null
const pipeFailed = (error) => {
  if (pipeEnded) return
  pipeEnded = true
  pipeFailureMessage = { failed: 'engine process ended: ' + String(error.message || error), pipe: true, code: error.code }
  terminatePipeChild(child)
}
const guardPipe = (${createPipeGuard.toString()})(() => undefined)
for (const pipe of [child.stdin, child.stdout, child.stderr]) guardPipe(pipe, pipeFailed)
child.on('error', (error) => { parentPort.postMessage({ failed: String(error && error.message || error) }); process.exit(0) })
child.on('exit', (code) => { if (pipeFailureMessage) parentPort.postMessage(pipeFailureMessage); parentPort.postMessage({ exit: code === null ? -1 : code }); process.exit(0) })
parentPort.on('message', (m) => {
  try {
    if (typeof m.write === 'string') child.stdin.write(m.write)
    if (m.end === true) child.stdin.end()
    if (m.kill === true) child.kill()
  } catch (error) { pipeFailed(error) }
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
  worker.on('message', (m: { out?: string; err?: string; failed?: string; pipe?: boolean; code?: string; exit?: number; started?: number }) => {
    if (typeof m.started === 'number') child['pid'] = m.started
    if (typeof m.out === 'string') stdout.emit('data', m.out)
    if (typeof m.err === 'string') stderr.emit('data', m.err)
    if (typeof m.failed === 'string' && !ended) {
      const error = Object.assign(new Error(m.failed), { code: m.code })
      if (m.pipe) reportPipeFailure(error)
      try {
        if (!m.pipe || child.listenerCount('error') > 0) child.emit('error', error)
      } finally { end(-1) }
    }
    if (typeof m.exit === 'number') end(m.exit)
  })
  worker.on('error', (error) => {
    if (ended) return
    try { child.emit('error', error) } finally { end(-1) }
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
