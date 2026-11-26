/** One boundary for child pipes, including SDK-owned children. No input or command arguments are logged. */
import { createRequire, syncBuiltinESMExports } from 'node:module'
import type * as ChildProcesses from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

const pipeFailure = Symbol.for('agent.childPipeFailure')
const socketOwned = Symbol.for('agent.socketOwnerHandles')
const failures = new WeakMap<object, Error>()
const ownerCleanup = new WeakMap<object, () => void>()

/** Launchers register their existing tree cleanup before any pipe failure can settle their owner. */
export function registerChildPipeCleanup(child: object, cleanup: () => void): void { ownerCleanup.set(child, cleanup) }
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
  if (!codes.has(codeOf(error))) { if (Reflect.get(error, socketOwned) !== true) fault(error); return }
  Reflect.set(error, pipeFailure, true)
  warn('Process pipe ended', { message: error.message, code: codeOf(error) })
}

export function childPipeFailure(child: object): Error | undefined { return failures.get(child) }

type PipeGuard = (stream: Readable | Writable | null | undefined, ended: (error: Error) => void) => void

/** Self-contained so the off-thread host can install this exact guard in its own Node isolate. */
export function createPipeGuard(report: (error: Error) => void): PipeGuard {
  const guarded = new WeakSet<object>()
  const delivered = new WeakSet<Error>()
  const codes = new Set(['EOF', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])
  const codeOf = (error: unknown): string => typeof error === 'object' && error !== null ? String((error as NodeJS.ErrnoException).code ?? '') : ''
  return (stream, ended): void => {
    if (stream == null || guarded.has(stream)) return
    guarded.add(stream)
    let reported = false
    const fail = (reason: unknown): void => {
      const error = reason instanceof Error ? reason : new Error(String(reason))
      if (delivered.has(error)) return
      delivered.add(error)
      const expected = codes.has(codeOf(error))
      if (expected && reported) return
      if (expected) reported = true
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
    if (failures.has(child)) {
      if (!codes.has(codeOf(error)) && child.listenerCount('error') > 0) child.emit('error', error)
      return
    }
    const reason = Object.assign(new Error(`engine process ended: ${error.message}`), { code: codeOf(error) })
    if (isChildPipeError(error)) Reflect.set(reason, pipeFailure, true)
    failures.set(child, reason)
    const cleanup = ownerCleanup.get(child)
    try { cleanup?.() } finally {
      try {
        if (child.listenerCount('error') > 0) child.emit('error', reason)
      } finally {
        if (cleanup === undefined && child.exitCode === null && child.signalCode === null) terminatePipeChild(child)
      }
    }
  }
  for (const stream of new Set([child.stdin, child.stdout, child.stderr, ...child.stdio])) guardOwnedStream(stream, ended)
  return child
}

/** Bounded shutdown preserves the existing exit/close owner path, including lost OS events.
 * Self-contained so the off-thread host uses the same lifecycle in its isolate. */
export function terminatePipeChild(child: ChildProcess): void {
  let exited = child.exitCode != null || child.signalCode != null
  if (exited) return
  let exitDelivered = false, closed = false
  let exitCode: number | null = -1, exitSignal: NodeJS.Signals | null = 'SIGKILL'
  let force: NodeJS.Timeout | undefined, finish: NodeJS.Timeout | undefined
  const originalEmit = child.emit
  child.emit = function (this: ChildProcess, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'exit') {
      if (exitDelivered || closed) return false
      exitDelivered = true; exited = true
      exitCode = args[0] as number | null; exitSignal = args[1] as NodeJS.Signals | null
      clearTimeout(force); clearTimeout(finish)
      // Exit does not guarantee drained stdio/close. Keep a separate, bounded close deadline.
      finish = setTimeout(() => { if (!closed) child.emit('close', exitCode, exitSignal) }, 250)
      finish.unref()
    }
    if (event === 'close') {
      if (closed) return false
      closed = true; exited = true
      clearTimeout(force); clearTimeout(finish)
    }
    return Reflect.apply(originalEmit, this, [event, ...args])
  } as typeof child.emit
  finish = setTimeout(() => {
    if (!exited) child.emit('exit', -1, 'SIGKILL')
    if (!closed) child.emit('close', exitCode, exitSignal)
  }, 750)
  finish.unref()
  if (process.platform === 'win32') {
    // Node terminates the process HANDLE it owns. Never look up a potentially recycled PID.
    try { child.kill('SIGKILL') } catch { /* The bounded owner deadline still runs. */ }
  } else {
    force = setTimeout(() => {
      if (exited) return
      try { child.kill('SIGKILL') } catch { /* OS may already have reaped it. */ }
    }, 500)
    force.unref()
    try { child.kill('SIGTERM') } catch { /* Escalation and owner deadline still run. */ }
  }
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

const hadOwner = new WeakMap<object, boolean>()

/** True when something other than our guard listens for this stream's errors: it was there before the guard
 * (a once listener is gone by the time it fires) or was added since (the guard's own listener is one). */
function ownedStream(stream: Readable | Writable): boolean {
  const listening = stream.listenerCount('error') > 1
  const owned = hadOwner.get(stream) === true || listening
  // A once owner covers one error: with no listener left, a later error is ownerless again, as on devices.
  if (!listening) hadOwner.set(stream, false)
  return owned
}

/** A stream whose owner handles errors keeps handling every unexpected one itself: only expected EOF/EPIPE
 * style failures are absorbed here, so an error the owner already handles never becomes a crash dialog. */
export function guardOwnedStream(stream: Readable | Writable | null | undefined, ended: (error: Error) => void): void {
  if (stream == null) return
  if (!hadOwner.has(stream)) hadOwner.set(stream, stream.listenerCount('error') > 0)
  guardPipe(stream, (error) => {
    if (!codes.has(codeOf(error)) && ownedStream(stream)) { Reflect.set(error, socketOwned, true); return }
    ended(error)
  })
}

function guardSocket(socket: Writable): void {
  guardOwnedStream(socket, (error) => socket.destroy(error))
}

/** Socket close/error listeners remain responsible for request rejection and reconnect state. */
export function safeSocketWrite(socket: Writable, data: string | Uint8Array): boolean {
  guardSocket(socket)
  return socket.write(data)
}

/** Rejection/control responses also write bytes through end(data), before normal socket owners exist. */
export function safeSocketEnd(socket: Writable, data: string | Uint8Array): void {
  guardSocket(socket)
  socket.end(data)
}
