import { afterEach, describe, expect, it } from 'vitest'

import type { Change } from '../src/sync/change'
import { SyncClient, SyncException } from '../src/sync/client'
import { sleep, startFakeSyncServer, type FakeSyncServer } from './helpers'

const servers: FakeSyncServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function server(options: { port?: number } = {}): Promise<FakeSyncServer> {
  const started = await startFakeSyncServer(options)
  servers.push(started)
  return started
}

function makeChange(id: string, stamp: string, title = 'note'): Change {
  return {
    entity: 'memory',
    id,
    deleted: false,
    stamp,
    payload: { title },
  }
}

async function account(url: string): Promise<{ userId: number; token: string }> {
  return SyncClient.register(url, `person-${Math.random().toString(36).slice(2)}@example.com`, 'secret1')
}

describe('SyncClient auth', () => {
  it('registers an account and returns a token', async () => {
    const fake = await server()
    const result = await SyncClient.register(fake.url, 'first@example.com', 'secret1')
    expect(result.userId).toBeGreaterThan(0)
    expect(result.token.length).toBeGreaterThan(10)
  })

  it('rejects a duplicate email with 409', async () => {
    const fake = await server()
    await SyncClient.register(fake.url, 'taken@example.com', 'secret1')
    const error = await SyncClient.register(fake.url, 'TAKEN@example.com', 'secret1').catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SyncException)
    expect((error as SyncException).status).toBe(409)
    expect((error as SyncException).message).toMatch(/already exists/)
  })

  it('logs in and rejects a wrong password with 401', async () => {
    const fake = await server()
    await SyncClient.register(fake.url, 'login@example.com', 'secret1')

    const ok = await SyncClient.login(fake.url, 'login@example.com', 'secret1')
    expect(ok.userId).toBeGreaterThan(0)
    expect(ok.token.length).toBeGreaterThan(10)

    const error = await SyncClient.login(fake.url, 'login@example.com', 'wrong-password').catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SyncException)
    expect((error as SyncException).status).toBe(401)
    expect((error as SyncException).message).toMatch(/not correct/)
  })

  it('refuses plain http to a non-loopback host', () => {
    expect(() => new SyncClient('http://example.com', 'token')).toThrow(SyncException)
    expect(() => new SyncClient('http://example.com', 'token')).toThrow(/Allow unencrypted HTTP/)
  })

  it('allows plain http to loopback without an opt-in', () => {
    expect(() => new SyncClient('http://127.0.0.1:9', 'token')).not.toThrow()
  })
})

describe('SyncClient push and pull', () => {
  it('pushes a batch and pulls it back with a cursor', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const client = new SyncClient(fake.url, token)

    const cursor = await client.push('device-a', [
      makeChange('m1', '1000-0-device-a', 'first'),
      makeChange('m2', '1000-1-device-a', 'second'),
    ])
    expect(cursor).toBe(2)

    const pulled = await client.pull(0)
    expect(pulled.cursor).toBe(2)
    expect(pulled.changes).toHaveLength(2)
    expect(pulled.changes[0]).toMatchObject({
      entity: 'memory',
      id: 'm1',
      deleted: false,
      stamp: '1000-0-device-a',
      payload: { title: 'first' },
      seq: 1,
    })

    const empty = await client.pull(pulled.cursor)
    expect(empty.changes).toEqual([])
    expect(empty.cursor).toBe(2)
  })

  it('keeps one user isolated from another', async () => {
    const fake = await server()
    const alice = await account(fake.url)
    const bob = await account(fake.url)
    const aliceClient = new SyncClient(fake.url, alice.token)
    const bobClient = new SyncClient(fake.url, bob.token)

    await aliceClient.push('alice-device', [makeChange('secret', '1000-0-alice-device', 'private')])

    const bobPulled = await bobClient.pull(0)
    expect(bobPulled.changes).toEqual([])
    expect(bobPulled.cursor).toBe(0)

    const alicePulled = await aliceClient.pull(0)
    expect(alicePulled.changes).toHaveLength(1)
  })

  it('reports a bad token as 401 with the server message', async () => {
    const fake = await server()
    const client = new SyncClient(fake.url, 'not-a-real-token')
    const error = await client.pull(0).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SyncException)
    expect((error as SyncException).status).toBe(401)
    expect((error as SyncException).message).toBe('sign in first')
  })

  it('long-polls and returns early when another client pushes', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const writer = new SyncClient(fake.url, token)
    const reader = new SyncClient(fake.url, token)

    const waiting = reader.pull(0, { wait: 5 })
    await sleep(100)
    await writer.push('device-a', [makeChange('m1', '1000-0-device-a')])

    const pulled = await waiting
    expect(pulled.changes).toHaveLength(1)
    expect(pulled.changes[0]?.id).toBe('m1')
  })

  it('long-polls empty after its timeout', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    const client = new SyncClient(fake.url, token)

    // A monotonic clock: the system wall clock can be corrected mid-test on WSL, which once made
    // this elapsed value negative even though the long poll waited the full second.
    const started = performance.now()
    const pulled = await client.pull(0, { wait: 1 })
    const elapsed = performance.now() - started
    expect(pulled.changes).toEqual([])
    expect(elapsed).toBeGreaterThanOrEqual(900)
  })

  it('reports a network failure as status 0', async () => {
    const fake = await server()
    const { token } = await account(fake.url)
    await fake.close()
    servers.splice(servers.indexOf(fake), 1)

    const client = new SyncClient(fake.url, token)
    const error = await client.pull(0).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SyncException)
    expect((error as SyncException).status).toBe(0)
    expect((error as SyncException).message.length).toBeGreaterThan(0)
  })

  it('accepts a custom fetch implementation', async () => {
    const calls: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ userId: 1, token: 't' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    const result = await SyncClient.register('http://127.0.0.1:9999', 'a@example.com', 'secret1', fetchImpl)
    expect(result).toEqual({ userId: 1, token: 't' })
    expect(calls[0]).toBe('http://127.0.0.1:9999/v1/auth/register')
  })
})
