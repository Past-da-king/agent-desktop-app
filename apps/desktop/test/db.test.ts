import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SyncClient, SyncEngine, encodeStamp, type Change } from '../../../packages/core/src/index'
import { startFakeSyncServer } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'

const dirs: string[] = []
const stores: Store[] = []
let closeServer: (() => Promise<void>) | null = null

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-db-'))
  dirs.push(dir)
  return dir
}

function openStore(clock?: () => number): Store {
  const store = new Store(join(tempDir(), 'agent.db'), clock)
  stores.push(store)
  return store
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await closeServer?.()
  closeServer = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Store', () => {
  it('creates a complete row and keeps the ipc.ts field names on a round trip', async () => {
    const store = openStore()
    const saved = await store.upsert('memory', {
      title: 'The blue folder',
      body: 'It lives in the top drawer.',
      kind: 'fact',
      topics: 'home,admin',
      pinned: true,
      source: 'agent',
    })

    expect(typeof saved.id).toBe('string')
    expect(saved.id.length).toBeGreaterThan(10)
    expect(saved.createdAt).toBeGreaterThan(0)
    expect(saved.updatedAt).toBeGreaterThan(0)

    const [listed] = await store.list('memory')
    expect(listed).toBeDefined()
    expect(Object.keys(listed!).sort()).toEqual([
      'body',
      'createdAt',
      'id',
      'kind',
      'pinned',
      'source',
      'title',
      'topics',
      'updatedAt',
    ])
    expect(listed).toEqual(saved)
    expect(await store.get('memory', saved.id)).toEqual(saved)
  })

  it('fills the defaults a partial row needs', async () => {
    const store = openStore()
    const task = await store.upsert('task', { title: 'Call the bank' })

    expect(task.status).toBe('todo')
    expect(task.owner).toBe('user')
    expect(task.goalId).toBeNull()
    expect(task.notes).toBe('')
    expect(task.dueAt).toBeNull()
    expect(task.updatedAt).toBeGreaterThan(0)
  })

  it('orders by createdAt and then by stamp', async () => {
    const store = openStore()
    const late = await store.upsert('goal', { title: 'late', createdAt: 2_000 })
    const early = await store.upsert('goal', { title: 'early', createdAt: 1_000 })
    const tieOne = await store.upsert('goal', { title: 'tie one', createdAt: 3_000 })
    const tieTwo = await store.upsert('goal', { title: 'tie two', createdAt: 3_000 })

    const titles = (await store.list('goal')).map((goal) => goal.title)
    expect(titles).toEqual([early.title, late.title, tieOne.title, tieTwo.title])
  })

  it('updates in place, keeps createdAt, and moves updatedAt forward', async () => {
    let tick = 1_000
    const store = openStore(() => tick++)
    const first = await store.upsert('memory', { title: 'Old', body: 'keep me', kind: 'fact' })
    const second = await store.upsert('memory', { id: first.id, title: 'New' })

    expect(second.id).toBe(first.id)
    expect(second.title).toBe('New')
    expect(second.body).toBe('keep me')
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect(await store.list('memory')).toHaveLength(1)
  })

  it('tombstones a removed row but keeps the change for sync', async () => {
    const store = openStore()
    const saved = await store.upsert('chat_item', { kind: 'user', text: 'hello' })

    await store.remove('chat_item', saved.id)

    expect(await store.list('chat_item')).toHaveLength(0)
    expect(await store.get('chat_item', saved.id)).toBeNull()
    const changes = await store.localChanges(null)
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ entity: 'chat_item', id: saved.id, deleted: true })
    expect(changes[0]!.payload['text']).toBe('hello')
  })

  it('applies remote rows with last-writer-wins and skips its own echo', async () => {
    const store = openStore()
    const local = await store.upsert('goal', { title: 'local' })
    const changes = await store.localChanges(null)
    const ownStamp = changes[0]!.stamp

    // Our own echo changes nothing.
    await store.applyRemote([{ ...changes[0]!, payload: { title: 'echo' } }])
    expect((await store.get('goal', local.id))?.title).toBe('local')

    const older: Change = {
      entity: 'goal',
      id: local.id,
      deleted: false,
      stamp: encodeStamp({ millis: 1, counter: 0, device: 'another-device' }),
      payload: { title: 'older', why: '', status: 'open', createdAt: 1 },
    }
    await store.applyRemote([older])
    expect((await store.get('goal', local.id))?.title).toBe('local')

    const newer: Change = {
      ...older,
      stamp: encodeStamp({ millis: 9_000_000_000_000, counter: 0, device: 'another-device' }),
      payload: { title: 'newer', why: '', status: 'open', createdAt: 1 },
    }
    await store.applyRemote([newer])
    expect((await store.get('goal', local.id))?.title).toBe('newer')
    expect(ownStamp).not.toBe(newer.stamp)
  })

  it('keeps the same device id when the database is reopened', async () => {
    const file = join(tempDir(), 'agent.db')
    const first = new Store(file)
    const id = first.deviceId
    first.close()

    const second = new Store(file)
    stores.push(second)
    expect(second.deviceId).toBe(id)
  })

  it('converges two stores through the sync engine and the fake server', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const auth = await SyncClient.register(server.url, 'one@example.com', 'secret1')

    const left = openStore()
    const right = openStore()
    const leftEngine = new SyncEngine(left, () => new SyncClient(server.url, auth.token))
    const rightEngine = new SyncEngine(right, () => new SyncClient(server.url, auth.token))

    await left.upsert('memory', { title: 'From the left', kind: 'fact' })
    expect(await leftEngine.syncOnce()).toBe(true)
    expect(await rightEngine.syncOnce()).toBe(true)
    expect((await right.list('memory')).map((row) => row.title)).toEqual(['From the left'])

    await right.upsert('memory', { title: 'From the right', kind: 'fact' })
    expect(await rightEngine.syncOnce()).toBe(true)
    expect(await leftEngine.syncOnce()).toBe(true)

    const leftTitles = (await left.list('memory')).map((row) => row.title).sort()
    const rightTitles = (await right.list('memory')).map((row) => row.title).sort()
    expect(leftTitles).toEqual(['From the left', 'From the right'])
    expect(rightTitles).toEqual(leftTitles)
  })
})
