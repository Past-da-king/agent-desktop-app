import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { guardChild, onPipeFault, safeSocketWrite } from '../src/main/runtime/safe-pipe'
import { uncaughtHandler } from '../src/main/alive'

const ioError = (code: string): Error => Object.assign(new Error(`read ${code}`), { code, errno: -1, syscall: 'read' })

afterEach(() => { onPipeFault(() => undefined); vi.useRealTimers() })

describe('owners that already handle errors never turn them into faults', () => {
  it('a once("error") owner registered before the guard keeps its socket error', () => {
    const fault = vi.fn()
    onPipeFault(fault)
    const socket = new PassThrough(), owner = vi.fn()
    socket.once('error', owner)
    safeSocketWrite(socket, 'greeting')
    socket.emit('error', ioError('ETIMEDOUT'))
    expect(owner).toHaveBeenCalledTimes(1)
    expect(fault).not.toHaveBeenCalled()
  })

  it('a once owner covers one error only: the next error with no owner left is a real fault again', () => {
    const fault = vi.fn()
    onPipeFault(fault)
    const socket = new PassThrough(), owner = vi.fn()
    socket.once('error', owner)
    safeSocketWrite(socket, 'greeting')
    socket.emit('error', ioError('EIO'))
    expect(fault).not.toHaveBeenCalled()
    const second = ioError('EBADF')
    socket.emit('error', second)
    expect(fault).toHaveBeenCalledExactlyOnceWith(second)
  })

  it('an owner that removed every listener and re-added its own still owns a write callback error', async () => {
    const fault = vi.fn()
    onPipeFault(fault)
    const socket = new Writable({ write(_chunk, _encoding, callback) { callback(ioError('ETIMEDOUT')) } }), owner = vi.fn()
    socket.on('error', owner)
    safeSocketWrite(socket, 'greeting')
    await new Promise((resolve) => setImmediate(resolve))
    socket.removeAllListeners('error')
    socket.on('error', owner)
    socket.write('frame')
    await new Promise((resolve) => setImmediate(resolve))
    expect(owner).toHaveBeenCalled()
    expect(fault).not.toHaveBeenCalled()
  })

  it('a child stream with its own error listener keeps the child running and raises no fault', async () => {
    const fault = vi.fn()
    onPipeFault(fault)
    const child = guardChild(spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: ['pipe', 'pipe', 'pipe'] }))
    const sdkLog = vi.fn(), childError = vi.fn()
    child.stderr!.on('error', sdkLog)
    child.on('error', childError)
    try {
      child.stderr!.emit('error', ioError('EIO'))
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(sdkLog).toHaveBeenCalled()
      expect(fault).not.toHaveBeenCalled()
      expect(childError).not.toHaveBeenCalled()
      expect(child.exitCode === null && child.signalCode === null).toBe(true)
    } finally { child.kill('SIGKILL') }
  })
})

describe('fault dialog limiter', () => {
  it('uses a monotonic clock: a wall clock stepped back cannot block the next dialog', () => {
    vi.useFakeTimers()
    const dialog = vi.fn()
    const handle = uncaughtHandler({ log: () => undefined, dialog })
    handle(new Error('first real fault'))
    expect(dialog).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() - 3_600_000)
    vi.advanceTimersByTime(31_000)
    handle(new Error('second real fault'))
    expect(dialog).toHaveBeenCalledTimes(2)
  })
})

describe('environment probe deadline', () => {
  it.skipIf(process.platform === 'win32')('answers at its timeout on Windows even when the leader already exited and a descendant holds stdout', async () => {
    const { execVersion } = await import('../src/main/runtime/environment-host')
    const dir = mkdtempSync(join(tmpdir(), 'probe-'))
    const exe = join(dir, 'sh.exe')
    symlinkSync('/bin/sh', exe)
    const pidFile = join(dir, 'descendant.pid')
    const real = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let outcome = 'pending'
    try {
      void execVersion(exe, ['-c', `sleep 20 & echo $! > ${pidFile}; exit 0`], { timeoutMs: 300 }).then(
        () => { outcome = 'resolved' },
        (error: Error) => { outcome = `rejected: ${error.message}` },
      )
    } finally { Object.defineProperty(process, 'platform', { value: real }) }
    try {
      await vi.waitFor(() => expect(outcome).not.toBe('pending'), { timeout: 3000 })
      expect(outcome).toMatch(/timed out|resolved/)
    } finally {
      try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGKILL') } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
