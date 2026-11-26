/**
 * 26 Nov 2026: the PC app's main thread kept beating while every database read waited 20 minutes and other devices
 * failed in the TLS handshake ("listening but refusing"). The heartbeat-only supervisor never fired; it had to be
 * killed by hand. The supervisor now asks the Devices server a real question (GET /v1/health?deep=1 over TLS on the
 * same port other devices use) and counts every age in monotonic time, so a wrong or jumping wall clock changes
 * nothing. These run the real supervisor code in a real process against real local servers.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { createServer as createNetServer, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { makeSelfSignedCert } from '../src/main/devices/cert'
import { recoveryWorkerCode, removeStaleSupervisorScripts, type RecoveryOptions } from '../src/main/freeze-recovery'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

const cert = makeSelfSignedCert('freeze-probe-test')

/** A Devices server stand-in: 'ok' answers deep ok, 'refuse' accepts TCP and drops it, 'hang' never answers. */
async function devicesServer(): Promise<{ port: number; mode: { now: 'ok' | 'refuse' | 'hang' }; hits: () => number }> {
  const mode = { now: 'ok' as 'ok' | 'refuse' | 'hang' }
  let hits = 0
  const https: HttpsServer = createHttpsServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
    hits += 1
    if (mode.now === 'hang') return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ id: 'dev_test', deep: req.url?.includes('deep=1') === true ? 'ok' : undefined }))
  })
  // One port: refuse/hang decide before TLS, the rest goes to the https server.
  const front: NetServer = createNetServer((socket) => {
    if (mode.now === 'refuse') {
      socket.destroy()
      return
    }
    https.emit('connection', socket)
  })
  await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => front.close(() => resolve())))
  cleanups.push(() => void https.close())
  return { port: (front.address() as { port: number }).port, mode, hits: () => hits }
}

function victim(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], { stdio: 'ignore' })
  cleanups.push(() => void child.kill('SIGKILL'))
  return child
}

function supervisor(options: RecoveryOptions, preamble = ''): ChildProcess {
  const child = spawn(process.execPath, ['-e', preamble + recoveryWorkerCode(options)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  child.on('error', () => undefined)
  cleanups.push(() => void child.kill('SIGKILL'))
  return child
}

function beating(child: ChildProcess, probe: { host: string; port: number } | null, everyMs = 20): () => void {
  const timer = setInterval(() => {
    // The supervisor exits once it has recovered: a beat sent as it goes is simply lost.
    if (child.connected) child.send({ type: 'beat', memory: { rss: 1 }, probe }, () => undefined)
  }, everyMs)
  const stop = (): void => clearInterval(timer)
  cleanups.push(stop)
  return stop
}

async function until(done: () => boolean, ms = 8_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition not met in time')
}

function paths(name: string): { dir: string; log: string; state: string; marker: string; proof: string } {
  const dir = mkdtempSync(join(tmpdir(), `freeze-probe-${name}-`))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, log: join(dir, 'log'), state: join(dir, 'state.json'), marker: join(dir, 'marker.json'), proof: join(dir, 'restart.txt') }
}

const fast = { timeoutMs: 400, intervalMs: 20, startupMs: 0, probeIntervalMs: 40, probeTimeoutMs: 150, probeDeadMs: 400, restartDelayMs: 10, maxRestarts: 2 }

it('restarts an app whose main thread beats but whose Devices server refuses connections (listening, not answering)', async () => {
  const server = await devicesServer()
  const p = paths('refuse')
  const frozen = victim()
  const relaunch = ['-e', `require('node:fs').appendFileSync(${JSON.stringify(p.proof)}, 'restart\\n')`]
  const child = supervisor({ parentPid: frozen.pid!, executable: process.execPath, args: relaunch, log: p.log, state: p.state, marker: p.marker, ...fast })
  beating(child, { host: '127.0.0.1', port: server.port })
  // It answers first (armed), then refuses every connection while the main thread keeps beating.
  await until(() => server.hits() > 0)
  await new Promise((resolve) => setTimeout(resolve, 100))
  server.mode.now = 'refuse'
  await until(() => existsSync(p.proof))
  const log = readFileSync(p.log, 'utf8')
  expect(log).toContain('Devices server not answering')
  expect(log).toContain('Main process frozen')
  expect(log).toContain('devicesServer')
  expect(JSON.parse(readFileSync(p.marker, 'utf8')).reason).toBe('devices server not answering')
  await until(() => frozen.exitCode !== null || frozen.signalCode !== null)
}, 15_000)

it('restarts when the Devices server accepts the request but never answers (hung handshake or route)', async () => {
  const server = await devicesServer()
  const p = paths('hang')
  const frozen = victim()
  const relaunch = ['-e', `require('node:fs').appendFileSync(${JSON.stringify(p.proof)}, 'restart\\n')`]
  const child = supervisor({ parentPid: frozen.pid!, executable: process.execPath, args: relaunch, log: p.log, state: p.state, marker: p.marker, ...fast })
  beating(child, { host: '127.0.0.1', port: server.port })
  await until(() => server.hits() > 0)
  server.mode.now = 'hang'
  await until(() => existsSync(p.proof))
  expect(readFileSync(p.log, 'utf8')).toContain('Main process frozen')
}, 15_000)

it('never restarts a healthy app, nor one whose server has not answered once since it started, nor with Devices off', async () => {
  const server = await devicesServer()
  const p = paths('healthy')
  const healthy = victim()
  const child = supervisor({ parentPid: healthy.pid!, executable: process.execPath, args: ['-e', ''], log: p.log, state: p.state, marker: p.marker, ...fast })
  beating(child, { host: '127.0.0.1', port: server.port })
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  expect(server.hits()).toBeGreaterThan(3)
  expect(existsSync(p.marker)).toBe(false)

  // A server that refuses from the start (it never came up) is not "frozen": only the beat decides then.
  const q = paths('never-up')
  const refusing = await devicesServer()
  refusing.mode.now = 'refuse'
  const other = victim()
  const second = supervisor({ parentPid: other.pid!, executable: process.execPath, args: ['-e', ''], log: q.log, state: q.state, marker: q.marker, ...fast })
  beating(second, { host: '127.0.0.1', port: refusing.port })
  // Devices off: no probe target at all.
  const r = paths('off')
  const third = victim()
  const off = supervisor({ parentPid: third.pid!, executable: process.execPath, args: ['-e', ''], log: r.log, state: r.state, marker: r.marker, ...fast })
  beating(off, null)
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  expect(existsSync(q.marker)).toBe(false)
  expect(existsSync(r.marker)).toBe(false)
  expect(() => process.kill(other.pid!, 0)).not.toThrow()
  expect(() => process.kill(third.pid!, 0)).not.toThrow()
  expect(() => process.kill(healthy.pid!, 0)).not.toThrow()
}, 15_000)

/** Makes the supervisor's wall clock run `offsetMs` from now on, as Windows time service corrections do. */
function skewedClock(file: string): string {
  return `{ const real = Date.now.bind(Date); const fs = require('node:fs'); Date.now = () => { let off = 0; try { off = Number(fs.readFileSync(${JSON.stringify(file)}, 'utf8')) || 0 } catch {} return real() + off } }\n`
}

it('a wall clock that jumps back 35 minutes neither hides a frozen main nor delays its recovery', async () => {
  const p = paths('clock-back')
  const skew = join(p.dir, 'skew')
  const frozen = victim()
  const relaunch = ['-e', `require('node:fs').appendFileSync(${JSON.stringify(p.proof)}, 'restart\\n')`]
  const child = supervisor({ parentPid: frozen.pid!, executable: process.execPath, args: relaunch, log: p.log, state: p.state, marker: p.marker, ...fast }, skewedClock(skew))
  child.send({ type: 'beat', memory: {}, probe: null })
  // The clock goes back 35 minutes just after the last beat; the main thread then stops beating.
  await new Promise((resolve) => setTimeout(resolve, 50))
  writeFileSync(skew, String(-35 * 60_000))
  const started = Date.now()
  await until(() => existsSync(p.proof), 6_000)
  // Detected on the monotonic timeout (400 ms here), not 35 minutes later.
  expect(Date.now() - started).toBeLessThan(5_000)
  expect(readFileSync(p.log, 'utf8')).toContain('Main process frozen')
}, 15_000)

it('a wall clock that jumps forward 35 minutes never makes a beating app look frozen', async () => {
  const p = paths('clock-forward')
  const skew = join(p.dir, 'skew')
  const fine = victim()
  const child = supervisor({ parentPid: fine.pid!, executable: process.execPath, args: ['-e', ''], log: p.log, state: p.state, marker: p.marker, ...fast }, skewedClock(skew))
  beating(child, null)
  await new Promise((resolve) => setTimeout(resolve, 100))
  writeFileSync(skew, String(35 * 60_000))
  await new Promise((resolve) => setTimeout(resolve, 1_200))
  expect(existsSync(p.marker)).toBe(false)
  expect(() => process.kill(fine.pid!, 0)).not.toThrow()
}, 15_000)

it('a restart stamp from before the clock went back still counts toward the cap', async () => {
  const p = paths('cap-skew')
  writeFileSync(p.state, JSON.stringify([Date.now() + 30 * 60_000, Date.now() + 31 * 60_000]))
  const frozen = victim()
  const child = supervisor({ parentPid: frozen.pid!, executable: process.execPath, args: ['-e', ''], log: p.log, state: p.state, marker: p.marker, ...fast })
  child.send({ type: 'beat', memory: {}, probe: null })
  await until(() => existsSync(p.log) && readFileSync(p.log, 'utf8').includes('Restart cap reached'))
  expect(() => process.kill(frozen.pid!, 0)).not.toThrow()
}, 15_000)

it('tidies away scripts of supervisors whose app is gone, and keeps a live one', () => {
  const p = paths('scripts')
  writeFileSync(join(p.dir, 'freeze-supervisor-111.cjs'), '')
  writeFileSync(join(p.dir, 'freeze-supervisor-222.cjs'), '')
  writeFileSync(join(p.dir, `freeze-supervisor-${process.pid}.cjs`), '')
  writeFileSync(join(p.dir, 'main.log'), '')
  expect(removeStaleSupervisorScripts(p.dir, (pid) => pid === 222)).toBe(1)
  expect(readdirSync(p.dir).sort()).toEqual(['freeze-supervisor-222.cjs', `freeze-supervisor-${process.pid}.cjs`, 'main.log'].sort())
})
