/** One boundary for child pipes, including SDK-owned children. No input or command arguments are logged. */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import type * as ChildProcesses from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

const pipeFailure = Symbol.for('agent.childPipeFailure')
const failures = new WeakMap<object, Error>()
let fault: (error: Error) => void = (error) => { queueMicrotask(() => { throw error }) }
let warn: (message: string, fields: Record<string, unknown>) => void = () => undefined
const codes = new Set(['EOF', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])

function codeOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  return String((error as NodeJS.ErrnoException).code ?? '')
}

/** Only tagged pipe failures or Node's low-level write errors are safe to carry on from globally. */
export function isChildPipeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  if (Reflect.get(error, pipeFailure) === true) return true
  const e = error as Error
  const code = codeOf(error) || /^write (EOF|EPIPE|ECONNRESET)\b/.exec(e.message ?? '')?.[1] || ''
  return codes.has(code) && /stream_base_commons|WriteWrap|node:internal\/streams/.test(e.stack ?? '')
}

export function onPipeFault(handler: (error: Error) => void): void { fault = handler }

export function onPipeWarning(log: typeof warn): void { warn = log }

/** Shared warning/tag boundary for errors relayed from the off-thread process host. */
export function reportPipeFailure(error: Error): void {
  if (!codes.has(codeOf(error))) { fault(error); return }
  Reflect.set(error, pipeFailure, true)
  warn('Process pipe ended', { message: error.message, code: codeOf(error) })
}

export function childPipeFailure(child: object): Error | undefined { return failures.get(child) }

type PipeGuard = (stream: Readable | Writable | null | undefined, ended: (error: Error) => void) => void

/** Self-contained so the off-thread host can install this exact guard in its own Node isolate. */
export function createPipeGuard(report: (error: Error) => void): PipeGuard {
  const guarded = new WeakSet<object>()
  const codes = new Set(['EOF', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])
  const codeOf = (error: unknown): string => typeof error === 'object' && error !== null ? String((error as NodeJS.ErrnoException).code ?? '') : ''
  return (stream, ended): void => {
    if (stream == null || guarded.has(stream)) return
    guarded.add(stream)
    let reported = false
    const fail = (reason: unknown): void => {
      if (reported) return
      reported = true
      const error = reason instanceof Error ? reason : new Error(String(reason))
      try { ended(error) } finally { report(error) }
    }
    stream.on('error', fail)
    if (!('write' in stream)) return
    const writable = stream as Writable
    writable.write = new Proxy(writable.write, {
      apply(target, receiver, args: unknown[]) {
        if (writable.destroyed || writable.writableEnded || writable.writable === false) {
          const error = Object.assign(new Error('write ERR_STREAM_DESTROYED: process pipe ended'), { code: 'ERR_STREAM_DESTROYED' })
          fail(error)
          const callback = args.at(-1)
          if (typeof callback === 'function') queueMicrotask(() => callback(error))
          return false
        }
        const callback = typeof args.at(-1) === 'function' ? args.pop() as (error?: Error | null) => void : undefined
        args.push((error?: Error | null) => { if (error) fail(error); callback?.(error) })
        try { return Reflect.apply(target, receiver, args) }
        catch (error) {
          if (!codes.has(codeOf(error))) throw error
          fail(error); callback?.(error instanceof Error ? error : new Error(String(error))); return false
        }
      },
    })
    writable.end = new Proxy(writable.end, {
      apply(target, receiver, args: unknown[]) {
        try { return Reflect.apply(target, receiver, args) }
        catch (error) { if (!codes.has(codeOf(error))) throw error; fail(error); return receiver }
      },
    })
  }
}

/** Keep listeners for each stream's lifetime, including errors delivered after close. */
export const guardPipe: PipeGuard = createPipeGuard(reportPipeFailure)

/** Notify existing error/exit owners, then stop the child so their normal lifecycle completes. */
export function guardChild<T extends ChildProcess>(child: T): T {
  const ended = (error: Error): void => {
    if (failures.has(child)) return
    const reason = Object.assign(new Error(`engine process ended: ${error.message}`), { code: codeOf(error) })
    if (isChildPipeError(error)) Reflect.set(reason, pipeFailure, true)
    failures.set(child, reason)
    try {
      if (child.listenerCount('error') > 0) child.emit('error', reason)
    } finally {
      if (child.exitCode === null && child.signalCode === null) terminatePipeChild(child)
    }
  }
  for (const stream of new Set([child.stdin, child.stdout, child.stderr, ...child.stdio])) guardPipe(stream, ended)
  return child
}

/** Bounded shutdown preserves the existing exit/close owner path, including lost OS events.
 * Self-contained so the off-thread host uses the same lifecycle in its isolate. */
export function terminatePipeChild(child: ChildProcess): void {
  let exited = false, closed = false
  const originalEmit = child.emit
  child.emit = function (this: ChildProcess, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'exit') { if (exited) return false; exited = true }
    if (event === 'close') { if (closed) return false; closed = true }
    return Reflect.apply(originalEmit, this, [event, ...args])
  } as typeof child.emit
  const force = setTimeout(() => {
    if (exited) return
    try { child.kill('SIGKILL') } catch { /* OS may already have reaped it. */ }
    const finish = setTimeout(() => {
      if (!exited) child.emit('exit', -1, 'SIGKILL')
      if (!closed) child.emit('close', -1, 'SIGKILL')
    }, 250)
    finish.unref()
    child.once('close', () => clearTimeout(finish))
  }, 500)
  force.unref()
  child.once('exit', () => clearTimeout(force))
  // Windows kill() is process-only; taskkill also tears down descendants such as WSL hosts.
  if (process.platform === 'win32' && child.pid !== undefined) {
    void import('node:child_process').then(({ spawn }) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => undefined)
    }).catch(() => undefined)
  }
  else { try { child.kill('SIGTERM') } catch { /* Escalation and owner deadline still run. */ } }
}

let installed = false
/** Patch the public Node spawn boundary once, before runtime construction. syncBuiltinESMExports also
 * covers SDK ESM imports of spawn; a per-call wrapper would leave Codex's private stdin unprotected. */
export function installChildPipeGuards(): void {
  if (installed) return
  installed = true
  const cp = createRequire(import.meta.url)('node:child_process') as typeof ChildProcesses
  for (const key of ['spawn', 'execFile', 'fork'] as const) {
    const original = cp[key]
    Reflect.set(cp, key, new Proxy(original, {
      apply(target, receiver, args: unknown[]) { return guardChild(Reflect.apply(target, receiver, args) as ChildProcess) },
    }))
  }
  syncBuiltinESMExports()
}

/** Socket close/error listeners remain responsible for request rejection and reconnect state. */
export function safeSocketWrite(socket: Writable, data: string | Uint8Array): boolean {
  guardPipe(socket, (error) => socket.destroy(error))
  return socket.write(data)
}

/** Rejection/control responses also write bytes through end(data), before normal socket owners exist. */
export function safeSocketEnd(socket: Writable, data: string | Uint8Array): void {
  guardPipe(socket, (error) => socket.destroy(error))
  socket.end(data)
}
