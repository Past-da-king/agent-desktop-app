/**
 * 26 Nov 2026: the desktop window's first chat list (App.tsx load('chat_item') -> data.list) read the whole chat
 * table, 566 MB, in 11 s, and parsed it on the main thread only for lightRow to throw away nine tenths of it (run
 * outputs). The read workers now cut the outputs before the rows come back. Same rows, same order, same content.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { lightRow } from '../src/shared/light-row'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const done of cleanups.splice(0).reverse()) done()
})

function store(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'light-list-'))
  const db = new Store(join(dir, 'agent.db'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => db.close())
  return db
}

const big = (n: number, ch = 'x'): string => ch.repeat(n)

async function seed(db: Store): Promise<void> {
  const metas = [
    JSON.stringify({ chat: 'main', run: { tool: 'shell_run', status: 'done', stdout: big(24_000), stderr: big(3_000, 'e'), input: big(5_000, 'i') } }),
    JSON.stringify({ run: { tool: 'files_read', stdout: 'short', input: '{}' }, chat: 'p1' }),
    JSON.stringify({ run: { stdout: big(300) }, more: false }),
    JSON.stringify({ run: { stdout: big(10_000), more: true, extra: { a: 1 } }, helper: 'h_1' }),
    JSON.stringify({ run: 'not an object', note: big(5_000) }),
    JSON.stringify({ chat: 'main', note: 'mentions "run" in text', body: big(4_000) }),
    '{"broken json',
    '',
  ]
  for (let i = 0; i < 160; i += 1) {
    const meta = metas[i % metas.length] ?? ''
    await db.upsert('chat_item', { kind: i % 3 === 0 ? 'agent' : 'activity', text: i % 5 === 0 ? big(6_000, 't') + ' "run" ' : `step ${i}`, meta })
  }
  // A deleted row stays out of both lists.
  const gone = await db.upsert('chat_item', { kind: 'activity', text: 'gone', meta: metas[0] ?? '' })
  await db.remove('chat_item', gone.id)
}

it('listLight gives exactly what lightRow over list() gives, with the outputs cut in the worker', async () => {
  const db = store()
  await seed(db)
  const before = (await db.list('chat_item')).map((row) => lightRow('chat_item', row))
  db.startReader()
  const after = await db.listLight('chat_item')
  // The window still applies lightRow (ipc.ts): it must find nothing left to change.
  expect(after.map((row) => lightRow('chat_item', row))).toEqual(after)
  expect(after).toEqual(before)
  expect(after.length).toBe(160)
  // And far fewer bytes crossed to the main thread than the stored rows hold.
  const stored = (await db.list('chat_item')).reduce((sum, row) => sum + row.meta.length + row.text.length, 0)
  const light = after.reduce((sum, row) => sum + row.meta.length + row.text.length, 0)
  expect(light).toBeLessThan(stored * 0.6)
})

it('without the read workers listLight is list() (lightRow still runs in the caller)', async () => {
  const db = store()
  await seed(db)
  expect(await db.listLight('chat_item')).toEqual(await db.list('chat_item'))
  expect(await db.listLight('task')).toEqual(await db.list('task'))
})

it('the probe reads once through the same read queue and resolves', async () => {
  const db = store()
  await db.probe()
  db.startReader()
  await db.probe()
})
