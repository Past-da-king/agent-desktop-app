import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerStore } from '../src/main/workers/store'
import { Supervisor } from '../src/main/workers/supervisor'
import { waitFor } from '../../../packages/core/test/helpers'
import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { guardChild, guardPipe, childPipeFailure, isChildPipeError, safeSocketWrite, createPipeGuard } from '../src/main/runtime/safe-pipe'
import { uncaughtHandler, uncaughtPolicy } from '../src/main/alive'

function pipeError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code, stack: `Error: write ${code}\n at WriteWrap.onWriteComplete (node:internal/stream_base_commons:51:19)` })
}

describe('dead process pipes', () => {
  it('uses the same self-contained pipe guard in a separate worker isolate', async () => {
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads')
      const { PassThrough } = require('node:stream')
      const factory = eval('(' + workerData + ')')
      const stream = new PassThrough()
      let ended = 0
      factory(() => undefined)(stream, () => { ended += 1 })
      stream.destroy(Object.assign(new Error('write EOF'), { code: 'EOF' }))
      setImmediate(() => parentPort.postMessage({ ended, late: stream.write('late') }))
    `, { eval: true, workerData: createPipeGuard.toString() })
    try {
      const [result] = await once(worker, 'message')
      expect(result).toEqual({ ended: 1, late: false })
    } finally { await worker.terminate() }
  })

  it('keeps real programming mistakes visible', () => {
    const stream = new PassThrough()
    stream.write = (() => { throw new TypeError('bad input') }) as typeof stream.write
    guardPipe(stream, vi.fn())
    expect(() => stream.write('text')).toThrow('bad input')
  })

  it.each(['stay', 'every'] as const)('a real supervised %s worker leaves running state and retains its pipe failure even on exit 0', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'pipe-owner-'))
    const store = new WorkerStore(root)
    const child = guardChild(spawn(process.execPath, ['-e', "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); process.stdin.resume();setInterval(() => {},1000)"], { stdio: 'pipe' }))
    store.write({ id: 'w_pipe01', name: 'Pipe test', about: '', entry: 'main.mjs', runtime: 'node', args: [], mode, everyMinutes: mode === 'every' ? 5 : null, secrets: [], enabled: true, createdAt: 1, updatedAt: 1 }, { 'main.mjs': '' })
    const supervisor = new Supervisor({ store, spawn: () => child, failLimit: 1, secrets: { get: () => null, set: () => undefined } })
    try {
      await once(child.stdout!, 'data')
      supervisor.start()
      child.stdin!.emit('error', pipeError('EOF'))
      await waitFor(() => supervisor.info()[0]?.state === 'failing', 3000)
      expect(supervisor.info()[0]?.lastError).toContain('engine process ended: write EOF')
      expect(supervisor.info()[0]?.state).not.toBe('running')
    } finally { supervisor.stopAll(); child.kill('SIGKILL'); store.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('guards SDK-style ESM spawns through the installed Node boundary', async () => {
    // Isolate the global Node export hook so it cannot affect later Vitest files.
    const moduleUrl = new URL('../src/main/runtime/safe-pipe.ts', import.meta.url).href
    const script = `
      import { spawn } from 'node:child_process'
      import { installChildPipeGuards, childPipeFailure } from ${JSON.stringify(moduleUrl)}
      installChildPipeGuards()
      const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe' })
      let reason = ''
      child.on('error', error => { reason = error.message })
      const closed = new Promise(resolve => child.once('close', resolve))
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
      await closed
      process.stdout.write(JSON.stringify({ reason, retained: childPipeFailure(child)?.message }))
    `
    const fixture = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    fixture.stdout!.on('data', chunk => { stdout += String(chunk) })
    fixture.stderr!.on('data', chunk => { stderr += String(chunk) })
    try {
      const [code] = await once(fixture, 'close')
      expect(code, stderr).toBe(0)
      const result = JSON.parse(stdout) as { reason: string; retained: string }
      expect(result.reason).toContain('engine process ended: write EPIPE')
      expect(result.retained).toBe(result.reason)
    } finally { fixture.kill('SIGKILL') }
  })

  it.each(['EOF', 'EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'])('classifies %s low-level writes without hiding real faults', (code) => {
    expect(uncaughtPolicy(pipeError(code))).toBe('log')
    expect(uncaughtPolicy(new Error('ordinary failure'))).toBe('dialog')
    expect(isChildPipeError(Object.assign(new Error('application failure'), { code }))).toBe(false)
  })

  it('rate limits a fault burst while logging every real fault', () => {
    let now = 0
    const dialog = vi.fn(), log = vi.fn(), warn = vi.fn()
    const handle = uncaughtHandler({ dialog, log, warn, now: () => now })
    handle(new Error('one')); handle(new Error('two'))
    now = 14_000; handle(new Error('three')); handle(pipeError('EOF'))
    expect(dialog).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledTimes(3)
    expect(warn).toHaveBeenCalledTimes(1)
    now = 30_000; handle(new Error('four'))
    expect(dialog).toHaveBeenCalledTimes(2)
  })

  it('reports one end for asynchronous callback and error-event delivery', async () => {
    const stream = new PassThrough()
    const ended = vi.fn()
    guardPipe(stream, ended)
    stream.destroy(pipeError('EPIPE'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(stream.write('late')).toBe(false)
    expect(ended).toHaveBeenCalledTimes(1)
    const callback = vi.fn()
    stream.end(callback)
    await new Promise((resolve) => setImmediate(resolve))
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('uses the socket close path on a synchronous write failure', () => {
    const socket = new PassThrough()
    socket.write = (() => { throw pipeError('EOF') }) as typeof socket.write
    expect(safeSocketWrite(socket, 'frame')).toBe(false)
    expect(socket.destroyed).toBe(true)
  })

  it('real engine dies mid-write: its owner fails with a reason and no uncaught exception', async () => {
    const child = guardChild(spawn(process.execPath, ['-e', "process.stdout.write('ready'); process.stdin.resume(); setInterval(() => {}, 1000)"], { stdio: 'pipe' }))
    let state = 'working'
    let reason = ''
    const uncaught = vi.fn()
    process.on('uncaughtException', uncaught)
    child.on('error', (error) => { state = 'failed'; reason = error.message })
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    try {
      await once(child.stdout!, 'data')
      const writeErrors: Error[] = []
      // More than a pipe buffer: a real OS write remains pending when the child is killed.
      child.stdin!.write(Buffer.alloc(4 * 1024 * 1024), (error) => { if (error) writeErrors.push(error) })
      child.kill('SIGKILL')
      for (let i = 0; i < 10; i++) child.stdin!.write('mid-stream chunk', (error) => { if (error) writeErrors.push(error) })
      await closed
      for (let i = 0; i < 10; i++) child.stdin!.write('late chunk')
      await new Promise((resolve) => setImmediate(resolve))
      expect(writeErrors.length).toBeGreaterThan(0)
      expect(state).toBe('failed')
      expect(reason).toContain('engine process ended:')
      expect(childPipeFailure(child)?.message).toBe(reason)
      expect(uncaught).not.toHaveBeenCalled()
    } finally {
      process.removeListener('uncaughtException', uncaught)
      child.kill('SIGKILL')
    }
  })
})


describe('review regressions', () => {
  it('guards rejection response end payloads before an asynchronous EOF', async () => {
    const { acceptUpgrade } = await import('../src/main/devices/ws')
    const socket = new PassThrough()
    const observed = vi.fn()
    socket.on('error', observed)
    acceptUpgrade({ headers: {} } as never, socket as never)
    expect(socket.listenerCount('error')).toBeGreaterThan(1)
    socket.emit('error', pipeError('EOF'))
    expect(socket.destroyed).toBe(true)
  })

  it('bounded child termination completes exit owners once even without OS exit events', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [], exitCode: null, signalCode: null, kill: vi.fn(() => true) })
    guardChild(child as never)
    const exit = vi.fn(), error = vi.fn()
    child.on('exit', exit); child.on('error', error)
    child.stdin.emit('error', pipeError('EOF'))
    await new Promise(resolve => setTimeout(resolve, 1300))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(exit).toHaveBeenCalledTimes(1)
    child.emit('exit', 0, null)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
  })

  it.each(['event', 'callback'])('unexpected asynchronous %s errors reach the owner and fault path', async (delivery) => {
    const api = await import('../src/main/runtime/safe-pipe')
    const fault = vi.fn(), ended = vi.fn()
    // Optional lookup lets the old implementation fail on behavior rather than module resolution.
    const register = Reflect.get(api, 'onPipeFault') as ((handler: (error: Error) => void) => void) | undefined
    register?.(fault)
    const stream = new PassThrough()
    const failure = new TypeError('unexpected stream defect')
    if (delivery === 'callback') stream.write = ((_data: unknown, callback: (error: Error) => void) => { queueMicrotask(() => callback(failure)); return true }) as typeof stream.write
    api.guardPipe(stream, ended)
    if (delivery === 'event') stream.emit('error', failure)
    else stream.write('payload')
    await new Promise(resolve => setImmediate(resolve))
    expect(ended).toHaveBeenCalledWith(failure)
    expect(fault).toHaveBeenCalledWith(failure)
    expect(api.isChildPipeError(failure)).toBe(false)
    register?.(() => undefined)
  })
})


it('kills a real child which ignores SIGTERM and ends its existing owner', async () => {
  const child = guardChild(spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: 'pipe' }))
  const exit = vi.fn()
  child.on('exit', exit); child.on('error', () => undefined)
  try {
    await once(child.stdout!, 'data')
    const closed = new Promise(resolve => child.once('close', resolve))
    child.stdin!.emit('error', pipeError('EOF'))
    await Promise.race([closed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('child never exited')), 1800); timer.unref() })])
    expect(child.signalCode).toBe('SIGKILL')
    expect(exit).toHaveBeenCalledTimes(1)
    expect(childPipeFailure(child)?.message).toContain('write EOF')
  } finally { child.kill('SIGKILL') }
})


describe('review round two regressions', () => {
  it.each(['exit', 'close', 'timer race'])('never launches Windows taskkill after child %s', async (ending) => {
    const { terminatePipeChild } = await import('../src/main/runtime/safe-pipe')
    const timers: Array<() => void> = []
    const spawn = vi.fn(() => new EventEmitter())
    let load!: (value: { spawn: typeof spawn }) => void
    const loaded = new Promise<{ spawn: typeof spawn }>(resolve => { load = resolve })
    const run = new Function('process', 'loadChildProcesses', 'setTimeout', 'clearTimeout', 'return (' + terminatePipeChild.toString().replace(/(?:import|__vite_ssr_dynamic_import__)\(['"]node:child_process['"]\)/, 'loadChildProcesses()') + ')')(
      { platform: 'win32' }, () => loaded,
      (callback: () => void) => { timers.push(callback); return { unref: () => undefined } }, () => undefined,
    ) as typeof terminatePipeChild
    const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null, kill: vi.fn(() => true) })
    run(child as never)
    if (ending === 'timer race') timers[0]!()
    child.emit(ending === 'close' ? 'close' : 'exit', 0, null)
    load({ spawn })
    await new Promise(resolve => setImmediate(resolve))
    expect(spawn).not.toHaveBeenCalled()
    const kills = child.kill.mock.calls.length
    for (const timer of timers) timer()
    expect(child.kill).toHaveBeenCalledTimes(kills)
  })

  it('delivers a distinct TypeError after EOF to the child owner and real-fault handler', async () => {
    const api = await import('../src/main/runtime/safe-pipe')
    const fault = vi.fn(), owner = vi.fn()
    api.onPipeFault(fault)
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), stdio: [], exitCode: 0, signalCode: null, kill: vi.fn() })
    child.on('error', owner)
    api.guardChild(child as never)
    const error = new TypeError('distinct fault after EOF')
    try {
      child.stdin.emit('error', pipeError('EOF'))
      child.stdin.emit('error', pipeError('EOF'))
      child.stdin.emit('error', error)
      expect(owner).toHaveBeenCalledTimes(2)
      expect(owner.mock.calls[1]?.[0].message).toContain('distinct fault after EOF')
      expect(fault).toHaveBeenCalledWith(error)
    } finally { api.onPipeFault(() => undefined) }
  })
})


describe('review round three regressions', () => {
  it('Windows shutdown never launches PID-based kills and uses one owned-handle kill', async () => {
    const { terminatePipeChild } = await import('../src/main/runtime/safe-pipe')
    const timers: Array<() => void> = [], spawn = vi.fn(() => new EventEmitter())
    const run = new Function('process', 'loadChildProcesses', 'setTimeout', 'clearTimeout', 'return (' + terminatePipeChild.toString().replace(/(?:import|__vite_ssr_dynamic_import__)\(['"]node:child_process['"]\)/, 'loadChildProcesses()') + ')')(
      { platform: 'win32' }, () => Promise.resolve({ spawn }),
      (callback: () => void) => { timers.push(callback); return { unref: () => undefined } }, () => undefined,
    ) as typeof terminatePipeChild
    const child = Object.assign(new EventEmitter(), { pid: 123456, exitCode: null, signalCode: null, kill: vi.fn(() => true) })
    run(child as never)
    await new Promise(resolve => setImmediate(resolve))
    for (const timer of [...timers]) timer()
    expect(spawn).not.toHaveBeenCalled()
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
    child.emit('exit', 0, null)
    for (const timer of [...timers]) timer()
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('one unexpected Writable callback/event error reports once but a distinct error survives', async () => {
    const api = await import('../src/main/runtime/safe-pipe')
    const first = new TypeError('one fault delivered twice'), second = new TypeError('a distinct fault')
    const owner = vi.fn(), fault = vi.fn()
    const stream = new Writable({ write(_chunk, _encoding, callback) { callback(first) } })
    api.onPipeFault(fault)
    api.guardPipe(stream, owner)
    try {
      stream.write('payload')
      await new Promise(resolve => setImmediate(resolve))
      expect(owner).toHaveBeenCalledTimes(1)
      expect(fault).toHaveBeenCalledExactlyOnceWith(first)
      stream.emit('error', second)
      expect(owner).toHaveBeenCalledTimes(2)
      expect(fault).toHaveBeenNthCalledWith(2, second)
    } finally { api.onPipeFault(() => undefined) }
  })

  it('completes missing close after real exit without delivering exit twice', async () => {
    const { terminatePipeChild } = await import('../src/main/runtime/safe-pipe')
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => true) })
    const exit = vi.fn(), close = vi.fn()
    child.on('exit', exit); child.on('close', close)
    terminatePipeChild(child as never)
    child.emit('exit', 7, null)
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(exit).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledExactlyOnceWith(7, null)
    child.emit('close', 7, null)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
