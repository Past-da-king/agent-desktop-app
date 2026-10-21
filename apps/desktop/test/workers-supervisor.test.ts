import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { WorkerEvent, WorkerInfo, WorkerManifest } from '@agent/core'

import { WorkerStore } from '../src/main/workers/store'
import { Supervisor, secretKey, type ChildLike, type WorkerSpawn } from '../src/main/workers/supervisor'

class FakeChild extends EventEmitter implements ChildLike {
  static next = 1000
  pid = FakeChild.next++
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdin = new PassThrough()
  stdinText = ''
  killed = false
  constructor(readonly env: NodeJS.ProcessEnv) {
    super()
    this.stdin.on('data', (d: Buffer) => {
      this.stdinText += d.toString()
    })
  }
  print(line: unknown): void {
    this.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`)
  }
  exit(code: number | null): void {
    this.emit('exit', code, code === null ? 'SIGKILL' : null)
  }
  kill(): boolean {
    if (this.killed) return true
    this.killed = true
    setTimeout(() => this.exit(null), 0)
    return true
  }
}

let root: string
let store: WorkerStore
let children: FakeChild[]
let secrets: Map<string, string>
let now: number

const spawn: WorkerSpawn = ({ env }) => {
  const child = new FakeChild(env)
  children.push(child)
  return child
}

function manifest(id: string, patch: Partial<WorkerManifest> = {}): WorkerManifest {
  return { id, name: `Worker ${id}`, about: '', entry: 'main.mjs', runtime: 'node', args: [], mode: 'stay', everyMinutes: null, secrets: [], enabled: true, createdAt: 1, updatedAt: 1, ...patch }
}

function supervisor(extra: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}): Supervisor {
  return new Supervisor({
    store,
    spawn,
    secrets: { get: (k) => secrets.get(k) ?? null, set: (k, v) => void secrets.set(k, v), delete: (k) => void secrets.delete(k) },
    now: () => now,
    baseEnv: { PATH: '/bin', AGENT_PRIVATE: 'nope' },
    ...extra,
  })
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workers-'))
  now = Date.UTC(2026, 9, 22, 8, 0, 0)
  store = new WorkerStore(root, () => now)
  children = []
  secrets = new Map()
})

afterEach(() => {
  vi.useRealTimers()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

describe('Supervisor', () => {
  it('starts enabled workers on app open, with their keys and nothing of the app’s own', async () => {
    store.write(manifest('w_aaaa01', { secrets: ['CHAT_TOKEN'] }), { 'main.mjs': '' })
    store.write(manifest('w_bbbb02', { enabled: false }), { 'main.mjs': '' })
    secrets.set(secretKey('w_aaaa01', 'CHAT_TOKEN'), 'xoxp-secret')
    const sup = supervisor()
    sup.start()
    expect(children).toHaveLength(1)
    const env = children[0]!.env
    expect(env['CHAT_TOKEN']).toBe('xoxp-secret')
    expect(env['AGENT_WORKER_ID']).toBe('w_aaaa01')
    expect(env['AGENT_PRIVATE']).toBeUndefined()
    expect(env['AGENT_WORKER_CURSOR']).toBe('')
    expect(env['AGENT_WORKER_DOWN_SINCE']).toBe('')
    sup.stopAll()
  })

  it('stores events once (dedupe), keeps the cursor, and hands them on', async () => {
    store.write(manifest('w_aaaa01'), { 'main.mjs': '' })
    const seen: WorkerEvent[] = []
    const sup = supervisor({ onEvent: (e) => seen.push(e) })
    sup.start()
    const child = children[0]!
    child.print({ type: 'ready' })
    child.print({ type: 'event', source: 'chat', event: 'message.dm', payload: { text: 'hi' }, dedupeKey: 'D1/1' })
    child.print({ type: 'event', source: 'chat', event: 'message.dm', payload: { text: 'hi' }, dedupeKey: 'D1/1' })
    child.print({ type: 'cursor', value: '1729580000.1' })
    child.print('plain text becomes a log line')
    await flush()
    expect(seen).toHaveLength(1)
    expect(store.events({ worker: 'w_aaaa01' })).toHaveLength(1)
    expect(store.state('w_aaaa01').cursor).toBe('1729580000.1')
    expect(store.logs('w_aaaa01').some((l) => l.text === 'plain text becomes a log line')).toBe(true)
    const info = sup.info()[0]!
    expect(info.state).toBe('running')
    expect(info.eventsToday).toBe(1)
    sup.stopAll()
  })

  it('after the app was closed, the next start gets the cursor and when it went down, and counts the catch-up', async () => {
    store.write(manifest('w_aaaa01'), { 'main.mjs': '' })
    const first = supervisor()
    first.start()
    children[0]!.print({ type: 'cursor', value: 'c-17' })
    await flush()
    now += 60_000
    first.stopAll()
    const closedAt = now
    now += 8 * 3_600_000

    const second = supervisor()
    second.start()
    const env = children[1]!.env
    expect(env['AGENT_WORKER_CURSOR']).toBe('c-17')
    expect(Number(env['AGENT_WORKER_DOWN_SINCE'])).toBe(closedAt)
    children[1]!.print({ type: 'event', source: 'chat', event: 'message.dm', payload: {}, dedupeKey: 'missed-1' })
    children[1]!.print({ type: 'event', source: 'chat', event: 'message.dm', payload: {}, dedupeKey: 'missed-2' })
    await flush()
    const gap = second.info()[0]!.lastGap
    expect(gap).toEqual({ from: closedAt, to: now, caughtUp: 2 })
    second.stopAll()
  })

  it('restarts a dead worker with backoff, then gives up visibly after five failures in ten minutes', async () => {
    vi.useFakeTimers()
    store.write(manifest('w_aaaa01'), { 'main.mjs': '' })
    const failing: WorkerInfo[] = []
    const sup = supervisor({ onFailing: (w) => failing.push(w) })
    sup.start()
    for (let i = 0; i < 4; i += 1) {
      children[children.length - 1]!.stderr.write('Error: invalid_auth\n')
      await vi.advanceTimersByTimeAsync(1)
      children[children.length - 1]!.exit(1)
      expect(sup.info()[0]!.state).toBe('backoff')
      await vi.advanceTimersByTimeAsync(2 ** i * 1000)
      expect(children).toHaveLength(i + 2)
    }
    children[children.length - 1]!.stderr.write('Error: invalid_auth\n')
    await vi.advanceTimersByTimeAsync(1)
    children[children.length - 1]!.exit(1)
    const info = sup.info()[0]!
    expect(info.state).toBe('failing')
    expect(info.lastError).toContain('invalid_auth')
    expect(failing).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(children).toHaveLength(5)
    // The person presses Try again: it starts, and the count starts over.
    sup.startWorker('w_aaaa01')
    expect(children).toHaveLength(6)
    sup.stopAll()
  })

  it('restarts a worker that stops answering', async () => {
    vi.useFakeTimers()
    store.write(manifest('w_aaaa01'), { 'main.mjs': '' })
    const sup = supervisor({ heartbeatMs: 90_000, checkEveryMs: 15_000 })
    sup.start()
    children[0]!.print({ type: 'ready' })
    await vi.advanceTimersByTimeAsync(1)
    now += 120_000
    await vi.advanceTimersByTimeAsync(15_000)
    expect(children[0]!.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(children).toHaveLength(2)
    expect(store.state('w_aaaa01').lastError).toMatch(/Stopped answering/)
    sup.stopAll()
  })

  it('stop asks politely, then ends it; it stays off after a restart of the app', async () => {
    vi.useFakeTimers()
    store.write(manifest('w_aaaa01'), { 'main.mjs': '' })
    const sup = supervisor({ graceMs: 5000 })
    sup.start()
    const child = children[0]!
    const stopping = sup.stopWorker('w_aaaa01')
    await vi.advanceTimersByTimeAsync(1)
    expect(child.stdinText).toContain('"stop"')
    await vi.advanceTimersByTimeAsync(5000)
    expect(child.killed).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    await stopping
    expect(sup.info()[0]!.state).toBe('stopped')
    sup.stopAll()
    const again = supervisor()
    again.start()
    expect(children).toHaveLength(1)
    again.stopAll()
  })

  it('runs an every worker again after its interval, and a clean exit is not a failure', async () => {
    vi.useFakeTimers()
    store.write(manifest('w_aaaa01', { mode: 'every', everyMinutes: 5 }), { 'main.mjs': '' })
    const sup = supervisor()
    sup.start()
    children[0]!.exit(0)
    expect(sup.info()[0]!.state).toBe('waiting')
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(children).toHaveLength(2)
    expect(sup.info()[0]!.restartsToday).toBe(0)
    sup.stopAll()
  })

  it('takes keys dropped into the folder into the secret store and deletes the file', async () => {
    store.write(manifest('w_aaaa01', { secrets: ['CHAT_TOKEN'] }), { 'main.mjs': '' })
    writeFileSync(join(store.dirOf('w_aaaa01'), 'secrets.drop.json'), JSON.stringify({ CHAT_TOKEN: 'dropped', bad: 'x' }))
    const sup = supervisor()
    sup.start()
    expect(secrets.get(secretKey('w_aaaa01', 'CHAT_TOKEN'))).toBe('dropped')
    expect(children[0]!.env['CHAT_TOKEN']).toBe('dropped')
    expect(store.takeSecretDrop('w_aaaa01')).toEqual({})
    sup.stopAll()
  })

  it('a test run collects events without storing them', async () => {
    store.write(manifest('w_aaaa01'), { 'main.mjs': '' })
    const sup = supervisor()
    const run = sup.test(store.manifest('w_aaaa01')!, store.dirOf('w_aaaa01'), 30)
    const child = children[0]!
    expect(child.env['AGENT_WORKER_TEST']).toBe('1')
    child.print({ type: 'event', source: 'chat', event: 'x', payload: { a: 1 }, dedupeKey: 'k' })
    child.print({ type: 'cursor', value: 'c1' })
    await flush()
    child.exit(0)
    const result = await run
    expect(result.events).toHaveLength(1)
    expect(result.cursor).toBe('c1')
    expect(store.events()).toHaveLength(0)
  })

  it('a broken worker.json is listed with its problem, not hidden', () => {
    store.write(manifest('w_aaaa01'), { 'main.mjs': '' })
    writeFileSync(join(store.dirOf('w_aaaa01'), 'worker.json'), '{"name":"x"}')
    const sup = supervisor()
    const info = sup.info()
    expect(info).toHaveLength(1)
    expect(info[0]!.lastError).toMatch(/entry/)
  })
})
