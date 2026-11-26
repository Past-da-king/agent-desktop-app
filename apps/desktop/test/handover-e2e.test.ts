/**
 * Two brains over the real replication, a PC whose clock is 35 minutes slow and a server that is right: the PC
 * answers, drops, the server answers the next message and must know what the PC said and did, and the PC must know
 * what the server said when it comes back (26 Nov 2026: "it's like I'm talking to a different agent").
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, PeerClock, SyncClient, type Settings } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Replicator, registerSyncRoutes, type PeerTarget, type SyncRouteClock } from '../src/main/devices/replicate'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { startTestHost, type TestHost } from './devices-host'
import { secretsView, settingsView } from './support'

const SKEW = 35 * 60_000
const PLAN: Partial<Settings> = { mode: 'subscription', cli: 'claude', notifications: false, onboarded: true }

interface Node {
  id: string
  store: Store
  host: TestHost
  clock: PeerClock
  runner: Runner
  prompts: string[]
  replicator: Replicator | null
}
const nodes: Node[] = []
afterEach(async () => {
  for (const node of nodes.splice(0)) {
    node.replicator?.stop()
    await node.runner.dispose()
    await node.host.close()
    node.store.close()
  }
})

async function node(id: string, skew: number, reply: (n: number) => { text: string; tool?: string }): Promise<Node> {
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
        await request.onCall({ id: `t${prompts.length}`, name: out.tool, input: {} })
        await request.onResult({ id: `t${prompts.length}`, name: out.tool, input: {} }, `${out.tool} ok`, false)
      }
      await request.onEvent({ type: 'said', text: out.text })
      return { text: out.text }
    },
  } as unknown as CliHost
  const runner = new Runner({
    store,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...PLAN }),
    secrets: secretsView('k'),
    tools: buildToolset({ store }),
    providerFactory: () => null,
    timeZone: 'UTC',
    classifier: null,
    cli,
    local: { get: (key) => store.localValue(key), set: (key, value) => store.setLocalValue(key, value) },
  })
  const made: Node = { id, store, host, clock, runner, prompts, replicator: null }
  nodes.push(made)
  return made
}

function wire(a: Node, b: Node): void {
  for (const [self, peer] of [[a, b], [b, a]] as const) {
    self.host.passes.set(`pass-${peer.id}`, { deviceId: peer.id, node: true })
  }
  for (const [self, peer] of [[a, b], [b, a]] as const) {
    const target: PeerTarget = { id: peer.id, name: peer.id, urls: [peer.host.url], fp: '' }
    self.replicator = new Replicator({
      store: self.store,
      selfId: () => self.id,
      pass: () => `pass-${self.id}`,
      peers: async () => [target],
      clientFor: (url, _peer, pass) => new SyncClient(url, pass, fetch, true),
      rawClock: () => self.clock.rawNow(),
      onPeerTime: (p, time) => {
        self.clock.sample({ peer: p.id, name: p.name, ...time })
      },
      waitSeconds: 1,
      initialBackoffMs: 50,
      maxBackoffMs: 200,
      refreshMs: 60_000,
    })
  }
}

async function say(n: Node, text: string): Promise<void> {
  const before = n.prompts.length
  await n.runner.send(text)
  await waitFor(() => n.prompts.length > before && !n.runner.state().running, 10_000)
}

async function sync(a: Node, b: Node): Promise<void> {
  await a.replicator?.syncOnce()
  await b.replicator?.syncOnce()
  await a.replicator?.syncOnce()
}

describe('a conversation that changes brains', () => {
  it('keeps the full recent conversation both ways, in order, with a slow PC clock', async () => {
    const pc = await node('pc', -SKEW, (n) => ({ text: `PC reply ${n}: the booking reference is BK-7731.`, tool: 'book_room' }))
    const server = await node('server', 0, (n) => ({ text: `Server reply ${n}: BK-7731 is confirmed.` }))
    wire(pc, server)

    await say(pc, 'Book the room for Friday')
    await sync(pc, server)

    // The PC drops; the server takes the next message and must know what the PC said and did.
    await say(server, 'What was the reference again?')
    const onServer = server.prompts[0] ?? ''
    expect(onServer).toContain('Book the room for Friday')
    expect(onServer).toContain('BK-7731')
    expect(onServer).toContain('book_room')

    await sync(pc, server)
    // The PC is back: it hears what the server said while it was away, and nothing it said itself.
    await say(pc, 'Thanks, and the time?')
    const back = pc.prompts[1] ?? ''
    expect(back).toContain('What was the reference again?')
    expect(back).toContain('Server reply 1')
    expect(back).not.toContain('PC reply 1')

    // Both nodes show the same chat in the same order, every reply under the message it answers.
    await sync(pc, server)
    const order = async (n: Node): Promise<string[]> => (await n.store.list('chat_item')).filter((r) => r.kind === 'user' || r.kind === 'agent').map((r) => r.text.split(':')[0] ?? '')
    const a = await order(pc)
    const b = await order(server)
    expect(a).toEqual(b)
    expect(a).toEqual(['Book the room for Friday', 'PC reply 1', 'What was the reference again?', 'Server reply 1', 'Thanks, and the time?', 'PC reply 2'])
  })
})
