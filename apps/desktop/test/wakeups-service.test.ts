/**
 * Wake-ups across two nodes on a fake clock (main/wakeups/service.ts over the real Store and its change log): a wake
 * rings where it was sent, the other computer joins after 60 s, an answer on one stops the other after one sync,
 * snooze stops both and both ring again, dedupe never double rings, routines hear wakeup.fired and wakeup.acked, and
 * no agent tool can answer or silence a wake.
 */
import { describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { WakeupService, type RingItem, type WakeEvent, type WakeSnapshot } from '../src/main/wakeups/service'
import { wakeTools } from '../src/main/tools/wakeups'
import { buildToolset } from '../src/main/runtime/toolset'
import { SETTINGS_READ_ONLY } from '../src/main/tools/app-control'
import { testContext } from './support'

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0)

class Clock {
  t = T0
  now = (): number => this.t
  add(ms: number): void {
    this.t += ms
  }
}

interface Node {
  id: string
  store: Store
  service: WakeupService
  ringing: RingItem[][]
  events: WakeEvent[]
  sent: WakeSnapshot[]
  current(): RingItem[]
}

function node(id: string, clock: Clock, options: { rings?: boolean; others?: string[] } = {}): Node {
  const store = new Store(':memory:', clock.now)
  const ringing: RingItem[][] = []
  const events: WakeEvent[] = []
  const sent: WakeSnapshot[] = []
  const service = new WakeupService({
    store,
    onChange: (listener) => store.onChange(listener),
    selfId: () => id,
    selfName: () => id.toUpperCase(),
    selfRings: () => options.rings ?? true,
    devices: async () => [id, ...(options.others ?? [])].map((d) => ({ id: d, name: d.toUpperCase(), kind: d.startsWith('srv') ? ('server' as const) : ('desktop' as const) })),
    settings: () => ({ snoozeMinutes: 5, quietHours: '' }),
    idleSeconds: () => null,
    ringer: { show: (items) => ringing.push(items) },
    broadcast: (snap) => sent.push(snap),
    emitEvent: (event) => events.push(event),
    now: clock.now,
  })
  service.start()
  return { id, store, service, ringing, events, sent, current: () => ringing[ringing.length - 1] ?? [] }
}

/** One replication pass both ways (what devices/replicate.ts does over the wire). */
async function sync(a: Node, b: Node): Promise<void> {
  const ab = a.store.changesAfter(0, 5000, b.id)
  if (ab.changes.length > 0) await b.store.applyRemote(ab.changes, a.id)
  const ba = b.store.changesAfter(0, 5000, a.id)
  if (ba.changes.length > 0) await a.store.applyRemote(ba.changes, b.id)
  await settle(a, b)
}

async function settle(...nodes: Node[]): Promise<void> {
  for (let i = 0; i < 3; i++) {
    for (const n of nodes) {
      n.service.kick()
      await n.service.settled()
    }
  }
}

const URGENT = { severity: 'urgent' as const, title: 'Client call starts now', whatToDo: 'Join the call', source: { kind: 'test', ref: '', link: 'https://example.com/join' }, devices: 'here' as const, dedupeKey: '', at: null }

describe('wake-ups across nodes', () => {
  it('rings where it was sent, the other computer joins after 60 s, an answer on one stops both after one sync', async () => {
    const clock = new Clock()
    const a = node('pc-a', clock, { others: ['pc-b'] })
    const b = node('pc-b', clock, { others: ['pc-a'] })
    const fired = await a.service.fire(URGENT, 'routine: Meetings')
    expect(fired.ok).toBe(true)
    await sync(a, b)
    expect(a.current().map((i) => i.title)).toEqual(['Client call starts now'])
    expect(b.current()).toEqual([])

    clock.add(60_000)
    await settle(a, b)
    expect(b.current()).toHaveLength(1)
    expect(b.current()[0]).toMatchObject({ severity: 'urgent', whatToDo: 'Join the call', sound: true })

    // Still ringing hours later: nothing stops it but him.
    clock.add(3 * 60 * 60_000)
    await settle(a, b)
    expect(a.current()).toHaveLength(1)
    expect(b.current()).toHaveLength(1)

    expect(await b.service.ack(fired.id, { id: 'pc-b', name: 'PC-B' })).toBe(true)
    await settle(b)
    expect(b.current()).toEqual([])
    expect(a.current()).toHaveLength(1)
    await sync(a, b)
    expect(a.current()).toEqual([])
    const [view] = await a.service.list()
    expect(view).toMatchObject({ state: 'acked', ackedBy: 'PC-B' })
  })

  it('snooze stops both, and both ring again at the end', async () => {
    const clock = new Clock()
    const a = node('pc-a', clock, { others: ['pc-b'] })
    const b = node('pc-b', clock, { others: ['pc-a'] })
    const fired = await a.service.fire({ ...URGENT, severity: 'critical', devices: 'all' }, 'agent')
    await sync(a, b)
    expect(a.current()).toHaveLength(1)
    expect(b.current()).toHaveLength(1)
    expect(await a.service.snooze(fired.id, { id: 'pc-a', name: 'PC-A' })).toBe(true)
    await sync(a, b)
    expect(a.current()).toEqual([])
    expect(b.current()).toEqual([])
    clock.add(5 * 60_000)
    await settle(a, b)
    expect(a.current()).toHaveLength(1)
    expect(b.current()).toHaveLength(1)
  })

  it('two identical fires ring once', async () => {
    const clock = new Clock()
    const a = node('pc-a', clock)
    const one = await a.service.fire({ ...URGENT, dedupeKey: 'msg-42' }, 'desk: Slack')
    const two = await a.service.fire({ ...URGENT, dedupeKey: 'msg-42' }, 'desk: Slack')
    await settle(a)
    expect(two.id).toBe(one.id)
    expect(two.message).toContain('no second ring')
    expect(a.current()).toHaveLength(1)
    expect((await a.store.list('wakeup')).filter((r) => r.kind === 'wake')).toHaveLength(1)
  })

  it('a booked wake rings at its time; withdrawn before then it never rings; a ringing one keeps ringing marked Cancelled', async () => {
    const clock = new Clock()
    const a = node('pc-a', clock)
    const booked = await a.service.fire({ ...URGENT, dedupeKey: 'evt-7|5', at: T0 + 10 * 60_000 }, 'routine')
    await settle(a)
    expect(a.current()).toEqual([])
    expect(await a.service.withdraw('evt-7|5')).toContain('withdrawn')
    clock.add(11 * 60_000)
    await settle(a)
    expect(a.current()).toEqual([])
    void booked

    const now = await a.service.fire({ ...URGENT, title: 'Board meeting', dedupeKey: 'evt-8|0' }, 'routine')
    await settle(a)
    expect(a.current()).toHaveLength(1)
    expect(await a.service.withdraw(now.id)).toContain('Cancelled: Board meeting')
    await settle(a)
    expect(a.current()[0]?.title).toBe('Cancelled: Board meeting')
  })

  it('routines hear wakeup.fired and wakeup.acked from the node that fired it', async () => {
    const clock = new Clock()
    const a = node('pc-a', clock)
    const fired = await a.service.fire(URGENT, 'desk: Mail')
    await settle(a)
    await a.service.ack(fired.id, { id: 'phone-1', name: 'Phone' })
    await settle(a)
    expect(a.events.map((e) => e.event)).toEqual(['wakeup.fired', 'wakeup.acked'])
    expect(a.events[1]?.payload).toMatchObject({ id: fired.id, acked_on: 'Phone' })
  })

  it('linked devices get the live wakes with the sender clock; a headless node never rings itself', async () => {
    const clock = new Clock()
    const srv = node('srv-1', clock, { rings: false, others: ['phone-1'] })
    const fired = await srv.service.fire({ ...URGENT, devices: 'here' }, 'routine')
    await settle(srv)
    expect(srv.current()).toEqual([])
    const last = srv.sent[srv.sent.length - 1]
    expect(last?.now).toBe(T0)
    expect(last?.wakes.map((w) => w.id)).toEqual([fired.id])
    expect(last?.wakes[0]).toMatchObject({ state: 'ringing', link: 'https://example.com/join' })
    // The phone says it has it, then answers: the snapshot empties.
    await srv.service.seen(fired.id, 'phone-1')
    await srv.service.ack(fired.id, { id: 'phone-1', name: 'Phone' })
    await settle(srv)
    expect(srv.sent[srv.sent.length - 1]?.wakes).toEqual([])
  })

  it('no agent tool can answer, snooze or silence a wake, and agents cannot switch wake-up settings', async () => {
    const names = wakeTools(() => null).map((t) => t.spec.name)
    expect(names).toEqual(['wake_me', 'wake_withdraw', 'wake_list'])
    const all = buildToolset({ store: new Store(':memory:') } as never).map((t) => t.spec.name)
    expect(all).toContain('wake_me')
    expect(all.filter((n) => /wake/.test(n) && /(ack|answer|snooze|silence|stop|dismiss)/.test(n))).toEqual([])
    for (const key of ['wakeupsRingHere', 'wakeupSnoozeMinutes', 'wakeupQuietHours', 'wakeupVolume']) expect(SETTINGS_READ_ONLY.has(key)).toBe(true)
  })

  it('wake_me through the tool: rings now, books later, explains a refusal', async () => {
    const clock = new Clock()
    const a = node('pc-a', clock)
    const tools = wakeTools(() => a.service, clock.now)
    const wakeMe = tools.find((t) => t.spec.name === 'wake_me')
    const list = tools.find((t) => t.spec.name === 'wake_list')
    const ctx = testContext()
    expect(await wakeMe?.run({ severity: 'urgent', title: 'Ops: site down', what_to_do: 'Open the status page', source: { kind: 'agent', link: 'https://status.example.com' } }, ctx)).toContain('ringing now')
    expect(await wakeMe?.run({ severity: 'heads_up', title: 'Standup', what_to_do: 'Join', in_minutes: 15, dedupe_key: 'e1|15' }, ctx)).toContain('rings at')
    expect(await wakeMe?.run({ severity: 'loud', title: 'x', what_to_do: 'y' }, ctx)).toContain('severity must be')
    expect(await wakeMe?.run({ severity: 'urgent', title: 'x', what_to_do: '' }, ctx)).toContain('what_to_do')
    const log = String(await list?.run({}, ctx))
    expect(log).toContain('Urgent: Ops: site down (ringing')
    expect(log).toContain('Heads-up: Standup (rings')
  })
})
