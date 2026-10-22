import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, schema, type DeviceRow, type JsonObject, type Settings, type Tool } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { GAVE_UP_NOTE, RESUME_NOTE, TurnLeases, rankedBrains, type LeaseHook } from '../src/main/runtime/turns'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

/** A tool that never finishes on its own: the turn is mid-run while it waits. */
function slowTool(started: { count: number }): Tool {
  return {
    spec: { name: 'slow_step', description: 'A long step.', schema: schema([], {}) },
    run: (_input, ctx) =>
      new Promise<string>((resolve) => {
        started.count++
        ctx.signal.addEventListener('abort', () => resolve('cut off'), { once: true })
      }),
  }
}

function makeRunner(store: Store, fake: FakeAi, leases: LeaseHook, extra: Tool[] = []): Runner {
  const runner = new Runner({
    store,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
    secrets: secretsView('test-key'),
    tools: [...buildToolset({ store }), ...extra],
    providerFactory: (_s, key) => providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true }),
    isFocused: () => true,
    timeZone: 'UTC',
    classifier: null,
    devices: { leases },
  })
  cleanups.push(() => runner.dispose())
  return runner
}

/** Lease writes that stop the moment the "process" dies, as a real crash would. */
function crashable(inner: TurnLeases): { hook: LeaseHook; crash(): void } {
  let dead = false
  return {
    hook: {
      begin: (info) => (dead ? 'dead' : inner.begin(info)),
      end: (id, status) => {
        if (!dead) inner.end(id, status)
      },
    },
    crash() {
      dead = true
      inner.stop()
    },
  }
}

function messagesText(body: JsonObject): string {
  return JSON.stringify(body['messages'] ?? [])
}

describe('crash resume', () => {
  it('a turn cut off mid-run is resumed once on the next start, and only once', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const fake = await startFakeAi((body, index) => {
      if (index === 0) return { toolCalls: [{ name: 'slow_step', input: {} }] }
      return { text: messagesText(body).includes('was interrupted') ? 'Picked it up and finished.' : 'Fresh answer.' }
    })
    cleanups.push(() => fake.close())

    // First life: the turn starts, calls a long step, and the process dies there.
    const started = { count: 0 }
    const first = new TurnLeases({ store, selfId: () => 'brain-1', resumeTurn: () => undefined, resumeJob: () => undefined, notice: () => undefined })
    const life1 = crashable(first)
    const runner1 = makeRunner(store, fake, life1.hook, [slowTool(started)])
    void runner1.send('Write the summary for the board')
    await waitFor(() => started.count === 1, 5000)
    await first.settled()
    const [lease] = await store.list('turn_lease')
    expect(lease).toMatchObject({ kind: 'turn', status: 'running', attempt: 1, brainId: 'brain-1', prompt: 'Write the summary for the board' })
    life1.crash()
    runner1.dispose()

    // Second life: restore, then recover.
    let runner2: Runner | null = null
    const second = new TurnLeases({
      store,
      selfId: () => 'brain-1',
      resumeTurn: (chat, id, note) => runner2?.resumeTurn(chat, id, note),
      resumeJob: () => undefined,
      notice: () => undefined,
    })
    cleanups.push(() => second.stop())
    runner2 = makeRunner(store, fake, second)
    await runner2.restore()
    expect(await second.recover()).toBe(1)

    await waitFor(async () => (await store.list('chat_item')).some((row) => row.kind === 'agent' && row.text === 'Picked it up and finished.'), 5000)
    await waitFor(async () => (await store.get('turn_lease', lease?.id ?? ''))?.status === 'done', 5000)
    expect(await store.get('turn_lease', lease?.id ?? '')).toMatchObject({ status: 'done', attempt: 2, brainId: 'brain-1' })
    expect(fake.requests).toHaveLength(2)
    // The resumed request carries the whole saved transcript plus the note, and names the task.
    const resumed = messagesText(fake.requests[1]?.body ?? {})
    expect(resumed).toContain('Write the summary for the board')
    expect(resumed).toContain('was interrupted')
    expect(resumed).toContain('Do not repeat side effects')

    // A later start finds nothing to resume.
    const third = new TurnLeases({ store, selfId: () => 'brain-1', resumeTurn: () => { throw new Error('resumed twice') }, resumeJob: () => undefined, notice: () => undefined })
    expect(await third.recover()).toBe(0)
    expect(fake.requests).toHaveLength(2)
    expect(RESUME_NOTE).toContain('interrupted')
  })

  it('a finished turn leaves a done lease and nothing to resume', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const fake = await startFakeAi(() => ({ text: 'Done.' }))
    cleanups.push(() => fake.close())
    const leases = new TurnLeases({ store, selfId: () => 'brain-1', resumeTurn: () => undefined, resumeJob: () => undefined, notice: () => undefined })
    cleanups.push(() => leases.stop())
    const runner = makeRunner(store, fake, leases)
    await runner.send('Hello')
    await leases.settled()
    const [lease] = await store.list('turn_lease')
    expect(lease?.status).toBe('done')
    expect(await leases.recover()).toBe(0)
  })

  it('a quit mid-turn (dispose) keeps the lease running so the next start resumes it', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const fake = await startFakeAi(() => ({ toolCalls: [{ name: 'slow_step', input: {} }] }))
    cleanups.push(() => fake.close())
    const started = { count: 0 }
    const leases = new TurnLeases({ store, selfId: () => 'brain-1', resumeTurn: () => undefined, resumeJob: () => undefined, notice: () => undefined })
    const runner = makeRunner(store, fake, leases, [slowTool(started)])
    void runner.send('Long job')
    await waitFor(() => started.count === 1, 5000)
    runner.dispose()
    leases.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
    await leases.settled()
    expect((await store.list('turn_lease'))[0]?.status).toBe('running')
  })

  it('a real helper cut off mid-run is sent back to work on the next start and reports its result', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const fake = await startFakeAi((body, index) => {
      if (index === 0) return { toolCalls: [{ name: 'slow_step', input: {} }] }
      return { text: messagesText(body).includes('was interrupted') ? 'Prices found after the restart.' : 'Fresh.' }
    })
    cleanups.push(() => fake.close())
    const managerFor = (leases: LeaseHook, delivered: string[], extra: Tool[] = []): HelperManager =>
      new HelperManager({
        store,
        settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
        secrets: secretsView('test-key'),
        providerFactory: (_s, key) => providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true }),
        workerTools: [...buildWorkerToolset({ store }), ...extra],
        deliver: (note) => {
          delivered.push(note)
        },
        platform: 'linux',
        timeZone: 'UTC',
        leases,
      })

    const started = { count: 0 }
    const first = new TurnLeases({ store, selfId: () => 'brain-1', resumeTurn: () => undefined, resumeJob: () => undefined })
    const life1 = crashable(first)
    const manager1 = managerFor(life1.hook, [], [slowTool(started)])
    await manager1.delegate([{ label: 'Prices', brief: 'Find three prices.' }])
    await waitFor(() => started.count === 1, 5000)
    await first.settled()
    const [lease] = await store.list('turn_lease')
    expect(lease).toMatchObject({ kind: 'job', status: 'running', attempt: 1 })
    life1.crash()

    const delivered: string[] = []
    let manager2: HelperManager | null = null
    const second = new TurnLeases({
      store,
      selfId: () => 'brain-1',
      resumeTurn: () => undefined,
      resumeJob: async (id, note) => {
        await manager2?.push(id, note)
      },
    })
    cleanups.push(() => second.stop())
    manager2 = managerFor(second, delivered)
    await manager2.restore()
    expect(await second.recover()).toBe(1)
    await waitFor(() => delivered.some((note) => note.includes('Prices found after the restart.')), 5000)
    await waitFor(async () => (await store.get('turn_lease', lease?.id ?? ''))?.status === 'done', 5000)
    expect(await store.get('turn_lease', lease?.id ?? '')).toMatchObject({ status: 'done', attempt: 2 })
    expect(await second.recover()).toBe(0)
  })

  it('a helper job cut off is sent back to work; after 3 attempts it gives up with a note', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const jobs: string[] = []
    const notices: Array<{ chat: string; text: string }> = []
    const leases = new TurnLeases({
      store,
      selfId: () => 'brain-1',
      resumeTurn: () => undefined,
      resumeJob: (id, note) => {
        jobs.push(`${id}:${note.slice(0, 20)}`)
      },
      notice: (chat, text) => {
        notices.push({ chat, text })
      },
    })
    leases.begin({ kind: 'job', chatId: 'pc1', messageId: 'helper-7', prompt: 'Find prices' })
    leases.stop()
    await leases.settled()
    expect(await leases.recover()).toBe(1)
    expect(jobs).toEqual([`helper-7:${RESUME_NOTE.slice(0, 20)}`])
    expect((await store.get('turn_lease', 'job-helper-7'))?.attempt).toBe(2)

    // The resumed job starts (keeps attempt 2) and dies again, twice.
    for (const expected of [3]) {
      leases.begin({ kind: 'job', chatId: 'pc1', messageId: 'helper-7', prompt: 'Find prices' })
      leases.stop()
      await leases.settled()
      expect((await store.get('turn_lease', 'job-helper-7'))?.attempt).toBe(expected - 1)
      expect(await leases.recover()).toBe(1)
    }
    leases.begin({ kind: 'job', chatId: 'pc1', messageId: 'helper-7', prompt: 'Find prices' })
    leases.stop()
    await leases.settled()
    expect(await leases.recover()).toBe(0)
    expect((await store.get('turn_lease', 'job-helper-7'))?.status).toBe('failed')
    expect(notices).toEqual([{ chat: 'pc1', text: GAVE_UP_NOTE }])
    expect(jobs).toHaveLength(2)
  })
})

describe('failover', () => {
  const base = { kind: 'desktop', platform: 'linux', urls: ['https://127.0.0.1:1'], fp: 'fp', facts: {}, pairedAt: 0, lastSeen: 0, revoked: false, roles: ['brain'] }

  async function mesh(now: { t: number }, up: Record<string, boolean>, ready: Record<string, boolean> = {}) {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    await store.upsert('device', { ...base, id: 'dev_a', name: 'A', priority: 0 })
    await store.upsert('device', { ...base, id: 'dev_b', name: 'B', priority: 1 })
    await store.upsert('device', { ...base, id: 'dev_c', name: 'C', priority: 2 })
    const resumed: Array<{ who: string; chat: string; id: string }> = []
    const probes: string[] = []
    const make = (self: string) =>
      new TurnLeases({
        store,
        selfId: () => self,
        now: () => now.t,
        resumeTurn: (chat, id) => {
          resumed.push({ who: self, chat, id })
        },
        resumeJob: () => undefined,
        notice: () => undefined,
        brains: () => rankedBrains(store),
        health: async (row: DeviceRow) => {
          probes.push(row.id)
          return { up: up[row.id] === true, ready: up[row.id] === true && ready[row.id] !== false }
        },
      })
    return { store, resumed, probes, make }
  }

  it('the best healthy brain takes over a turn whose brain stopped beating and fails health', async () => {
    const now = { t: 1_000_000 }
    const { store, resumed, make } = await mesh(now, { dev_a: false, dev_b: true, dev_c: true })
    const a = make('dev_a')
    const id = a.begin({ kind: 'turn', chatId: 'main', messageId: 'm1', prompt: 'Plan the trip' })
    a.stop()
    await a.settled()

    const b = make('dev_b')
    const c = make('dev_c')
    // Fresh heartbeat: nobody touches it.
    now.t += 20_000
    expect(await b.claimStale()).toBe(0)
    // Stale: C defers to B (ranked higher and healthy); B takes it.
    now.t += 30_000
    expect(await c.claimStale()).toBe(0)
    expect(await b.claimStale()).toBe(1)
    expect(resumed).toEqual([{ who: 'dev_b', chat: 'main', id }])
    expect(await store.get('turn_lease', id)).toMatchObject({ brainId: 'dev_b', attempt: 2 })
    // B runs it under the same lease: running again, beating as B.
    b.begin({ kind: 'turn', chatId: 'main', messageId: '', prompt: '', id })
    await b.settled()
    expect(await store.get('turn_lease', id)).toMatchObject({ brainId: 'dev_b', status: 'running', attempt: 2, prompt: 'Plan the trip' })
    b.stop()
    c.stop()
  })

  it('a brain that was only cut off stops its own run once another brain has taken the lease', async () => {
    const now = { t: 3_000_000 }
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const lost: string[] = []
    const a = new TurnLeases({
      store,
      selfId: () => 'dev_a',
      now: () => now.t,
      heartbeatMs: 20,
      resumeTurn: () => undefined,
      resumeJob: () => undefined,
      lost: (lease) => lost.push(lease.id),
    })
    cleanups.push(() => a.stop())
    const id = a.begin({ kind: 'turn', chatId: 'main', messageId: 'm1', prompt: 'x' })
    await a.settled()
    // B took it over while A was unreachable.
    await store.upsert('turn_lease', { id, brainId: 'dev_b', attempt: 2 })
    await waitFor(() => lost.length === 1, 2000)
    expect(lost).toEqual([id])
    // A's end does not overwrite B's lease.
    a.end(id, 'done')
    await a.settled()
    expect(await store.get('turn_lease', id)).toMatchObject({ brainId: 'dev_b', status: 'running' })
  })

  it('leaves it alone while its brain still answers health (only slow to sync)', async () => {
    const now = { t: 5_000_000 }
    const { resumed, make } = await mesh(now, { dev_a: true, dev_b: true })
    const a = make('dev_a')
    a.begin({ kind: 'turn', chatId: 'main', messageId: 'm1', prompt: 'x' })
    a.stop()
    await a.settled()
    now.t += 60_000
    expect(await make('dev_b').claimStale()).toBe(0)
    expect(resumed).toEqual([])
  })

  it('a lower brain takes it when the higher one is up but not ready to run turns', async () => {
    const now = { t: 9_000_000 }
    const { resumed, make } = await mesh(now, { dev_a: false, dev_b: true, dev_c: true }, { dev_b: false })
    const a = make('dev_a')
    a.begin({ kind: 'turn', chatId: 'pc2', messageId: 'm1', prompt: 'x' })
    a.stop()
    await a.settled()
    now.t += 60_000
    expect(await make('dev_c').claimStale()).toBe(1)
    expect(resumed.map((r) => r.who)).toEqual(['dev_c'])
  })
})
