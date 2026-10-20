import { afterEach, describe, expect, it } from 'vitest'

import type { SyncStatus } from '../src/ipc'
import { SyncClient } from '../src/sync/client'
import { SyncEngine } from '../src/sync/engine'
import { MemorySyncStore } from '../src/sync/memory-store'
import { portOf, sleep, startFakeSyncServer, waitFor, type FakeSyncServer } from './helpers'

const servers: FakeSyncServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function server(options: { port?: number } = {}): Promise<FakeSyncServer> {
  const started = await startFakeSyncServer(options)
  servers.push(started)
  return started
}

async function account(url: string, email = `user-${Math.random().toString(36).slice(2)}@example.com`) {
  return SyncClient.register(url, email, 'secret1')
}

interface Device {
  store: MemorySyncStore
  engine: SyncEngine
}

function device(url: string, token: string, deviceId: string): Device {
  const store = new MemorySyncStore(deviceId)
  const engine = new SyncEngine(store, () => new SyncClient(url, token))
  return { store, engine }
}

describe('SyncEngine', () => {
  it('pushes a row on A and B pulls it', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const a = device(fake.url, token, 'device-a')
    const b = device(fake.url, token, 'device-b')

    await a.store.put('memory', 'm1', { title: 'Remember this' })
    expect(await a.engine.syncOnce()).toBe(true)
    expect(await b.engine.syncOnce()).toBe(true)

    expect(b.store.get('memory', 'm1')).toEqual({ title: 'Remember this' })
    expect(b.engine.status().pendingPush).toBe(0)
    expect(b.engine.status().lastSyncedAt).not.toBeNull()
  })

  it('lets the later HLC stamp win on both devices', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const a = device(fake.url, token, 'device-a')
    const b = device(fake.url, token, 'device-b')

    await a.store.put('memory', 'm1', { title: 'original' })
    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(b.store.get('memory', 'm1')).toEqual({ title: 'original' })

    await b.store.put('memory', 'm1', { title: 'from-b' })
    await sleep(5)
    await a.store.put('memory', 'm1', { title: 'from-a' })

    await a.engine.syncOnce()
    await b.engine.syncOnce()
    expect(b.store.get('memory', 'm1')).toEqual({ title: 'from-a' })

    await a.engine.syncOnce()
    expect(a.store.get('memory', 'm1')).toEqual({ title: 'from-a' })
  })

  it('does not let a stale edit resurrect a deleted row', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const a = device(fake.url, token, 'device-a')
    const b = device(fake.url, token, 'device-b')

    await a.store.put('memory', 'm1', { title: 'original' })
    await a.engine.syncOnce()
    await b.engine.syncOnce()

    await b.store.put('memory', 'm1', { title: 'stale edit' })
    await sleep(5)
    await a.store.remove('memory', 'm1')
    await a.engine.syncOnce()

    await b.engine.syncOnce()
    expect(b.store.get('memory', 'm1')).toBeUndefined()

    await a.engine.syncOnce()
    expect(a.store.get('memory', 'm1')).toBeUndefined()
  })

  it('accumulates pushes while offline and sends them when the server returns', async () => {
    const fake = await server()
    const registration = await account(fake.url, 'offline@example.com')
    const port = portOf(fake.url)

    let url = fake.url
    let token = registration.token
    const store = new MemorySyncStore('device-a')
    const engine = new SyncEngine(store, () => new SyncClient(url, token))

    await fake.close()
    servers.splice(servers.indexOf(fake), 1)

    await store.put('memory', 'm1', { title: 'written offline' })
    expect(await engine.syncOnce()).toBe(false)
    expect(engine.status().pendingPush).toBe(1)
    expect(engine.status().error).toBeTruthy()

    const restored = await server({ port })
    const again = await SyncClient.register(restored.url, 'offline@example.com', 'secret1')
    url = restored.url
    token = again.token

    expect(await engine.syncOnce()).toBe(true)
    expect(engine.status().pendingPush).toBe(0)

    const reader = device(restored.url, token, 'device-b')
    await reader.engine.syncOnce()
    expect(reader.store.get('memory', 'm1')).toEqual({ title: 'written offline' })
  })

  it('skips its own echo when applying remote changes', async () => {
    const store = new MemorySyncStore('device-a', () => 1_000)
    await store.applyRemote([
      {
        entity: 'memory',
        id: 'own',
        deleted: false,
        stamp: '5000-5-device-a',
        payload: { title: 'mine' },
      },
    ])

    expect(store.get('memory', 'own')).toBeUndefined()
    const change = await store.put('memory', 'next', { title: 'local' })
    expect(change.stamp).toBe('1000-0-device-a')
  })

  it('keeps its cursor across engine restarts', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const a = device(fake.url, token, 'device-a')
    const store = new MemorySyncStore('device-b')
    const first = new SyncEngine(store, () => new SyncClient(fake.url, token))

    await a.store.put('memory', 'm1', { title: 'one' })
    await a.engine.syncOnce()
    await first.syncOnce()
    expect(await store.cursor()).toBe(1)
    expect(store.get('memory', 'm1')).toEqual({ title: 'one' })

    const applied: string[] = []
    const second = new SyncEngine(store, () => new SyncClient(fake.url, token), {
      onApplied: (changes) => {
        for (const change of changes) applied.push(change.id)
      },
    })
    await a.store.put('memory', 'm2', { title: 'two' })
    await a.engine.syncOnce()
    await second.syncOnce()

    expect(await store.cursor()).toBe(2)
    expect(store.get('memory', 'm2')).toEqual({ title: 'two' })
    expect(applied).toEqual(['m2'])
  })

  it('serialises passes so two syncs push a local row once', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const a = device(fake.url, token, 'device-a')
    await a.store.put('memory', 'm1', { title: 'once' })

    const results = await Promise.all([a.engine.syncOnce(), a.engine.syncOnce()])
    expect(results).toEqual([true, true])
    expect(fake.stats.pushes).toBe(1)
  })

  it('emits status while it works', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const { store, engine } = device(fake.url, token, 'device-a')
    const seen: SyncStatus[] = []
    engine.onStatus((status) => seen.push(status))

    await store.put('memory', 'm1', { title: 'status' })
    await engine.syncOnce()

    expect(seen.some((status) => status.syncing)).toBe(true)
    expect(seen.some((status) => status.pendingPush === 1)).toBe(true)
    expect(engine.status()).toMatchObject({ syncing: false, error: null, pendingPush: 0 })
  })

  it('applies another device push through the long-poll loop within 1.5 s', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const a = device(fake.url, token, 'device-a')
    const b = device(fake.url, token, 'device-b')

    b.engine.start()
    try {
      await sleep(200)
      await a.store.put('memory', 'm1', { title: 'live' })
      await a.engine.syncOnce()
      await waitFor(() => b.store.get('memory', 'm1'), 1_500)
    } finally {
      b.engine.stop()
    }
    expect(b.store.get('memory', 'm1')).toEqual({ title: 'live' })
  })

  it('pushes soon after nudge instead of waiting for the poll to expire', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const a = device(fake.url, token, 'device-a')
    const reader = new SyncClient(fake.url, token)

    a.engine.start()
    try {
      await sleep(200)
      await a.store.put('memory', 'm1', { title: 'nudged' })
      a.engine.nudge()
      await waitFor(async () => (await reader.pull(0)).changes.length > 0, 2_500)
    } finally {
      a.engine.stop()
    }
    const pulled = await reader.pull(0)
    expect(pulled.changes[0]?.id).toBe('m1')
  })
})
