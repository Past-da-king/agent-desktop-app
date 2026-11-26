/**
 * A device whose clock is wrong must not put its chat rows out of order on the other devices (26 Nov 2026: the PC's
 * Windows clock was 35 minutes slow and its replies landed 35 minutes up the phone's chat). docs/devices/clock-skew.md.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { PeerClock } from '@agent/core'

import { parseW32tm, osClockSynced } from '../src/main/clock/app-clock'
import { Store } from '../src/main/db'
import { Replicator, registerSyncRoutes, type PeerTarget, type SyncRouteClock } from '../src/main/devices/replicate'
import { startTestHost, type TestHost } from './devices-host'
import { SyncClient } from '@agent/core'

const MIN = 60_000
const SKEW = 35 * MIN

interface Node {
  id: string
  store: Store
  host: TestHost
  pass: string
  clock: PeerClock
  replicator: Replicator | null
}

const nodes: Node[] = []

afterEach(async () => {
  for (const node of nodes.splice(0)) {
    node.replicator?.stop()
    await node.host.close()
    node.store.close()
  }
})

/** A node whose raw clock is `skew` off the real time, and whose OS says `synced` about it. */
async function node(id: string, skew: number, synced: boolean | null): Promise<Node> {
  const clock = new PeerClock(() => Date.now() + skew)
  clock.setSelfSynced(synced)
  const store = new Store(':memory:', () => clock.now())
  const host = await startTestHost(id)
  const routeClock: SyncRouteClock = { rawNow: () => clock.rawNow(), isSelfSynced: () => clock.isSelfSynced() }
  registerSyncRoutes(host, store, () => '', routeClock)
  const made: Node = { id, store, host, pass: `pass-${id}`, clock, replicator: null }
  nodes.push(made)
  return made
}

function mesh(all: Node[]): void {
  for (const a of all) for (const b of all) a.host.passes.set(b.pass, { deviceId: b.id, node: true })
}

function target(peer: Node): PeerTarget {
  return { id: peer.id, name: peer.id, urls: [peer.host.url], fp: '' }
}

function link(self: Node, reach: Node[]): Replicator {
  const replicator = new Replicator({
    store: self.store,
    selfId: () => self.id,
    pass: () => self.pass,
    peers: async () => reach.map(target),
    clientFor: (url, _peer, pass) => new SyncClient(url, pass, fetch, true),
    rawClock: () => self.clock.rawNow(),
    onPeerTime: (peer, time) => {
      self.clock.sample({ peer: peer.id, name: peer.name, ...time })
    },
    waitSeconds: 1,
    initialBackoffMs: 50,
    maxBackoffMs: 200,
    refreshMs: 60_000,
  })
  self.replicator = replicator
  return replicator
}

async function chatOrder(store: Store): Promise<string[]> {
  return (await store.list('chat_item')).map((row) => row.text)
}

describe('PeerClock', () => {
  const sampleFrom = (clock: PeerClock, peer: string, peerSkew: number, synced: boolean | null, heldMs = 0, wire = 40): void => {
    const sentAt = clock.rawNow()
    const peerNow = Date.now() + peerSkew + heldMs + wire / 2
    clock.sample({ peer, sentAt, receivedAt: sentAt + heldMs + wire, peerNow, heldMs, synced })
  }

  it.each([
    ['slow', -SKEW],
    ['fast', SKEW],
  ])('corrects a clock 35 minutes %s against a synced peer', (_label, skew) => {
    const clock = new PeerClock(() => Date.now() + skew)
    clock.setSelfSynced(false)
    sampleFrom(clock, 'server', 0, true)
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(2_000)
    expect(clock.report().warn).toBe(true)
    expect(clock.report().line).toContain(`35 minutes ${skew < 0 ? 'slow' : 'fast'}`)
  })

  it('takes out the time a long poll was held', () => {
    const clock = new PeerClock(() => Date.now() - SKEW)
    sampleFrom(clock, 'server', 0, true, 25_000)
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(2_000)
  })

  it('keeps its own clock when its OS says it is synced, and names the peer that is off', () => {
    const clock = new PeerClock(() => Date.now())
    clock.setSelfSynced(true)
    sampleFrom(clock, 'pc', -SKEW, false)
    expect(clock.correction()).toBe(0)
    expect(clock.report().warn).toBe(true)
    expect(clock.report().line).toContain("pc's clock is 35 minutes behind")
  })

  it('does not move on one unknown peer, but does on two that agree', () => {
    const clock = new PeerClock(() => Date.now() - SKEW)
    sampleFrom(clock, 'a', 0, null)
    expect(clock.correction()).toBe(0)
    sampleFrom(clock, 'b', 0, null)
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(2_000)
  })

  it('ignores samples with too much time on the wire, and sub-second noise', () => {
    const clock = new PeerClock(() => Date.now() - SKEW)
    sampleFrom(clock, 'slowlink', 0, true, 0, 30_000)
    expect(clock.correction()).toBe(0)
    const near = new PeerClock(() => Date.now() - 300)
    sampleFrom(near, 'server', 0, true)
    expect(near.correction()).toBe(0)
    expect(near.report().warn).toBe(false)
  })

  it('reads w32tm', () => {
    expect(parseW32tm('Leap Indicator: 3(not synchronized)\nSource: Local CMOS Clock\n')).toBe(false)
    expect(parseW32tm('The following error occurred: The service has not been started. (0x80070426)')).toBe(false)
    expect(parseW32tm('Source: time.windows.com,0x9\n')).toBe(true)
    expect(parseW32tm('')).toBe(null)
  })

  it('reads timedatectl', async () => {
    expect(await osClockSynced('linux', async () => 'yes\n')).toBe(true)
    expect(await osClockSynced('linux', async () => 'no\n')).toBe(false)
    expect(await osClockSynced('linux', async () => { throw new Error('no tool') })).toBe(null)
  })
})

describe('chat rows from a device with a wrong clock', () => {
  it.each([
    ['slow', -SKEW],
    ['fast', SKEW],
  ])('a reply from a PC 35 minutes %s lands after the message it answers, at the real time', async (_label, skew) => {
    const server = await node('server', 0, true)
    const pc = await node('pc', skew, false)
    mesh([server, pc])
    // The phone's message reaches the server first (the server's clock is right).
    await server.store.upsert('chat_item', { kind: 'user', text: 'question from the phone' })
    await link(pc, [server]).syncOnce()
    const asked = (await pc.store.list('chat_item'))[0]?.createdAt ?? 0

    const reply = await pc.store.upsert('chat_item', { kind: 'agent', text: 'reply from the PC' })
    // Real time, not the PC's: within seconds of now on a right clock.
    expect(Math.abs(reply.createdAt - Date.now())).toBeLessThan(5_000)
    expect(reply.createdAt).toBeGreaterThan(asked)

    await pc.replicator?.syncOnce()
    expect(await chatOrder(server.store)).toEqual(['question from the phone', 'reply from the PC'])
    expect(pc.clock.report().warn).toBe(true)
  })

  it('never stamps a new chat row before the newest one it follows, even before any peer answered', async () => {
    const pc = await node('pc', -SKEW, false)
    // A row from a device with the right time arrived; nothing has corrected this clock yet.
    await pc.store.applyRemote(
      [{ entity: 'chat_item', id: 'from-phone', deleted: false, stamp: `${Date.now()}-0-phone`, payload: { kind: 'user', text: 'question', meta: '{}', createdAt: Date.now() } }],
      'server',
    )
    const reply = await pc.store.upsert('chat_item', { kind: 'agent', text: 'reply' })
    expect(reply.createdAt).toBeGreaterThan(Date.now() - 5_000)
    expect(await chatOrder(pc.store)).toEqual(['question', 'reply'])
  })

  it('does not follow a row stamped more than a day ahead (a broken clock)', async () => {
    const store = new Store(':memory:')
    nodes.push({ id: 'x', store, host: { close: async () => undefined } as unknown as TestHost, pass: '', clock: new PeerClock(), replicator: null })
    await store.applyRemote(
      [{ entity: 'chat_item', id: 'future', deleted: false, stamp: `${Date.now()}-0-other`, payload: { kind: 'agent', text: 'future', meta: '{}', createdAt: Date.now() + 3 * 86_400_000 } }],
      'other',
    )
    const row = await store.upsert('chat_item', { kind: 'user', text: 'now' })
    expect(Math.abs(row.createdAt - Date.now())).toBeLessThan(5_000)
  })
})
