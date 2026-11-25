import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerStore } from '../src/main/workers/store'
import { Supervisor } from '../src/main/workers/supervisor'
import { waitFor } from '../../../packages/core/test/helpers'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { guardChild, guardPipe, childPipeFailure, isChildPipeError, safeSocketWrite, installChildPipeGuards, createPipeGuard } from '../src/main/runtime/safe-pipe'
import { uncaughtHandler, uncaughtPolicy } from '../src/main/alive'

function pipeError(code: string): Error {
  return Object.assign(new Error(`write ${code}`), { code, stack: `Error: write ${code}\n at WriteWrap.onWriteComplete (node:internal/stream_base_commons:51:19)` })
}

describe('dead process pipes', () => {
  it('uses the same self-contained pipe guard in a separate worker isolate', async () => {
    const factory = new Function(`return (${createPipeGuard.toString()})`)() as typeof createPipeGuard
    const ended = vi.fn()
    const stream = new PassThrough()
    factory(vi.fn())(stream, ended)
    stream.destroy(pipeError('EOF'))
    await new Promise((resolve) => setImmediate(resolve))
    expect(ended).toHaveBeenCalledTimes(1)
    expect(stream.write('late')).toBe(false)
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
    installChildPipeGuards()
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe' })
    let reason = ''
    child.on('error', (error) => { reason = error.message })
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    child.stdin!.emit('error', pipeError('EPIPE'))
    await closed
    expect(reason).toContain('engine process ended: write EPIPE')
    expect(childPipeFailure(child)?.message).toBe(reason)
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
