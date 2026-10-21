/**
 * The whole loop on real processes: a worker script written to disk, run by the real launcher, its events stored,
 * the app "closed" and "opened" again, and the worker catching up from the cursor it was handed back.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { waitFor } from '../../../packages/core/test/helpers'

import { killTree, spawnWorker } from '../src/main/workers/spawn'
import { WorkerStore } from '../src/main/workers/store'
import { Supervisor } from '../src/main/workers/supervisor'

// A tiny source: a "mailbox" file of numbered messages. It emits everything after its cursor, then keeps going.
const SCRIPT = `
import { readFileSync, existsSync } from 'node:fs'
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const box = process.env.BOX
let cursor = Number(process.env.AGENT_WORKER_CURSOR || '0')
out({ type: 'log', level: 'info', text: 'down since ' + (process.env.AGENT_WORKER_DOWN_SINCE || 'never') + ', cursor ' + cursor })
const poll = () => {
  const lines = existsSync(box) ? readFileSync(box, 'utf8').split('\\n').filter(Boolean) : []
  for (let i = cursor; i < lines.length; i++) {
    out({ type: 'event', source: 'box', event: 'message.new', payload: { text: lines[i] }, dedupeKey: 'm' + (i + 1) })
    cursor = i + 1
    out({ type: 'cursor', value: String(cursor) })
  }
}
process.stdin.on('data', (d) => { if (String(d).includes('stop')) process.exit(0) })
poll()
out({ type: 'ready' })
setInterval(() => { poll(); out({ type: 'alive' }) }, 100)
`

let root: string
let store: WorkerStore
const secrets = new Map<string, string>()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workers-real-'))
  store = new WorkerStore(root)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function supervisor(): Supervisor {
  return new Supervisor({
    store,
    spawn: spawnWorker,
    killTree,
    secrets: { get: (k) => secrets.get(k) ?? null, set: (k, v) => void secrets.set(k, v) },
    baseEnv: { ...process.env, BOX: join(root, 'box.txt') },
  })
}

describe('a real worker process', () => {
  it('emits, survives an app restart, and catches up exactly once on what arrived while closed', async () => {
    const { appendFileSync } = await import('node:fs')
    const box = join(root, 'box.txt')
    appendFileSync(box, 'first\n')
    store.write(
      { id: 'w_real01', name: 'Box', about: '', entry: 'main.mjs', runtime: 'node', args: [], mode: 'stay', everyMinutes: null, secrets: [], enabled: true, createdAt: 1, updatedAt: 1 },
      { 'main.mjs': SCRIPT },
    )

    const first = supervisor()
    first.start()
    await waitFor(() => store.events({ worker: 'w_real01' }).length === 1, 15_000)
    appendFileSync(box, 'second\n')
    await waitFor(() => store.events({ worker: 'w_real01' }).length === 2, 15_000)
    // The worker checkpoints after each message; quit once it has (a message re-sent without one is deduped anyway).
    await waitFor(() => store.state('w_real01').cursor === '2', 15_000)
    expect(first.info()[0]!.state).toBe('running')

    // The app quits. Two messages arrive while it is closed.
    first.stopAll()
    await new Promise((resolve) => setTimeout(resolve, 300))
    appendFileSync(box, 'third\nfourth\n')

    // The app opens again: the worker comes back and picks up exactly the two it missed.
    const second = supervisor()
    second.start()
    await waitFor(() => store.events({ worker: 'w_real01' }).length === 4, 15_000)
    await new Promise((resolve) => setTimeout(resolve, 400))
    const texts = store.events({ worker: 'w_real01', oldestFirst: true }).map((e) => JSON.parse(e.payload).text)
    expect(texts).toEqual(['first', 'second', 'third', 'fourth'])
    const info = second.info()[0]!
    expect(info.lastGap?.caughtUp).toBe(2)
    expect(store.logs('w_real01').some((l) => /cursor 2/.test(l.text))).toBe(true)
    second.stopAll()
  }, 40_000)

  it('a worker that crashes is started again by itself', async () => {
    store.write(
      { id: 'w_real02', name: 'Crashy', about: '', entry: 'main.mjs', runtime: 'node', args: [], mode: 'stay', everyMinutes: null, secrets: [], enabled: true, createdAt: 1, updatedAt: 1 },
      { 'main.mjs': "process.stdout.write(JSON.stringify({type:'ready'})+'\\n'); setTimeout(() => { console.error('boom'); process.exit(3) }, 200)" },
    )
    const sup = supervisor()
    sup.start()
    await waitFor(() => store.logs('w_real02').filter((l) => l.text === 'Started').length >= 2, 15_000)
    const info = sup.info()[0]!
    expect(info.restartsToday).toBeGreaterThanOrEqual(1)
    expect(info.lastError).toContain('boom')
    sup.stopAll()
  }, 30_000)
})
