/**
 * The window is told what changed, row by row, instead of reading every row again on every write; a turn reads
 * only its own thread; listed rows leave a run's long output behind until the step is opened.
 */
import { describe, expect, it } from 'vitest'

import type { ChatItem, DataChange } from '@agent/core'

import { Store, type StoreChange } from '../src/main/db'
import { listWhere } from '../src/main/runtime/data'
import { lightRow } from '../src/shared/light-row'
import { runFromMeta } from '../src/shared/run-record'
import { patched, placeOf } from '../src/renderer/lib/patch'

function watch(store: Store): StoreChange[] {
  const seen: StoreChange[] = []
  store.onChange((change) => seen.push(change))
  return seen
}

describe('what the window hears', () => {
  it('a write carries its row, a delete its id, and a flood becomes one reset', async () => {
    let clock = 1_000
    const store = new Store(':memory:', () => (clock += 1))
    const seen = watch(store)
    const row = await store.upsert('chat_item', { kind: 'user', text: 'hi', meta: '{}' })
    expect(seen[0]).toMatchObject({ entity: 'chat_item', row: { id: row.id, text: 'hi' } })
    await store.remove('chat_item', row.id)
    expect(seen[1]).toEqual({ entity: 'chat_item', id: row.id, deleted: true })

    seen.length = 0
    await store.batch(async () => {
      for (let i = 0; i < 3; i++) await store.upsert('memory', { title: `m${i}`, body: '', kind: 'fact', topics: '', pinned: false, source: 'user' })
    })
    expect(seen).toHaveLength(3)
    expect(seen.every((change) => change.row !== undefined)).toBe(true)

    seen.length = 0
    await store.batch(async () => {
      for (let i = 0; i < 60; i++) await store.upsert('task', { title: `t${i}` })
    })
    // One reset, carrying the 60 rows so a list in memory applies them instead of reading the table again.
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ entity: 'task', reset: true })
    expect(seen[0]?.batch).toHaveLength(60)
    store.close()
  })

  it('a listed chat row keeps only the head of a long run output; the full row still has it all', () => {
    const run = { kind: 'shell', input: 'ls', label: 'Shell', stdout: 'x'.repeat(5_000), stderr: '', exitCode: 0, ms: 5, state: 'ok' }
    const row: ChatItem = { id: 'a', createdAt: 1, kind: 'activity', text: 'Ran ls', meta: JSON.stringify({ tool: 'shell', run }) }
    const light = lightRow('chat_item', row)
    expect(light.meta.length).toBeLessThan(600)
    const record = runFromMeta(JSON.parse(light.meta) as Record<string, unknown>)
    expect(record).toMatchObject({ kind: 'shell', more: true })
    expect(record?.stdout).toHaveLength(240)
    expect(runFromMeta(JSON.parse(row.meta) as Record<string, unknown>)?.more).toBeUndefined()
    // Short output and rows without a run go through untouched (the same object).
    const short: ChatItem = { ...row, meta: JSON.stringify({ tool: 'shell', run: { ...run, stdout: 'ok' } }) }
    expect(lightRow('chat_item', short)).toBe(short)
    expect(lightRow('memory', row)).toBe(row)
  })
})

describe('patching the list in the window', () => {
  const rows = [
    { id: 'a', createdAt: 10 },
    { id: 'b', createdAt: 20 },
    { id: 'c', createdAt: 30 },
  ]
  it('puts a new row in createdAt order, replaces a changed row in place, drops a deleted one', () => {
    expect(placeOf(rows, 25)).toBe(2)
    expect(placeOf(rows, 5)).toBe(0)
    expect(placeOf(rows, 30)).toBe(3)
    expect(patched(rows, { row: { id: 'd', createdAt: 25 } }).map((r) => r.id)).toEqual(['a', 'b', 'd', 'c'])
    const replaced = patched(rows, { row: { id: 'b', createdAt: 20, text: 'new' } as never })
    expect(replaced.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(replaced[1]).toMatchObject({ text: 'new' })
    expect(replaced[0]).toBe(rows[0])
    expect(patched(rows, { id: 'b', deleted: true }).map((r) => r.id)).toEqual(['a', 'c'])
    expect(patched(rows, { row: { id: 'a', createdAt: 40 } }).map((r) => r.id)).toEqual(['b', 'c', 'a'])
    const change: DataChange = { entity: 'chat_item' }
    expect(patched(rows, change)).toEqual(rows)
  })
})

describe('reading only the rows a turn needs', () => {
  it('listWhere matches thread, kind, chat (untagged rows are the first chat), since and limit, like the full list filtered', async () => {
    let clock = 1_000
    const store = new Store(':memory:', () => (clock += 10))
    await store.upsert('turn', { thread: 'main', json: '{"a":1}' })
    await store.upsert('turn', { thread: 'chat:x', json: '{"b":1}' })
    const t3 = await store.upsert('turn', { thread: 'main', json: '{"c":1}' })
    await store.upsert('chat_item', { kind: 'user', text: 'first', meta: '{}' })
    await store.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify({ divider: true }) })
    await store.upsert('chat_item', { kind: 'user', text: 'in x', meta: JSON.stringify({ chat: 'x' }) })
    await store.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify({ divider: true, chat: 'x' }) })
    await store.upsert('chat_item', { kind: 'user', text: 'broken meta', meta: '{not json' })

    expect((await store.listWhere('turn', { thread: 'main' })).map((r) => r.json)).toEqual(['{"a":1}', '{"c":1}'])
    expect((await store.listWhere('turn', { thread: 'main', since: t3.createdAt - 1 })).map((r) => r.json)).toEqual(['{"c":1}'])
    expect((await store.listWhere('chat_item', { kind: 'notice', chat: 'main' })).map((r) => r.text)).toEqual(['New chat'])
    expect((await store.listWhere('chat_item', { chat: 'main' })).map((r) => r.text)).toEqual(['first', 'New chat', 'broken meta'])
    expect((await store.listWhere('chat_item', { chat: 'x' })).map((r) => r.text)).toEqual(['in x', 'New chat'])
    expect((await store.listWhere('chat_item', { kind: 'user', limit: 1, newestFirst: true })).map((r) => r.text)).toEqual(['broken meta'])
    // The fallback for a store without the query gives the same answer.
    const plain = { list: store.list.bind(store), get: store.get.bind(store), upsert: store.upsert.bind(store), remove: store.remove.bind(store) }
    expect((await listWhere(plain, 'chat_item', { chat: 'x' })).map((r) => r.text)).toEqual(['in x', 'New chat'])
    expect((await listWhere(plain, 'chat_item', { kind: 'user', limit: 1, newestFirst: true })).map((r) => r.text)).toEqual(['broken meta'])
    store.close()
  })
})
