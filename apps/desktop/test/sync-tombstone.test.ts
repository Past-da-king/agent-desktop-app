/**
 * A delete is not undone by a stale device (review 14 Nov 2026, same class as R2): two real replicas, each with its own
 * SQLite store. A tombstone beats any remote write that does not carry the explicit restore flag, whatever its stamp.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

const pause = (ms = 8): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function replica(): Store {
  const store = new Store(':memory:')
  stores.push(store)
  return store
}

async function push(from: Store, to: Store, fromId: string): Promise<void> {
  await to.applyRemote(await from.localChanges(null), fromId)
}

async function pair(): Promise<{ a: Store; b: Store; id: string }> {
  const a = replica()
  const b = replica()
  const row = await a.upsert('trigger', { name: 'Brief', kind: 'interval', spec: '15', prompt: 'p', enabled: true, lastRunAt: null, lastResult: '' })
  await push(a, b, 'dev_a')
  expect((await b.get('trigger', row.id))?.name).toBe('Brief')
  return { a, b, id: row.id }
}

describe('sync: a tombstone beats a stale write', () => {
  it('a stale device edits a row another device deleted: the delete wins on both, whatever the stamps', async () => {
    const { a, b, id } = await pair()
    await pause()
    await a.remove('trigger', id)
    await pause()
    // B never heard of the delete and edits the row: its stamp is newer than the tombstone.
    await b.upsert('trigger', { id, lastResult: 'stale edit' })
    await push(b, a, 'dev_b')
    expect(await a.get('trigger', id)).toBeNull()
    expect(a.deletedIds('trigger').has(id)).toBe(true)
    // The tombstone reaches B and takes the row, newer local edit or not.
    await push(a, b, 'dev_a')
    expect(await b.get('trigger', id)).toBeNull()
    expect(b.deletedIds('trigger').has(id)).toBe(true)
  })

  it('a change from an old peer (no restore flag) never resurrects a deleted row', async () => {
    const { a, b, id } = await pair()
    await a.remove('trigger', id)
    await pause()
    const stale = await b.upsert('trigger', { id, lastResult: 'late' })
    const changes = (await b.localChanges(null)).filter((change) => change.id === id).map((change) => ({ ...change, stamp: change.stamp }))
    for (const change of changes) delete (change as { restore?: boolean }).restore
    await a.applyRemote(changes, 'dev_b')
    expect(stale.lastResult).toBe('late')
    expect(await a.get('trigger', id)).toBeNull()
  })

  it('an explicit restore carries the flag and brings the row back on the other replica', async () => {
    const { a, b, id } = await pair()
    await a.remove('trigger', id)
    await push(a, b, 'dev_a')
    expect(await b.get('trigger', id)).toBeNull()
    await pause()
    await b.upsert('trigger', { id, name: 'Back', kind: 'interval', spec: '30', prompt: 'p', enabled: true, lastRunAt: null, lastResult: '' }, { restore: true })
    const sent = (await b.localChanges(null)).find((change) => change.id === id)
    expect(sent?.restore).toBe(true)
    await push(b, a, 'dev_b')
    expect((await a.get('trigger', id))?.name).toBe('Back')
  })

  it('after a restore, ordinary edits keep winning by stamp, and the old tombstone does not kill the restored row', async () => {
    const { a, b, id } = await pair()
    await a.remove('trigger', id)
    const tombstone = (await a.localChanges(null)).filter((change) => change.id === id)
    await pause()
    await a.upsert('trigger', { id, name: 'Back', kind: 'interval', spec: '30', prompt: 'p', enabled: true, lastRunAt: null, lastResult: '' }, { restore: true })
    await pause()
    await a.upsert('trigger', { id, lastResult: 'edited after restore' })
    // A late copy of the old tombstone arrives.
    await a.applyRemote(tombstone, 'dev_b')
    expect((await a.get('trigger', id))?.lastResult).toBe('edited after restore')
    await push(a, b, 'dev_a')
    expect((await b.get('trigger', id))?.lastResult).toBe('edited after restore')
  })

  it('an ordinary edit of a live row still wins by stamp (last write wins is kept for live rows)', async () => {
    const { a, b, id } = await pair()
    await pause()
    await b.upsert('trigger', { id, lastResult: 'from b' })
    await push(b, a, 'dev_b')
    expect((await a.get('trigger', id))?.lastResult).toBe('from b')
  })
})
