/**
 * Ghost helpers (0.2.77): a helper card left "working" with no run behind it, on two linked brains.
 *
 * A project chat on one brain (A, the server) placed helpers on another (B, the computer). B lost their runs. Then:
 * stopping them on B said "No running helper", stopping them on A said "Stopped" and nothing changed, both kept
 * showing them working, and A's quiet watch sent its "you will not get this heads-up again" note every minute.
 * Checked here with two real stores that replicate, two helper managers and the messages between them:
 *  - a stop works from any device that sees the helper, whoever runs it, and ends the card on both;
 *  - a stop where nobody has the run ends it at once; a stop the runner never answers ends it after a grace;
 *  - the orphan watch ends a working card whose run is gone (here, or on the brain it was placed on);
 *  - the end beats a stale "working" write of the same run when the two replicate;
 *  - the quiet heads-up goes out once per run, survives a restart, and never for an ended helper;
 *  - the creator hears exactly once.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_CHAT, providerFor, type ChatItem, type Settings } from '@agent/core'

import { sleep, waitFor } from '../../../packages/core/test/helpers'
import * as dbModule from '../src/main/db'
import { Store } from '../src/main/db'
import { HelperManager, type OffloadLink } from '../src/main/runtime/helpers'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

interface Delivery {
  note: string
  chat: string
}

interface Msg {
  to: string
  from: string
  op: string
  helper: string
  text: string
  info: string
}

interface Brain {
  id: string
  db: Store
  manager: HelperManager
  delivered: Delivery[]
}

/** Two brains, A (places helpers) and B (runs them), with replication and the job messages between them. */
function pair(options: { now?: () => number; stopGraceMs?: number; quietMinutes?: number; reapAfterMs?: number } = {}): {
  a: Brain
  b: Brain
  up: { a: boolean; b: boolean }
  bus: Msg[]
  /** Messages B would get are dropped (B is a brain too old to act on them). */
  deaf: { b: boolean }
  sync: () => Promise<void>
  flush: () => Promise<void>
  restartA: () => Promise<Brain>
} {
  const up = { a: true, b: true }
  const deaf = { b: false }
  const bus: Msg[] = []
  const dbA = new Store(':memory:')
  const dbB = new Store(':memory:')
  const brains = new Map<string, Brain>()
  const linkFor = (self: string, other: string, db: Store): OffloadLink => ({
    selfId: () => self,
    isSelf: (id) => id === self,
    up: (id) => id === other && up[other === 'node-a' ? 'a' : 'b'],
    place: async () => ({ device: other, name: other === 'node-b' ? 'Desktop' : 'Server', why: 'it needs a computer' }),
    send: async (to, op, helper, extra) => {
      bus.push({ to, from: self, op, helper, text: extra?.text ?? '', info: extra?.info ?? '' })
    },
    leaseHolder: async (id) => {
      const lease = await db.get('turn_lease', `job-${id}`)
      return lease === null ? { device: '', running: false } : { device: lease.brainId, running: lease.status === 'running' || lease.status === 'interrupted' }
    },
    deviceName: async (id) => (id === 'node-b' ? 'Desktop' : 'Server'),
  })
  const make = (id: string, other: string, db: Store): Brain => {
    const delivered: Delivery[] = []
    const manager = new HelperManager({
      store: db,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: 'http://127.0.0.1:9', allowHttp: true }),
      workerTools: buildWorkerToolset({ store: db }),
      deliver: (note, chat) => {
        delivered.push({ note, chat: chat ?? MAIN_CHAT })
      },
      platform: 'linux',
      timeZone: 'UTC',
      offload: linkFor(id, other, db),
      stopGraceMs: options.stopGraceMs ?? 60_000,
      reapEveryMs: 0,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.quietMinutes === undefined ? {} : { quietMinutes: options.quietMinutes }),
      ...(options.reapAfterMs === undefined ? {} : { reapAfterMs: options.reapAfterMs }),
    })
    const brain = { id, db, manager, delivered }
    brains.set(id, brain)
    cleanups.push(() => manager.shutdown())
    return brain
  }
  const a = make('node-a', 'node-b', dbA)
  const b = make('node-b', 'node-a', dbB)
  cleanups.push(() => {
    dbA.close()
    dbB.close()
  })
  const sync = async (): Promise<void> => {
    await dbB.applyRemote(await dbA.localChanges(null), 'a')
    await dbA.applyRemote(await dbB.localChanges(null), 'b')
    await dbB.applyRemote(await dbA.localChanges(null), 'a')
  }
  /** Replicates, then hands every waiting message to its brain, until nothing is left. */
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 10; round += 1) {
      await sync()
      const waiting = bus.splice(0)
      if (waiting.length === 0) return
      for (const msg of waiting) {
        if (msg.to === 'node-b' && deaf.b) continue
        const target = brains.get(msg.to)
        if (target === undefined) continue
        await target.manager.onRemote({ id: `m-${round}-${msg.op}`, kind: 'msg', device: msg.to, from: msg.from, helper: msg.helper, op: msg.op, text: msg.text, item: '', info: msg.info, status: 'sent', at: 1, createdAt: 1 } as never)
      }
    }
  }
  const restartA = async (): Promise<Brain> => {
    a.manager.shutdown()
    const next = make('node-a', 'node-b', dbA)
    Object.assign(a, next)
    await next.manager.restore()
    return next
  }
  return { a, b, up, bus, deaf, sync, flush, restartA }
}

/** A helper card placed by A on B, as delegate writes it, with B's job lease on it: B's run of it is gone (a ghost). */
async function ghost(a: Brain, options: { lease?: 'running' | 'done' | 'none'; heartbeatAt?: number; startedAt?: number; token?: string } = {}): Promise<string> {
  const startedAt = options.startedAt ?? Date.now()
  const row = await a.db.upsert('chat_item', {
    kind: 'helper',
    text: 'Design the posters.',
    meta: JSON.stringify({ label: 'Posters', state: 'working', summary: 'Thinking', chat: 'project-chat', runToken: options.token ?? 'run-1', startedAt, placedBy: 'node-a', runOn: 'node-b', runsOnName: 'Desktop', pick: { account: 'acc', model: 'm' } }),
  })
  await a.db.upsert('project', { name: 'Print shop', description: '', path: '', profile: '', hidden: false, chats: ['project-chat'] } as never)
  if ((options.lease ?? 'running') !== 'none') {
    await a.db.upsert('turn_lease', { id: `job-${row.id}`, kind: 'job', chatId: 'project-chat', messageId: row.id, brainId: 'node-b', status: options.lease ?? 'running', attempt: 1, startedAt, heartbeatAt: options.heartbeatAt ?? Date.now(), prompt: 'Design the posters.' })
  }
  return row.id
}

function meta(row: ChatItem | null): Record<string, unknown> {
  return row === null ? {} : (JSON.parse(row.meta) as Record<string, unknown>)
}

async function stateOn(brain: Brain, id: string): Promise<unknown> {
  return meta(await brain.db.get('chat_item', id))['state']
}

describe('a helper can be stopped from any device that sees it', () => {
  it('stopped on the brain it was placed on, which lost its run: ended on both, its creator told once', async () => {
    const { a, b, flush } = pair()
    const id = await ghost(a)
    await a.manager.restore()
    await flush()
    expect(await b.manager.stop(id, 'the person (Stop on its card)')).toBe(true)
    await flush()
    expect(await stateOn(b, id)).toBe('stopped')
    expect(await stateOn(a, id)).toBe('stopped')
    // The brain that placed it holds the creator's chat: the notice is told there, once.
    expect(a.delivered).toHaveLength(1)
    expect(a.delivered[0]?.chat).toBe('project-chat')
    expect(a.delivered[0]?.note).toContain('"Posters" stopped: stopped by the person (Stop on its card)')
    expect(b.delivered).toHaveLength(0)
    expect((await b.db.get('turn_lease', `job-${id}`))?.status).toBe('failed')
    expect(a.manager.live()).toHaveLength(0)
  })

  it('stopped on the brain that placed it: the stop goes to the runner, which ends it though it lost the run', async () => {
    const { a, b, flush } = pair()
    const id = await ghost(a)
    await a.manager.restore()
    await flush()
    expect(await a.manager.stop(id, 'the agent (helper_stop)')).toBe(true)
    await flush()
    expect(await stateOn(a, id)).toBe('stopped')
    expect(await stateOn(b, id)).toBe('stopped')
    expect(a.delivered).toHaveLength(1)
    expect(a.delivered[0]?.note).toContain('stopped by the agent (helper_stop)')
    expect(b.delivered).toHaveLength(0)
    // Stopping it again finds nothing working.
    expect(await a.manager.stop(id)).toBe(false)
    expect(await b.manager.stop(id)).toBe(false)
    await flush()
    expect(a.delivered).toHaveLength(1)
  })

  it('a runner that never answers the stop (an older app): the card is ended where it was stopped, after the grace', async () => {
    const { a, b, deaf, flush } = pair({ stopGraceMs: 150 })
    deaf.b = true
    const id = await ghost(a)
    await a.manager.restore()
    await flush()
    expect(await a.manager.stop(id, 'the agent (helper_stop)')).toBe(true)
    await flush()
    expect(await stateOn(a, id)).toBe('working')
    await waitFor(async () => (await stateOn(a, id)) === 'stopped', 4_000)
    await flush()
    expect(await stateOn(b, id)).toBe('stopped')
    await sleep(100)
    expect(a.delivered).toHaveLength(1)
  })

  it('nobody has the run (the brain it ran on is offline): stopping it ends it at once', async () => {
    const { a, b, up, flush } = pair()
    const id = await ghost(a)
    await a.manager.restore()
    await flush()
    up.b = false
    expect(await a.manager.stop(id, 'the person (Stop on its card)')).toBe(true)
    expect(await stateOn(a, id)).toBe('stopped')
    expect((await a.db.get('turn_lease', `job-${id}`))?.status).toBe('failed')
    up.b = true
    await flush()
    expect(await stateOn(b, id)).toBe('stopped')
    expect(a.delivered).toHaveLength(1)
    expect(b.delivered).toHaveLength(0)
  })

  it('a helper really running on the other brain is stopped there, and its creator still hears once', async () => {
    const { a, b, flush } = pair()
    // B "runs" it: its lease is live and B's process has it (a long step), so a stop from A must reach it.
    const id = await ghost(a)
    await flush()
    let aborted = false
    // Stand-in for B's run: its card stays working until the stop reaches B.
    ;(b.manager as unknown as { runs: Map<string, unknown> }).runs.set(id, {
      id,
      label: 'Posters',
      chat: 'project-chat',
      token: 'run-1',
      origin: 'node-a',
      controller: { abort: () => (aborted = true) },
      lastStepAt: Date.now(),
    })
    await a.manager.restore()
    expect(await a.manager.stop(id, 'the agent (helper_stop)')).toBe(true)
    await flush()
    expect(aborted).toBe(true)
    ;(b.manager as unknown as { runs: Map<string, unknown> }).runs.delete(id)
  })
})

describe('the orphan watch ends a card whose run is gone', () => {
  it('placed elsewhere, its runner finished its lease but the card stayed working: the brain that placed it ends it', async () => {
    let clock = 10_000_000
    const { a, b, flush } = pair({ now: () => clock })
    const id = await ghost(a, { lease: 'done', startedAt: clock, heartbeatAt: clock })
    await a.manager.restore()
    await flush()
    clock += 60_000
    expect(await a.manager.reap()).toBe(0)
    clock += 3 * 60_000
    expect(await a.manager.reap()).toBe(1)
    expect(await a.manager.reap()).toBe(0)
    await flush()
    expect(await stateOn(a, id)).toBe('stopped')
    expect(await stateOn(b, id)).toBe('stopped')
    expect(String(meta(await a.db.get('chat_item', id))['endReason'])).toContain('its run was lost')
    expect(a.delivered).toHaveLength(1)
  })

  it('run here, its lease left running with no heartbeat and no run in this process: ended, its creator told once', async () => {
    let clock = 20_000_000
    const { a, b, flush } = pair({ now: () => clock })
    const id = await ghost(a, { startedAt: clock, heartbeatAt: clock })
    await flush()
    clock += 5 * 60_000
    // B runs it (runOn names B), B's own lease, no heartbeat for 5 min, no run in B: B ends it and tells A.
    expect(await b.manager.reap()).toBe(1)
    await flush()
    expect(await stateOn(a, id)).toBe('stopped')
    expect(await stateOn(b, id)).toBe('stopped')
    expect(a.delivered).toHaveLength(1)
    // A, looking at the same card later, finds nothing to do.
    clock += 5 * 60_000
    expect(await a.manager.reap()).toBe(0)
    await flush()
    expect(a.delivered).toHaveLength(1)
  })

  it('a live lease on another brain, a young card, or a card nobody here owns is left alone', async () => {
    let clock = 30_000_000
    const { a, b, flush } = pair({ now: () => clock })
    const live = await ghost(a, { startedAt: clock, heartbeatAt: clock, token: 'live' })
    await a.manager.restore()
    await flush()
    clock += 60_000
    // Its lease beats (B is running it).
    await a.db.upsert('turn_lease', { id: `job-${live}`, heartbeatAt: clock })
    clock += 60_000
    expect(await a.manager.reap()).toBe(0)
    // A card that names no brain and has no lease (another app's) is not ours to end while it is young (under
    // ORPHAN_ANY_MS of silence; runlist.test.ts has the long-silent case).
    await b.db.upsert('chat_item', { kind: 'helper', text: 'x', meta: JSON.stringify({ label: 'Phone job', state: 'working', runToken: 'p1', startedAt: clock - 30 * 60_000 }) })
    expect(await b.manager.reap()).toBe(0)
    expect(await stateOn(a, live)).toBe('working')
  })

  it('restore starts the watch, which ends a ghost by itself', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const delivered: Delivery[] = []
    const manager = new HelperManager({
      store: db,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'k', baseUrl: 'http://127.0.0.1:9', allowHttp: true }),
      workerTools: [],
      deliver: (note, chat) => {
        delivered.push({ note, chat: chat ?? MAIN_CHAT })
      },
      reapEveryMs: 40,
      reapAfterMs: 0,
    })
    cleanups.push(() => manager.shutdown())
    await manager.restore()
    // Appears after start-up (replicated in): no run here, its lease (this brain's) is long dead.
    const row = await db.upsert('chat_item', { kind: 'helper', text: 'Old.', meta: JSON.stringify({ label: 'Lost', state: 'working', runToken: 'r', startedAt: 1 }) })
    await db.upsert('turn_lease', { id: `job-${row.id}`, kind: 'job', chatId: MAIN_CHAT, messageId: row.id, brainId: db.deviceId, status: 'running', attempt: 1, startedAt: 1, heartbeatAt: 1, prompt: 'Old.' })
    await waitFor(async () => meta(await db.get('chat_item', row.id))['state'] === 'stopped', 4_000)
    await sleep(120)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.note).toContain('"Lost" stopped: its run was lost')
  })
})

describe('the end wins when the devices replicate', () => {
  it('a stale "working" write of the same run never brings an ended card back, on either device', async () => {
    const { a, b, sync } = pair()
    const id = await ghost(a)
    await sync()
    // B ends it; before that reaches A, A writes its stale view (a heads-up mark, a summary) with a newer stamp.
    const rowB = await b.db.get('chat_item', id)
    await b.db.upsert('chat_item', { id, kind: 'helper', text: rowB?.text ?? '', meta: JSON.stringify({ ...meta(rowB), state: 'stopped', summary: 'Stopped: it was stopped' }) })
    await sleep(2)
    const rowA = await a.db.get('chat_item', id)
    await a.db.upsert('chat_item', { id, kind: 'helper', text: rowA?.text ?? '', meta: JSON.stringify({ ...meta(rowA), summary: 'Still thinking' }) })
    await sync()
    await sync()
    expect(await stateOn(b, id)).toBe('stopped')
    expect(await stateOn(a, id)).toBe('stopped')
  })

  it('a new run of it (a push carries a new run token) does go back to working', () => {
    const endedBeatsWorking = (dbModule as unknown as { endedBeatsWorking: (entity: string, ours: Record<string, unknown>, incoming: Record<string, unknown>) => boolean }).endedBeatsWorking
    const ended = { kind: 'helper', meta: JSON.stringify({ state: 'stopped', runToken: 'one' }) }
    expect(endedBeatsWorking('chat_item', ended, { kind: 'helper', meta: JSON.stringify({ state: 'working', runToken: 'one' }) })).toBe(true)
    expect(endedBeatsWorking('chat_item', ended, { kind: 'helper', meta: JSON.stringify({ state: 'working', runToken: 'two' }) })).toBe(false)
    expect(endedBeatsWorking('chat_item', { kind: 'helper', meta: JSON.stringify({ state: 'working', runToken: 'one' }) }, ended)).toBe(false)
    expect(endedBeatsWorking('task', ended, ended)).toBe(false)
  })
})

describe('the quiet heads-up', () => {
  it('a helper placed on another brain gets ONE heads-up over many minutes, with the link up the whole time', async () => {
    let clock = 40_000_000
    const { a, flush } = pair({ now: () => clock, quietMinutes: 10 })
    const id = await ghost(a, { startedAt: clock, heartbeatAt: clock })
    await a.manager.restore()
    await flush()
    let sent = 0
    for (let minute = 0; minute < 30; minute += 1) {
      clock += 60_000
      // The link is up: every few seconds the start-nobody-took check sees it and moves its send time on.
      await a.manager.takeBack(45_000)
      await a.db.upsert('turn_lease', { id: `job-${id}`, heartbeatAt: clock })
      sent += await a.manager.checkQuiet()
    }
    expect(sent).toBe(1)
    expect(a.delivered).toHaveLength(1)
    expect(a.delivered[0]?.note).toContain('has taken no new step for 10 min')
    expect(meta(await a.db.get('chat_item', id))['quietWarned']).toBe('run-1')
  })

  it('a restart of the brain that sent it never sends it again for the same run', async () => {
    let clock = 50_000_000
    const { a, flush, restartA } = pair({ now: () => clock, quietMinutes: 10 })
    const id = await ghost(a, { startedAt: clock, heartbeatAt: clock })
    await a.manager.restore()
    await flush()
    clock += 11 * 60_000
    await a.db.upsert('turn_lease', { id: `job-${id}`, heartbeatAt: clock })
    expect(await a.manager.checkQuiet()).toBe(1)
    const again = await restartA()
    clock += 11 * 60_000
    await again.db.upsert('turn_lease', { id: `job-${id}`, heartbeatAt: clock })
    expect(await again.manager.checkQuiet()).toBe(0)
    expect(again.delivered).toHaveLength(0)
  })

  it('after a restart, the brain that placed it watches it again by itself (the watch starts at restore)', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const delivered: Delivery[] = []
    const link: OffloadLink = {
      selfId: () => 'node-a',
      isSelf: (id) => id === 'node-a',
      up: (id) => id === 'node-b',
      place: async () => ({ device: 'node-b', name: 'Desktop', why: 'it needs a computer' }),
      send: async () => undefined,
      leaseHolder: async () => ({ device: 'node-b', running: true }),
      deviceName: async () => 'Desktop',
    }
    const manager = new HelperManager({
      store: db,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'k', baseUrl: 'http://127.0.0.1:9', allowHttp: true }),
      workerTools: [],
      deliver: (note, chat) => {
        delivered.push({ note, chat: chat ?? MAIN_CHAT })
      },
      offload: link,
      quietMinutes: 1,
      quietCheckMs: 30,
      reapEveryMs: 0,
    })
    cleanups.push(() => manager.shutdown())
    await db.upsert('chat_item', { kind: 'helper', text: 'Long job.', meta: JSON.stringify({ label: 'Placed long', state: 'working', runToken: 'r-restart', startedAt: Date.now() - 5 * 60_000, placedBy: 'node-a', runOn: 'node-b' }) })
    await manager.restore()
    await waitFor(() => delivered.length > 0, 4_000)
    await sleep(200)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.note).toContain('"Placed long" has taken no new step')
  })

  it('never for a helper that has ended (its end arrived by replication, no result message)', async () => {
    let clock = 60_000_000
    const { a, b, flush, sync } = pair({ now: () => clock, quietMinutes: 10 })
    const id = await ghost(a, { startedAt: clock, heartbeatAt: clock })
    await a.manager.restore()
    await flush()
    const rowB = await b.db.get('chat_item', id)
    await b.db.upsert('chat_item', { id, kind: 'helper', text: rowB?.text ?? '', meta: JSON.stringify({ ...meta(rowB), state: 'stopped' }) })
    await sync()
    for (let minute = 0; minute < 20; minute += 1) {
      clock += 60_000
      expect(await a.manager.checkQuiet()).toBe(0)
    }
    expect(a.delivered).toHaveLength(0)
    expect(a.manager.live()).toHaveLength(0)
  })
})
