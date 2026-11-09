/**
 * Jobs are picked up from the row's change event, not by polling (9 Nov 2026): messages between brains
 * (runtime/offload.ts) and tool commands for this device (devices/device-tools.ts). One slow sweep stays, so a
 * missed event cannot strand a job, and an idle app reads nothing between sweeps.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { schema, str, type JobRow, type Tool } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { DeviceToolRunner, RUNNER_SWEEP_MS } from '../src/main/devices/device-tools'
import { Offload, SCAN_MS } from '../src/main/runtime/offload'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The store with its reads of one entity counted, and (deaf) with its change events never delivered. */
function watched(store: Store, entity: string, deaf = false): { store: Store; reads: () => number } {
  let reads = 0
  const view = Object.create(store) as Store
  view.listWhere = (async (name, where) => {
    if (name === entity) reads += 1
    return store.listWhere(name, where)
  }) as Store['listWhere']
  view.list = (async (name) => {
    if (name === entity) reads += 1
    return store.list(name)
  }) as Store['list']
  if (deaf) view.onChange = () => () => undefined
  return { store: view, reads: () => reads }
}

function offload(store: Store, handle: (row: JobRow) => Promise<boolean>, scanMs: number, retryScanMs = 60_000): Offload {
  const made = new Offload({
    store,
    selfId: () => 'dev_a',
    isSelf: (other) => other === 'dev_a',
    reachable: () => true,
    capacity: () => ({ name: 'a', kind: 'desktop', accounts: [], cap: 4, active: 0, browser: false }),
    mode: () => 'best',
    handle,
    beatMs: 3_600_000,
    scanMs,
    retryScanMs,
  })
  made.start()
  cleanups.push(() => made.stop())
  return made
}

const message = (helper: string): Partial<JobRow> => ({ kind: 'msg', device: 'dev_a', from: 'dev_b', helper, op: 'stop', text: '', item: '', info: '', status: 'sent', at: Date.now() })

describe('safety sweeps', () => {
  it('are slow by default: a minute, not every few seconds', () => {
    expect(SCAN_MS).toBeGreaterThanOrEqual(60_000)
    expect(RUNNER_SWEEP_MS).toBeGreaterThanOrEqual(60_000)
  })
})

describe('messages between brains', () => {
  it('a message is handled from its change event, and an idle app reads nothing until the sweep', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const seen: string[] = []
    const { store, reads } = watched(db, 'job')
    offload(store, async (row) => (seen.push(row.helper), true), 3_600_000)
    await pause(60)
    await db.upsert('job', message('h1'))
    await waitFor(() => seen.includes('h1'), 2000)
    await pause(60)
    const before = reads()
    await pause(400)
    expect(reads()).toBe(before)
  })

  it('a message whose event was missed is still found by the sweep', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const seen: string[] = []
    offload(watched(db, 'job', true).store, async (row) => (seen.push(row.helper), true), 80)
    await pause(30)
    await db.upsert('job', message('h2'))
    await waitFor(() => seen.includes('h2'), 2000)
  })

  it('a message that cannot be handled yet is looked at again shortly, without waiting for the sweep', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    let tries = 0
    offload(db, async () => (tries += 1) > 1, 3_600_000, 50)
    await pause(30)
    await db.upsert('job', message('h3'))
    await waitFor(() => tries >= 2, 2000)
    await waitFor(async () => (await db.list('job')).some((row) => row.helper === 'h3' && row.status === 'done'), 2000)
  })
})

function command(id: string): Record<string, unknown> & { id: string } {
  return { id, target: 'dev_server', kind: 'tool', tool: 'browser_open', args: JSON.stringify({ url: 'https://example.com' }), deadlineMs: 5000, status: 'queued', note: '', chat: 'main', brainId: 'dev_pc', owner: '', expiresAt: Date.now() + 60_000, updatedAt: Date.now() }
}

describe('tool commands for this device', () => {
  const tools: Tool[] = [{ spec: { name: 'browser_open', description: 'fake', schema: schema([], { url: str('url') }) }, run: async () => 'opened' }]
  const statusOf = async (db: Store, id: string): Promise<string> => (await db.get('device_command', id))?.status ?? ''

  it('a command runs from its change event, and an idle app reads nothing until the sweep', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const { store, reads } = watched(db, 'device_command')
    const runner = new DeviceToolRunner({ store, selfId: () => 'dev_server', tools: () => tools, sweepMs: 3_600_000 })
    runner.start()
    cleanups.push(() => runner.stop())
    await pause(60)
    await db.upsert('device_command', command('cmd_1') as never)
    await waitFor(async () => (await statusOf(db, 'cmd_1')) === 'done', 2000)
    await pause(60)
    const before = reads()
    await pause(400)
    expect(reads()).toBe(before)
  })

  it('a command whose event was missed is still run by the sweep', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const runner = new DeviceToolRunner({ store: watched(db, 'device_command', true).store, selfId: () => 'dev_server', tools: () => tools, sweepMs: 80 })
    runner.start()
    cleanups.push(() => runner.stop())
    await pause(30)
    await db.upsert('device_command', command('cmd_2') as never)
    await waitFor(async () => (await statusOf(db, 'cmd_2')) === 'done', 2000)
  })
})
