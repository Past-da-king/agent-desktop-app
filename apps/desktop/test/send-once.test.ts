import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type Settings } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { makeSendOnce, sendLeaseId, sendRowId, sendScope, SEND_MAX_AGE_MS, type SendScope } from '../src/main/runtime/send-once'
import { TurnLeases, type LeaseHook } from '../src/main/runtime/turns'
import { buildToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }
const ID = 'phone-send-0001'
const SCRIPT = (_body: unknown, index: number): { text: string } => ({ text: index === 0 ? 'Answered.' : 'Two.' })

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

function makeRunner(store: Store, fake: FakeAi, leases: LeaseHook): Runner {
  const runner = new Runner({
    store,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
    secrets: secretsView('test-key'),
    tools: buildToolset({ store }),
    providerFactory: (_s, key) => providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true }),
    isFocused: () => true,
    timeZone: 'UTC',
    classifier: null,
    devices: { leases },
  })
  cleanups.push(() => runner.dispose())
  return runner
}

function gate(rows: Set<string> = new Set(), now: () => number = Date.now) {
  return makeSendOnce({ exists: async (id) => rows.has(id), settleMs: 1, now })
}

describe('chat.sendOnce: the gate', () => {
  it('runs a message once and says duplicate to the same id again', async () => {
    const rows = new Set<string>()
    const once = gate(rows)
    let runs = 0
    const send = async (): Promise<void> => {
      runs++
      rows.add(sendRowId(ID))
    }
    expect(await once({ sendId: ID }, send)).toEqual({ accepted: true })
    expect(await once({ sendId: ID }, send)).toEqual({ accepted: true, duplicate: true })
    expect(runs).toBe(1)
  })

  it('two of the same at once run one send', async () => {
    const once = gate()
    let runs = 0
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const send = async (): Promise<void> => {
      runs++
      await held
    }
    const both = Promise.all([once({ sendId: ID }, send), once({ sendId: ID }, send)])
    await waitFor(() => runs === 1, 500)
    release()
    const [a, b] = await both
    expect([a.accepted, b.accepted]).toEqual([true, true])
    expect(runs).toBe(1)
  })

  it('a frame whose caller left while this brain was frozen does nothing', async () => {
    let runs = 0
    await expect(gate()({ sendId: ID, isOpen: () => false }, async () => { runs++ })).rejects.toThrow('gone')
    expect(runs).toBe(0)
  })

  it('a frame too old to be sure is refused as stale, and fresh repeats it from a caller still there', async () => {
    const at = 5_000_000
    const once = gate(new Set(), () => at)
    let runs = 0
    const send = async (): Promise<void> => { runs++ }
    expect(await once({ sendId: ID, sentAt: at - SEND_MAX_AGE_MS - 1 }, send)).toEqual({ accepted: false, stale: true })
    expect(runs).toBe(0)
    expect(await once({ sendId: ID, sentAt: at - SEND_MAX_AGE_MS - 1, fresh: true }, send)).toEqual({ accepted: true })
    expect(runs).toBe(1)
  })

  it('refuses a bad id before doing anything', async () => {
    await expect(gate()({ sendId: 'x y' }, async () => undefined)).rejects.toThrow('bad send id')
  })

  it('answers when the message is accepted, not when the run ends', async () => {
    const once = gate()
    let finish: () => void = () => undefined
    const running = new Promise<void>((resolve) => { finish = resolve })
    const accepted = await once({ sendId: ID }, async () => {
      sendScope.getStore()?.accepted()
      await running
    })
    expect(accepted).toEqual({ accepted: true })
    finish()
  })
})

describe('chat.sendOnce: the row and the lease', () => {
  it('a new turn holds the fixed row and lease ids before it is accepted', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const fake = await startFakeAi(SCRIPT)
    cleanups.push(() => fake.close())
    const leases = new TurnLeases({ store, selfId: () => 'dev_a', resumeTurn: () => undefined, resumeJob: () => undefined })
    cleanups.push(() => leases.stop())
    const runner = makeRunner(store, fake, leases)
    await runner.restore()
    const once = makeSendOnce({ exists: async (id) => (await store.get('chat_item', id)) !== null, settleMs: 1 })

    const first = await once({ sendId: ID }, () => runner.send('Plan the trip'))
    expect(first).toEqual({ accepted: true })
    // Both are there the moment the phone hears accepted.
    expect((await store.get('chat_item', sendRowId(ID)))?.text).toBe('Plan the trip')
    expect(await store.get('turn_lease', sendLeaseId(ID))).toMatchObject({ brainId: 'dev_a', messageId: sendRowId(ID) })

    await waitFor(async () => (await store.list('chat_item')).some((row) => row.kind === 'agent' && row.text === 'Answered.'), 5000)
    expect(await once({ sendId: ID }, () => runner.send('Plan the trip'))).toEqual({ accepted: true, duplicate: true })
    expect((await store.list('chat_item')).filter((row) => row.kind === 'user')).toHaveLength(1)
    expect(fake.requests).toHaveLength(1)
  })

  it('later user rows in the same run are ordinary rows', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const fake = await startFakeAi(SCRIPT)
    cleanups.push(() => fake.close())
    const leases = new TurnLeases({ store, selfId: () => 'dev_a', resumeTurn: () => undefined, resumeJob: () => undefined })
    cleanups.push(() => leases.stop())
    const runner = makeRunner(store, fake, leases)
    await runner.restore()
    const scope: SendScope = { rowId: sendRowId(ID), leaseId: sendLeaseId(ID), rowUsed: false, viaBegin: false, accepted: () => undefined }
    await sendScope.run(scope, async () => {
      await runner.send('First')
      await runner.send('Second')
    })
    const users = (await store.list('chat_item')).filter((row) => row.kind === 'user')
    expect(users).toHaveLength(2)
    expect(users.filter((row) => row.id === sendRowId(ID))).toHaveLength(1)
  })
})

describe('a brain back from a freeze', () => {
  function leaseFor(store: Store, now: { t: number }, lost: string[], catchUp: () => Promise<void>): TurnLeases {
    const leases = new TurnLeases({ store, selfId: () => 'dev_a', now: () => now.t, heartbeatMs: 20, staleMs: 45_000, resumeTurn: () => undefined, resumeJob: () => undefined, lost: (lease) => lost.push(lease.id) })
    leases.setFailover({ health: async () => ({ up: true, ready: true }), brains: async () => [], catchUp })
    cleanups.push(() => leases.stop())
    return leases
  }

  it('hears the other brains before its heartbeat, so it never overwrites the brain that took over', async () => {
    const now = { t: 7_000_000 }
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const lost: string[] = []
    let id = ''
    const leases = leaseFor(store, now, lost, async () => {
      // What replication brings: the server took it while this brain was frozen.
      await store.upsert('turn_lease', { id, brainId: 'dev_b', attempt: 2, heartbeatAt: now.t })
    })
    id = leases.begin({ kind: 'turn', chatId: 'main', messageId: 'm1', prompt: 'x' })
    await leases.settled()
    now.t += 60_000
    await waitFor(() => lost.length === 1, 2000)
    expect(await store.get('turn_lease', id)).toMatchObject({ brainId: 'dev_b', attempt: 2, status: 'running', heartbeatAt: now.t })
  })

  it('stops its run even when the other brain has already finished it', async () => {
    const now = { t: 8_000_000 }
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const lost: string[] = []
    let id = ''
    const leases = leaseFor(store, now, lost, async () => {
      await store.upsert('turn_lease', { id, brainId: 'dev_b', status: 'done' })
    })
    id = leases.begin({ kind: 'turn', chatId: 'main', messageId: 'm1', prompt: 'x' })
    await leases.settled()
    now.t += 60_000
    await waitFor(() => lost.length === 1, 2000)
    expect(lost).toEqual([id])
    expect(await store.get('turn_lease', id)).toMatchObject({ brainId: 'dev_b', status: 'done' })
  })

  it('a short pause asks nobody and carries on', async () => {
    const now = { t: 9_000_000 }
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const lost: string[] = []
    let asked = 0
    const leases = leaseFor(store, now, lost, async () => { asked++ })
    const id = leases.begin({ kind: 'turn', chatId: 'main', messageId: 'm1', prompt: 'x' })
    await leases.settled()
    now.t += 5_000
    await waitFor(async () => (await store.get('turn_lease', id))?.heartbeatAt === now.t, 2000)
    expect(asked).toBe(0)
    expect(lost).toEqual([])
  })
})
