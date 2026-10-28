/**
 * The app froze ("Agent is not responding", 28 Oct 2026): every filtered list (a chat, a kind, a thread) scanned all
 * chat rows, because SQLite picked the created-at index for the ORDER BY over the filter's own index. On his 63,000
 * chat rows (240 MB) that was 0.4 to 1.8 s per query on the main thread, and the project-agent check ran one per
 * followed project chat every 2 s. These tests hold every list shape to an index range, the results to the plain
 * filter, whole lists to yielding between slices, and the project-agent check to reading only chats that changed.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_CHAT, type ChatItem, type ListWhere, type RunState } from '@agent/core'

import { Store } from '../src/main/db'
import { listWhere as plainListWhere, type DataStore } from '../src/main/runtime/data'
import { ProjectAgentRows, rowIdFor } from '../src/main/runtime/project-agents'

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function open(): Store {
  const store = new Store(':memory:')
  stores.push(store)
  return store
}

const SHAPES: Array<[entity: 'chat_item' | 'turn' | 'job', where: ListWhere]> = [
  ['chat_item', { chat: 'pc1' }],
  ['chat_item', { chat: 'pc1', kinds: ['helper', 'agent', 'notice'] }],
  ['chat_item', { chat: MAIN_CHAT }],
  ['chat_item', { chat: MAIN_CHAT, kind: 'helper' }],
  ['chat_item', { chat: MAIN_CHAT, kinds: ['user', 'agent'], newestFirst: true, limit: 5 }],
  ['chat_item', { chat: 'pc1', kind: 'user', newestFirst: true, limit: 1 }],
  ['chat_item', { kind: 'helper' }],
  ['chat_item', { kinds: ['question', 'approval'] }],
  ['chat_item', { kind: 'activity', since: 1_000 }],
  ['chat_item', { kind: 'user', newestFirst: true, limit: 1 }],
  ['chat_item', { chat: 'pc1', exceptKinds: ['activity'] }],
  ['chat_item', { exceptKinds: ['activity'] }],
  ['turn', { thread: 'main' }],
  ['turn', { thread: 'main', since: 1_000 }],
  ['job', { kind: 'x' }],
]

async function seed(store: Store): Promise<void> {
  const kinds = ['activity', 'activity', 'activity', 'activity', 'user', 'agent', 'helper', 'notice', 'question', 'approval']
  const chats = [MAIN_CHAT, 'pc1', 'pc2', '']
  await store.batch(async () => {
    for (let i = 0; i < 400; i++) {
      const chat = chats[i % chats.length]!
      const meta = chat === MAIN_CHAT ? (i % 8 === 0 ? '{}' : i % 8 === 4 ? 'not json' : JSON.stringify({ state: 'done' })) : JSON.stringify({ chat, state: 'done' })
      await store.upsert('chat_item', { id: `r${i}`, kind: kinds[i % kinds.length]!, text: `row ${i}`, meta, createdAt: 500 + i * 7 } as never)
    }
    for (let i = 0; i < 60; i++) await store.upsert('turn', { id: `t${i}`, thread: i % 2 === 0 ? 'main' : 'chat:pc1', role: 'user', json: '{}', createdAt: 900 + i * 10 } as never)
  })
}

/** The same store seen without its own listWhere: the plain list filtered in JavaScript (runtime/data.ts). */
function plain(store: Store): DataStore {
  return { list: (entity) => store.list(entity) } as DataStore
}

describe('filtered lists read their own index, never every row', () => {
  it('every listWhere shape is an index search on its filter (no scan, no created-at walk for a filtered list)', () => {
    const store = open()
    for (const [entity, where] of SHAPES) {
      const plan = store.listWherePlan(entity, where).join(' | ')
      expect(plan, JSON.stringify(where)).toMatch(/^SEARCH rows USING (COVERING )?INDEX rows_(thread_at|chat_kind_at|kind_at)/)
      expect(plan, JSON.stringify(where)).not.toMatch(/\bSCAN rows\b|INDEX rows_created/)
    }
  })

  it('the indexed lists return exactly what the plain filter returns, in the same order', async () => {
    const store = open()
    await seed(store)
    for (const [entity, where] of SHAPES) {
      const fast = (await store.listWhere(entity, where)).map((row) => row.id)
      const slow = (await plainListWhere(plain(store), entity, where)).map((row) => row.id)
      expect(fast, JSON.stringify(where)).toEqual(slow)
    }
    // Untagged, empty and damaged meta all count as the main chat.
    const main = (await store.listWhere('chat_item', { chat: MAIN_CHAT })).map((row) => row.id)
    expect(main).toContain('r0')
    expect(main).toContain('r3')
    expect(main).toContain('r4')
    expect(await store.listWhere('chat_item', { kinds: [] })).toEqual([])
    expect(await store.listWhere('chat_item', { kind: 'user', kinds: ['agent'] })).toEqual([])
  })

  it('a whole list yields between slices, so a big table never holds the event loop in one go', async () => {
    const store = open()
    await store.batch(async () => {
      for (let i = 0; i < 3500; i++) await store.upsert('chat_item', { id: `b${i}`, kind: 'activity', text: 'x', meta: '{}', createdAt: i } as never)
    })
    let ticks = 0
    const timer = setInterval(() => (ticks += 1), 0)
    const immediate = (): void => {
      ticks += 1
    }
    let spins = 0
    const spin = (): void => {
      if (spins++ < 1000) setImmediate(() => (immediate(), spin()))
    }
    spin()
    const rows = await store.list('chat_item')
    clearInterval(timer)
    expect(rows).toHaveLength(3500)
    expect(rows[0]?.id).toBe('b0')
    // Other work ran while the list was read (a single synchronous read lets nothing in).
    expect(ticks).toBeGreaterThan(0)
  })
})

describe('the project-agent check reads a followed chat only when it changed', () => {
  it('a project chat left with a working helper is not re-read every tick', async () => {
    const store = open()
    const project = await store.upsert('project', { name: 'P', description: '', path: '', profile: '', hidden: false, chats: ['pc1'] } as never)
    // A helper in the project chat still marked working (its run was cut off): the row stays open.
    await store.upsert('chat_item', { id: 'h1', kind: 'helper', text: 'job', meta: JSON.stringify({ chat: 'pc1', state: 'working' }) })
    for (let i = 0; i < 50; i++) await store.upsert('chat_item', { id: `a${i}`, kind: 'activity', text: 'step', meta: JSON.stringify({ chat: 'pc1', helper: 'h1' }) })
    let reads = 0
    const counted = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'listWhere') return (entity: never, where: ListWhere) => (where.chat === 'pc1' && (reads += 1), target.listWhere(entity, where))
        const value = Reflect.get(target, key, receiver) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as unknown as Store
    let now = 1_000_000
    const agents = new ProjectAgentRows({ store: counted, state: (): RunState => ({ running: false, waiting: [] }), checkMs: 20, now: () => now })
    try {
      await agents.delegated('pc1', project as never, 'Do the thing')
      await new Promise((resolve) => setTimeout(resolve, 300))
      // First tick reads it once; the next ~14 ticks find nothing changed and read nothing.
      expect(reads).toBe(1)
      // It changes: read again on the next tick, and closes once the helper is done.
      await store.upsert('chat_item', { id: 'h1', kind: 'helper', text: 'job', meta: JSON.stringify({ chat: 'pc1', state: 'done' }) })
      await store.upsert('chat_item', { id: 'z1', kind: 'agent', text: 'All done.', meta: JSON.stringify({ chat: 'pc1' }) })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(reads).toBe(2)
      const row = (await store.get('chat_item', rowIdFor('pc1'))) as ChatItem
      expect(JSON.parse(row.meta)['state']).toBe('done')
    } finally {
      agents.dispose()
    }
  })

  it('a quiet followed chat is still read again after a minute', async () => {
    const store = open()
    const project = await store.upsert('project', { name: 'P', description: '', path: '', profile: '', hidden: false, chats: ['pc1'] } as never)
    await store.upsert('chat_item', { id: 'h1', kind: 'helper', text: 'job', meta: JSON.stringify({ chat: 'pc1', state: 'working' }) })
    let reads = 0
    const counted = new Proxy(store, {
      get(target, key, receiver) {
        if (key === 'listWhere') return (entity: never, where: ListWhere) => (where.chat === 'pc1' && (reads += 1), target.listWhere(entity, where))
        const value = Reflect.get(target, key, receiver) as unknown
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
      },
    }) as unknown as Store
    let now = 1_000_000
    const agents = new ProjectAgentRows({ store: counted, state: (): RunState => ({ running: false, waiting: [] }), checkMs: 20, now: () => now })
    try {
      await agents.delegated('pc1', project as never, 'Do the thing')
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(reads).toBe(1)
      now += 61_000
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(reads).toBe(2)
    } finally {
      agents.dispose()
    }
  })
})
