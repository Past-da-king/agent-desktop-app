/**
 * One brain answers the main chat at a time (26 Nov 2026: he typed on the PC while the server held the main chat; the
 * PC's own brain answered him and the server never saw it, two brains each with their own conversation). Two brains
 * over the real replication, with a slow PC clock: whatever device he types on, the brain holding the main chat
 * answers, his message shows at once where he typed it, the reply arrives everywhere, and a handover keeps it all.
 *
 * SPLIT_RED=1 runs the same story with the holder route switched off: the PC answers its own message (the bug).
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, MAIN_CHAT, PeerClock, SyncClient, type JobRow, type Settings } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Replicator, registerSyncRoutes, type PeerTarget, type SyncRouteClock } from '../src/main/devices/replicate'
import { handleMainPost, makeMainRoute, pickMainHolder, MAIN_STICKY_MS } from '../src/main/devices/offload-wire'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import { Offload } from '../src/main/runtime/offload'
import { Runner } from '../src/main/runtime/runner'
import { TurnLeases } from '../src/main/runtime/turns'
import { buildToolset } from '../src/main/runtime/toolset'
import { startTestHost, type TestHost } from './devices-host'
import { secretsView, settingsView } from './support'

const SKEW = 35 * 60_000
const PLAN: Partial<Settings> = { mode: 'subscription', cli: 'claude', notifications: false, onboarded: true }
const RED = process.env['SPLIT_RED'] === '1'

interface Node {
  id: string
  store: Store
  host: TestHost
  clock: PeerClock
  runner: Runner
  prompts: string[]
  offload: Offload
  leases: TurnLeases
  replicator: Replicator | null
  /** Its link to the other brain works (what `reachable` reads). */
  linked: boolean
}
const nodes: Node[] = []
afterEach(async () => {
  for (const node of nodes.splice(0)) {
    node.replicator?.stop()
    node.offload.stop()
    await node.runner.dispose()
    await node.host.close()
    node.store.close()
  }
})

async function node(id: string, skew: number, priority: number, reply: (n: number) => { text: string; tool?: string }): Promise<Node> {
  const clock = new PeerClock(() => Date.now() + skew)
  clock.setSelfSynced(skew === 0)
  const store = new Store(':memory:', () => clock.now())
  const host = await startTestHost(id)
  const routeClock: SyncRouteClock = { rawNow: () => clock.rawNow(), isSelfSynced: () => clock.isSelfSynced() }
  registerSyncRoutes(host, store, () => '', routeClock)
  const prompts: string[] = []
  const cli = {
    turn: async (request: CliTurnRequest) => {
      prompts.push(request.prompt)
      const out = reply(prompts.length)
      if (out.tool !== undefined) {
        await request.onCall({ id: `t${id}${prompts.length}`, name: out.tool, input: {} })
        await request.onResult({ id: `t${id}${prompts.length}`, name: out.tool, input: {} }, `${out.tool} ok`, false)
      }
      await request.onEvent({ type: 'said', text: out.text })
      return { text: out.text }
    },
  } as unknown as CliHost
  const leases = new TurnLeases({ store, selfId: () => id, resumeTurn: () => undefined, resumeJob: () => undefined, now: () => clock.now() })
  const runner = new Runner({
    store,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...PLAN }),
    secrets: secretsView('k'),
    tools: buildToolset({ store }),
    providerFactory: () => null,
    timeZone: 'UTC',
    classifier: null,
    cli,
    devices: { leases },
    local: { get: (key) => store.localValue(key), set: (key, value) => store.setLocalValue(key, value) },
  })
  const made = { id, store, host, clock, runner, prompts, leases, replicator: null, linked: true } as unknown as Node
  made.offload = new Offload({
    store,
    selfId: () => id,
    isSelf: (other) => other === id,
    reachable: () => made.linked,
    capacity: () => ({ name: id, kind: 'desktop', accounts: ['plan'], cap: 4, active: 0, browser: false, mainPost: true }),
    mode: () => 'best',
    handle: async (msg: JobRow) => handleMainPost(msg, runner) ?? true,
    now: () => clock.now(),
    retryScanMs: 100,
    scanMs: 200,
  })
  const route = makeMainRoute({ store, offload: made.offload, selfId: () => id, isSelf: (other) => other === id, now: () => clock.now(), runner: () => runner, takeBackMs: 1_500 })
  store.onChange((change) => {
    if (change.entity === 'turn_lease' && change.row !== undefined) route.noteLease(change.row as never)
  })
  if (!RED) runner.setMainRoute(route)
  for (const [brain, rank] of [['pc', 0], ['server', 1]] as const) {
    await store.upsert('device', { id: brain, name: brain, kind: 'desktop', platform: 'linux', roles: ['brain'], priority: rank, urls: [], fp: '', facts: {}, pairedAt: 1, lastSeen: 0, revoked: false } as never)
  }
  void priority
  nodes.push(made)
  return made
}

function wire(a: Node, b: Node): void {
  for (const [self, peer] of [[a, b], [b, a]] as const) self.host.passes.set(`pass-${peer.id}`, { deviceId: peer.id, node: true })
  for (const [self, peer] of [[a, b], [b, a]] as const) {
    const target: PeerTarget = { id: peer.id, name: peer.id, urls: [peer.host.url], fp: '' }
    self.replicator = new Replicator({
      store: self.store,
      selfId: () => self.id,
      pass: () => `pass-${self.id}`,
      peers: async () => [target],
      clientFor: (url, _peer, pass) => new SyncClient(url, pass, fetch, true),
      rawClock: () => self.clock.rawNow(),
      onPeerTime: (p, time) => self.clock.sample({ peer: p.id, name: p.name, ...time }),
      waitSeconds: 1,
      initialBackoffMs: 50,
      maxBackoffMs: 200,
      refreshMs: 60_000,
    })
  }
}

async function sync(a: Node, b: Node): Promise<void> {
  await a.replicator?.syncOnce()
  await b.replicator?.syncOnce()
  await a.replicator?.syncOnce()
}

/** Replicate until `done` holds (a message, the turn it starts, its reply: each hop is one more pass). */
async function syncUntil(a: Node, b: Node, done: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await done())) {
    if (Date.now() > end) throw new Error('replication never settled')
    await sync(a, b)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const users = async (n: Node): Promise<string[]> => (await n.store.list('chat_item')).filter((row) => row.kind === 'user').map((row) => row.text)
const talk = async (n: Node): Promise<string[]> =>
  (await n.store.list('chat_item')).filter((row) => row.kind === 'user' || row.kind === 'agent').map((row) => row.text.split(':')[0] ?? '')

describe('one brain holds the main chat', () => {
  it('picks the brain that answered last while it is ready and the talk is recent, else the answer order', () => {
    const isSelf = (id: string): boolean => id === 'pc'
    const order = ['pc', 'server']
    expect(pickMainHolder({ lastLease: { brainId: 'server', at: 1_000 }, now: 2_000, order, isSelf, ready: () => true })).toBe('server')
    expect(pickMainHolder({ lastLease: { brainId: 'server', at: 1_000 }, now: 2_000, order, isSelf, ready: () => false })).toBe('pc')
    expect(pickMainHolder({ lastLease: { brainId: 'server', at: 0 }, now: MAIN_STICKY_MS + 1, order, isSelf, ready: () => true })).toBe('pc')
    expect(pickMainHolder({ lastLease: null, now: 0, order: ['server', 'pc'], isSelf, ready: () => true })).toBe('server')
  })

  it('PC and phone typing into one chat while the brains hand over: one conversation, one answerer, nothing lost', async () => {
    const pc = await node('pc', -SKEW, 0, (n) => ({ text: `PC reply ${n}: noted.` }))
    const server = await node('server', 0, 1, (n) => ({ text: `Server reply ${n}: the booking reference is BK-7731.`, tool: 'book_room' }))
    wire(pc, server)
    pc.offload.start()
    server.offload.start()
    await sync(pc, server)

    // The PC is away; his phone is on the server, which answers and so holds the main chat.
    pc.linked = false
    server.linked = false
    await server.runner.send('Book the room for Friday')
    await waitFor(() => server.prompts.length === 1 && !server.runner.state().running, 10_000)
    pc.linked = true
    server.linked = true
    await pc.offload.beat()
    await server.offload.beat()
    await syncUntil(pc, server, async () => (await talk(pc)).includes('Server reply 1'))

    // He types on the PC. It shows on the PC at once, before any replication, and the server answers it.
    await pc.runner.send('FGFGH')
    expect(await users(pc)).toContain('FGFGH')
    if (RED) {
      await waitFor(() => pc.prompts.length > 0, 10_000)
      expect(pc.prompts, 'the PC answered its own message while the server held the chat (split brains)').toHaveLength(0)
    }
    await syncUntil(pc, server, async () => server.prompts.length === 2 && !server.runner.state().running && (await talk(pc)).includes('Server reply 2'))
    expect(pc.prompts).toHaveLength(0)
    expect(server.prompts[1]).toContain('FGFGH')

    // His phone (on the server) and the PC at the same moment: still one answerer, both messages answered.
    await Promise.all([server.runner.send('also check parking'), pc.runner.send('ARE YOU FIXING THE APP')])
    await syncUntil(pc, server, async () => {
      const said = (await server.store.list('chat_item')).filter((row) => row.kind === 'user').map((row) => row.text)
      return said.includes('ARE YOU FIXING THE APP') && !server.runner.state().running && server.prompts.join('\n').includes('ARE YOU FIXING THE APP')
    })
    await syncUntil(pc, server, async () => !server.runner.state().running && JSON.stringify(await talk(pc)) === JSON.stringify(await talk(server)))
    expect(pc.prompts).toHaveLength(0)

    // The server goes away mid-conversation. The PC answers the next message itself, and knows everything said so far.
    server.linked = false
    pc.linked = false
    await pc.runner.send('And what time is it booked for?')
    await waitFor(() => pc.prompts.length === 1 && !pc.runner.state().running, 10_000)
    const first = pc.prompts[0] ?? ''
    for (const piece of ['Book the room for Friday', 'BK-7731', 'book_room', 'FGFGH', 'ARE YOU FIXING THE APP', 'also check parking']) expect(first).toContain(piece)

    // Every message he sent is in the chat once, on both brains, in the same order.
    pc.linked = true
    server.linked = true
    await syncUntil(pc, server, async () => JSON.stringify(await talk(pc)) === JSON.stringify(await talk(server)))
    const said = await users(pc)
    for (const text of ['Book the room for Friday', 'FGFGH', 'also check parking', 'ARE YOU FIXING THE APP', 'And what time is it booked for?']) {
      expect(said.filter((each) => each === text)).toHaveLength(1)
    }
  }, 60_000)

  it('a holder that never takes the message: the PC takes it back and answers within seconds', async () => {
    const pc = await node('pc', -SKEW, 0, (n) => ({ text: `PC reply ${n}` }))
    const server = await node('server', 0, 1, (n) => ({ text: `Server reply ${n}` }))
    wire(pc, server)
    pc.offload.start()
    await sync(pc, server)
    // The server answered last and still looks up, but its offload is dead (it never handles messages).
    pc.linked = false
    await server.runner.send('hello')
    await waitFor(() => server.prompts.length === 1 && !server.runner.state().running, 10_000)
    pc.linked = true
    await server.offload.beat()
    await syncUntil(pc, server, async () => (await talk(pc)).includes('Server reply 1'))
    await pc.runner.send('are you there?')
    expect(await users(pc)).toContain('are you there?')
    await waitFor(() => pc.prompts.length === 1, 8_000)
    expect(pc.prompts[0]).toContain('are you there?')
    expect((await users(pc)).filter((each) => each === 'are you there?')).toHaveLength(1)
  }, 30_000)
})
