import { afterEach, describe, expect, it } from 'vitest'

import { SyncClient } from '@agent/core'

import { Store } from '../src/main/db'
import { Replicator, peersFromRows, pullFrom, registerSyncRoutes, type PeerTarget } from '../src/main/devices/replicate'
import { startTestHost, type TestHost } from './devices-host'
import { waitFor } from '../../../packages/core/test/helpers'

interface Node {
  id: string
  store: Store
  host: TestHost
  pass: string
  replicator: Replicator | null
}

const nodes: Node[] = []
/** Changes moved over the wire by the replicators, both ways. */
const moved = { pushed: 0, pulled: 0 }

class CountingClient extends SyncClient {
  override async push(device: string, changes: Parameters<SyncClient['push']>[1], signal?: AbortSignal): Promise<number> {
    moved.pushed += changes.length
    return super.push(device, changes, signal)
  }

  override async pull(since: number, options: Parameters<SyncClient['pull']>[1] = {}): ReturnType<SyncClient['pull']> {
    const got = await super.pull(since, options)
    moved.pulled += got.changes.length
    return got
  }
}

afterEach(async () => {
  for (const node of nodes.splice(0)) {
    node.replicator?.stop()
    await node.host.close()
    node.store.close()
  }
})

async function node(id: string): Promise<Node> {
  const store = new Store(':memory:')
  const host = await startTestHost(id)
  registerSyncRoutes(host, store, () => `bundle-${id}`)
  const made: Node = { id, store, host, pass: `pass-${id}`, replicator: null }
  nodes.push(made)
  return made
}

/** Every node accepts every other node's pass (the mesh pass table, shared through the bundle). */
function mesh(all: Node[]): void {
  for (const a of all) for (const b of all) a.host.passes.set(b.pass, { deviceId: b.id, node: true })
}

function target(peer: Node): PeerTarget {
  return { id: peer.id, name: peer.id, urls: [peer.host.url], fp: '' }
}

/** `self` replicates with exactly the peers listed (who it can reach). */
function link(self: Node, reach: Node[], waitSeconds = 1, onLinkState?: () => void): Replicator {
  const replicator = new Replicator({
    ...(onLinkState === undefined ? {} : { onLinkState }),
    store: self.store,
    selfId: () => self.id,
    pass: () => self.pass,
    peers: async () => reach.map(target),
    clientFor: (url, _peer, pass) => new CountingClient(url, pass, fetch, true),
    waitSeconds,
    initialBackoffMs: 50,
    maxBackoffMs: 200,
    refreshMs: 60_000,
  })
  self.replicator = replicator
  return replicator
}

async function titles(store: Store): Promise<string[]> {
  return (await store.list('memory')).map((row) => row.title).sort()
}

describe('replication between nodes', () => {
  it('serves its change log with the sync wire format, skipping what came from the caller', async () => {
    const a = await node('dev_a')
    await a.store.upsert('memory', { title: 'Local one' })
    await a.store.applyRemote(
      [{ entity: 'memory', id: 'from-b', deleted: false, stamp: '5-0-store-b', payload: { title: 'From B' } }],
      'dev_b',
    )
    a.host.passes.set('pass-b', { deviceId: 'dev_b', node: true })
    a.host.passes.set('pass-c', { deviceId: 'dev_c', node: true })

    const asB = await new SyncClient(a.host.url, 'pass-b', fetch, true).pull(0)
    expect(asB.changes.map((c) => c.payload['title'])).toEqual(['Local one'])
    expect(asB.cursor).toBe(2)
    expect(asB.bundle).toBe('bundle-dev_a')

    const asC = await new SyncClient(a.host.url, 'pass-c', fetch, true).pull(0)
    expect(asC.changes.map((c) => c.payload['title']).sort()).toEqual(['From B', 'Local one'])

    // A screen's pass is not a node pass.
    a.host.passes.set('pass-phone', { deviceId: 'dev_phone', node: false })
    await expect(new SyncClient(a.host.url, 'pass-phone', fetch, true).pull(0)).rejects.toMatchObject({ status: 401 })
  })

  it('long-polls: a pull waiting on an idle log answers the moment a change lands', async () => {
    const a = await node('dev_a')
    const started = Date.now()
    const waiting = pullFrom(a.store, a.store.logSeq(), 5, 'dev_b')
    setTimeout(() => void a.store.upsert('memory', { title: 'Late' }), 150)
    const got = await waiting
    expect(got.changes.map((c) => c.payload['title'])).toEqual(['Late'])
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('converges A <-> B <-> C when A cannot reach C, relayed, with no echo storm', async () => {
    const a = await node('dev_a')
    const b = await node('dev_b')
    const c = await node('dev_c')
    mesh([a, b, c])
    // A only knows B; C only knows B; B is reached by both and reaches nobody itself (behind a firewall).
    link(a, [b]).start()
    link(c, [b]).start()

    await a.store.upsert('memory', { title: 'Written on A' })
    await waitFor(async () => (await titles(c.store)).includes('Written on A'), 8000)

    await c.store.upsert('memory', { title: 'Written on C' })
    await waitFor(async () => (await titles(a.store)).includes('Written on C'), 8000)

    expect(await titles(a.store)).toEqual(['Written on A', 'Written on C'])
    expect(await titles(b.store)).toEqual(['Written on A', 'Written on C'])
    expect(await titles(c.store)).toEqual(['Written on A', 'Written on C'])

    // Quiet afterwards: nothing is pushed back and forth once everyone has everything.
    await a.replicator?.syncOnce()
    await c.replicator?.syncOnce()
    const seqBefore = [a.store.logSeq(), b.store.logSeq(), c.store.logSeq()]
    moved.pushed = 0
    moved.pulled = 0
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await a.replicator?.syncOnce()
    await c.replicator?.syncOnce()
    expect([a.store.logSeq(), b.store.logSeq(), c.store.logSeq()]).toEqual(seqBefore)
    expect(moved).toEqual({ pushed: 0, pulled: 0 })
  })

  it('resolves a conflict the same way on every node (last writer by HLC)', async () => {
    let clock = 1_000_000
    const tick = (): number => clock
    const a: Node = { id: 'dev_a', store: new Store(':memory:', tick), host: await startTestHost('dev_a'), pass: 'pass-dev_a', replicator: null }
    const b: Node = { id: 'dev_b', store: new Store(':memory:', tick), host: await startTestHost('dev_b'), pass: 'pass-dev_b', replicator: null }
    const c: Node = { id: 'dev_c', store: new Store(':memory:', tick), host: await startTestHost('dev_c'), pass: 'pass-dev_c', replicator: null }
    for (const n of [a, b, c]) {
      registerSyncRoutes(n.host, n.store)
      nodes.push(n)
    }
    mesh([a, b, c])
    const ra = link(a, [b])
    const rc = link(c, [b])

    await a.store.upsert('memory', { id: 'shared', title: 'First' })
    await ra.syncOnce()
    await rc.syncOnce()
    expect((await c.store.get('memory', 'shared'))?.title).toBe('First')

    // Both edit offline; C's edit is later.
    clock = 2_000_000
    await a.store.upsert('memory', { id: 'shared', title: 'A says' })
    clock = 2_000_500
    await c.store.upsert('memory', { id: 'shared', title: 'C says' })

    for (let i = 0; i < 3; i++) {
      await ra.syncOnce()
      await rc.syncOnce()
    }
    for (const n of [a, b, c]) expect((await n.store.get('memory', 'shared'))?.title).toBe('C says')
  })

  it('keeps going when a peer is down, and catches up when it is back', async () => {
    const a = await node('dev_a')
    const b = await node('dev_b')
    mesh([a, b])
    const ra = link(a, [b])
    b.host.down = true
    await a.store.upsert('memory', { title: 'While B was away' })
    await ra.syncOnce()
    expect(ra.status()[0]?.ok).toBe(false)
    b.host.down = false
    await ra.syncOnce()
    expect(await titles(b.store)).toEqual(['While B was away'])
    expect(ra.status()[0]?.ok).toBe(true)
  })

  it('says when a link goes up or down, once each time, so the window can show it', async () => {
    const a = await node('dev_a')
    const b = await node('dev_b')
    mesh([a, b])
    let heard = 0
    const ra = link(a, [b], 1, () => (heard += 1))
    b.host.down = true
    await ra.syncOnce()
    expect(heard).toBe(0)
    b.host.down = false
    await ra.syncOnce()
    await ra.syncOnce()
    expect(heard).toBe(1)
    b.host.down = true
    await ra.syncOnce()
    expect(heard).toBe(2)
  })

  it('peers come from device rows: brains and hands with addresses, never revoked, never itself', async () => {
    const a = await node('dev_a')
    const base = { kind: 'desktop', platform: 'linux', priority: 0, fp: 'fp', facts: {}, pairedAt: 0, lastSeen: 0, revoked: false }
    await a.store.upsert('device', { ...base, id: 'dev_a', name: 'Self', roles: ['brain'], urls: ['https://127.0.0.1:1'] })
    await a.store.upsert('device', { ...base, id: 'dev_b', name: 'Brain', roles: ['brain'], urls: ['https://127.0.0.1:2'], priority: 2 })
    await a.store.upsert('device', { ...base, id: 'dev_h', name: 'Hands', roles: ['hands'], urls: ['https://127.0.0.1:3'], priority: 1 })
    await a.store.upsert('device', { ...base, id: 'dev_p', name: 'Phone', roles: ['screen'], urls: [] })
    await a.store.upsert('device', { ...base, id: 'dev_r', name: 'Gone', roles: ['brain'], urls: ['https://127.0.0.1:4'], revoked: true })
    const peers = await peersFromRows(a.store, 'dev_a')
    expect(peers.map((p) => p.id)).toEqual(['dev_h', 'dev_b'])
  })

  it('the change log starts with every row an older database already had', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { DatabaseSync } = await import('node:sqlite')
    const dir = mkdtempSync(join(tmpdir(), 'agent-log-'))
    const file = join(dir, 'agent.db')
    const first = new Store(file)
    await first.upsert('memory', { title: 'Old row' })
    first.close()
    // As if it was written by a build before the change log existed.
    const raw = new DatabaseSync(file)
    raw.exec('DROP TABLE change_log')
    raw.close()
    const again = new Store(file)
    expect(again.changesAfter(0).changes.map((c) => c.payload['title'])).toEqual(['Old row'])
    again.close()
    rmSync(dir, { recursive: true, force: true })
  })
  it('pushes a local change beside an open long poll instead of cutting it (one connection stays up)', async () => {
    const a = await node('dev_a')
    const b = await node('dev_b')
    mesh([a, b])
    const replicator = link(a, [b], 20)
    replicator.start()
    await a.store.upsert('memory', { title: 'First' })
    await waitFor(async () => (await titles(b.store)).includes('First'), 8000)
    // Let the link settle into its long poll on B.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const pulls = b.host.hits.get('/v1/sync/pull') ?? 0
    const pushes = b.host.hits.get('/v1/sync/push') ?? 0
    for (const title of ['Second', 'Third', 'Fourth']) {
      await a.store.upsert('memory', { title })
      await waitFor(async () => (await titles(b.store)).includes(title), 8000)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Every change went over promptly as a push; the poll on B was never cut short and restarted.
    expect(b.host.hits.get('/v1/sync/push') ?? 0).toBeGreaterThan(pushes)
    expect(b.host.hits.get('/v1/sync/pull') ?? 0).toBe(pulls)
    // And B's changes still come back over that same poll.
    await b.store.upsert('memory', { title: 'From B' })
    await waitFor(async () => (await titles(a.store)).includes('From B'), 8000)
  })

  it('a node upgraded from a version that dropped newer entities reads just those once from its peer', async () => {
    const a = await node('dev_a')
    const b = await node('dev_b')
    mesh([a, b])
    await a.store.upsert('memory', { title: 'Known to every version' })
    const wake = await a.store.upsert('wakeup', { title: 'Standup', severity: 'urgent' } as never)
    // B ran an older version: it pulled A's whole log but dropped the wake-up (unknown to it), and kept no record of
    // which entities it knew.
    b.store.setLocalValue('peer_pull:dev_a', String(a.store.logSeq()))
    expect(await b.store.list('wakeup')).toHaveLength(0)

    moved.pulled = 0
    link(b, [a]).start()
    await waitFor(async () => (await b.store.list('wakeup')).some((row) => row.id === (wake as { id: string }).id), 8000)
    // Only the entities it did not know came again: the memory row it already counted as pulled did not.
    expect(await titles(b.store)).toEqual([])
    expect(moved.pulled).toBe(1)
    expect(b.store.localValue('peer_known:dev_a')).toContain('wakeup')

    // Once only: a restart does not read them again.
    b.replicator?.stop()
    moved.pulled = 0
    link(b, [a]).start()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(moved.pulled).toBe(0)
  })

  it('a fresh link records what it knows and reads nothing twice', async () => {
    const a = await node('dev_a')
    const b = await node('dev_b')
    mesh([a, b])
    await a.store.upsert('wakeup', { title: 'Lunch' } as never)
    moved.pulled = 0
    link(b, [a]).start()
    await waitFor(async () => (await b.store.list('wakeup')).length === 1, 8000)
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(moved.pulled).toBe(1)
    expect(b.store.localValue('peer_known:dev_a')).toContain('miniapp')
  })
})
