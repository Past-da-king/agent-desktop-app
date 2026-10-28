/**
 * 0.2.94 still burned a core (28 Oct 2026). A live trace showed the device pollers reading every device command ever
 * sent (1,353 rows, 7 MB) three times every 3 s, and the start-up, tools and calls reading the whole 63,000-row chat
 * table (240 MB) to find a few rows; a sync of more than 40 rows made the window read the whole chat table again.
 * These tests hold every one of those to an indexed, scoped read and the window to patching from a batch.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAIN_CHAT, type ChatItem, type DataChange, type EntityName } from '@agent/core'

import { Store } from '../src/main/db'
import { DeviceCommands } from '../src/main/devices/commands'
import { lightChange, listWhereArg } from '../src/main/ipc'
import { patched, patchedMany } from '../src/renderer/lib/patch'
import { filterRows } from '../src/shared/list-where'
import { shapeChange } from '../src/shared/device-feed'
import { titleOfChat } from '../src/main/runtime/chat-lines'

const heard: { listener: ((change: DataChange) => void) | null; lists: number; gate: Promise<void> } = { listener: null, lists: 0, gate: Promise.resolve() }

vi.mock('../src/renderer/bridge', () => ({
  agent: {
    data: {
      list: async () => {
        heard.lists += 1
        await heard.gate
        return [{ id: 'a', createdAt: 1, kind: 'user', text: 'hello', meta: '{}' }]
      },
      onChanged: (callback: (change: DataChange) => void) => {
        heard.listener = callback
        return () => undefined
      },
    },
  },
}))

const stores: Store[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

function open(): Store {
  const store = new Store(':memory:')
  stores.push(store)
  return store
}

/** The Store with every whole-entity list counted. */
function counted(store: Store): { store: Store; lists: Map<EntityName, number> } {
  const lists = new Map<EntityName, number>()
  const real = store.list.bind(store)
  store.list = (async (entity: EntityName) => {
    lists.set(entity, (lists.get(entity) ?? 0) + 1)
    return real(entity)
  }) as Store['list']
  return { store, lists }
}

describe('a flood of changes reaches the window as a batch', () => {
  it('a sync of many rows is a reset that carries its rows', async () => {
    const store = open()
    const heardChanges: DataChange[] = []
    store.onChange((change) => heardChanges.push(change))
    await store.batch(async () => {
      for (let i = 0; i < 100; i += 1) await store.upsert('chat_item', { id: `r${i}`, kind: 'user', text: `m${i}`, meta: '{}', createdAt: i })
      await store.upsert('chat_item', { id: 'r5', kind: 'user', text: 'edited', meta: '{}', createdAt: 5 })
    })
    const reset = heardChanges.find((change) => change.entity === 'chat_item' && change.reset === true)
    expect(reset?.batch).toBeDefined()
    expect(reset!.batch!).toHaveLength(100)
    expect((reset!.batch!.find((change) => change.row?.id === 'r5')?.row as ChatItem).text).toBe('edited')
  })

  it('the window gets the batch light, and a device gets a plain reset', () => {
    const long = { id: 'x', createdAt: 1, kind: 'activity', text: 'run', meta: JSON.stringify({ run: { stdout: 'y'.repeat(50_000) } }) }
    const change: DataChange = { entity: 'chat_item', reset: true, batch: [{ entity: 'chat_item', row: long }] }
    const light = lightChange(change)
    expect(JSON.stringify(light).length).toBeLessThan(20_000)
    expect(shapeChange(change, { v: 2 } as never)).toEqual({ entity: 'chat_item', reset: true })
  })

  it('the window applies a batch without reading the list again', async () => {
    vi.useFakeTimers()
    try {
      const { useData, DATA_BATCH_MS } = await import('../src/renderer/state/useData')
      await useData.getState().load('chat_item')
      const before = heard.lists
      const batch: DataChange[] = []
      for (let i = 0; i < 60; i += 1) batch.push({ entity: 'chat_item', row: { id: `b${i}`, createdAt: 100 + i, kind: 'agent', text: `b${i}`, meta: '{}' } })
      batch.push({ entity: 'chat_item', id: 'a', deleted: true })
      heard.listener!({ entity: 'chat_item', reset: true, batch })
      vi.advanceTimersByTime(DATA_BATCH_MS)
      expect(heard.lists).toBe(before)
      const rows = useData.getState().rows.chat_item
      expect(rows).toHaveLength(60)
      expect(rows.some((row) => row.id === 'a')).toBe(false)
      // A reset with no batch still reads the list whole.
      heard.listener!({ entity: 'chat_item', reset: true })
      vi.advanceTimersByTime(DATA_BATCH_MS)
      expect(heard.lists).toBe(before + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('changes heard while a list is read are applied to it, and it is not read again', async () => {
    vi.useFakeTimers()
    try {
      const { useData, DATA_BATCH_MS } = await import('../src/renderer/state/useData')
      let open: () => void = () => undefined
      heard.gate = new Promise<void>((resolve) => (open = resolve))
      const before = heard.lists
      const loading = useData.getState().load('task')
      await Promise.resolve()
      heard.listener!({ entity: 'task', row: { id: 't9', createdAt: 9, title: 'written during the read' } as never })
      heard.listener!({ entity: 'task', id: 'a', deleted: true })
      vi.advanceTimersByTime(DATA_BATCH_MS)
      open()
      await loading
      vi.advanceTimersByTime(DATA_BATCH_MS)
      await Promise.resolve()
      expect(heard.lists).toBe(before + 1)
      expect((useData.getState().rows.task as Array<{ id: string }>).map((row) => row.id)).toEqual(['t9'])
    } finally {
      heard.gate = Promise.resolve()
      vi.useRealTimers()
    }
  })

  it('patchedMany gives what the changes one by one give', () => {
    const base = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, createdAt: Math.floor(i / 3) }))
    const changes = [
      { row: { id: 'n1', createdAt: 4 } },
      { row: { id: 'r7', createdAt: 2 } },
      { id: 'r9', deleted: true },
      { row: { id: 'r10', createdAt: 30 } },
      { row: { id: 'n2', createdAt: 4 } },
      { row: { id: 'n1', createdAt: 4, x: 1 } },
      { id: 'missing', deleted: true },
      { row: { id: 'n3', createdAt: -1 } },
    ]
    const oneByOne = changes.reduce<Array<{ id: string; createdAt: number }>>((rows, change) => patched(rows, change), base)
    expect(patchedMany(base, changes)).toEqual(oneByOne)
  })

  it('patchedMany is one pass on a big list', () => {
    const base = Array.from({ length: 60_000 }, (_, i) => ({ id: `r${i}`, createdAt: i }))
    const changes = Array.from({ length: 2_000 }, (_, i) => ({ row: { id: `n${i}`, createdAt: i * 30 } }))
    const t = performance.now()
    const out = patchedMany(base, changes)
    expect(performance.now() - t).toBeLessThan(500)
    expect(out).toHaveLength(62_000)
  })
})

describe('pollers and scoped reads use an index, never the whole table', () => {
  it('status and contains read by index and match the plain filter', async () => {
    const store = open()
    const statuses = ['queued', 'sent', 'done', 'failed', 'expired']
    await store.batch(async () => {
      for (let i = 0; i < 200; i += 1) {
        await store.upsert('device_command', { id: `c${i}`, status: statuses[i % 5], createdAt: i } as never)
        await store.upsert('chat_item', { id: `m${i}`, kind: 'activity', text: `t${i}`, meta: JSON.stringify({ status: i % 50 === 0 ? 'running' : 'done', path: `C:\\x\\${i}` }), createdAt: i })
      }
    })
    const plan = store.listWherePlan('device_command', { statuses: ['queued', 'sent'] }).join(' ')
    expect(plan).toContain('rows_status_at')
    const open_ = await store.listWhere('device_command', { statuses: ['queued', 'sent'] })
    expect(open_.map((row) => row.id)).toEqual(filterRows(await store.list('device_command'), { statuses: ['queued', 'sent'] }).map((row) => row.id))
    expect(open_).toHaveLength(80)
    const running = await store.listWhere('chat_item', { kind: 'activity', contains: '\\"status\\":\\"running\\"' })
    expect(running.map((row) => row.id)).toEqual(['m0', 'm50', 'm100', 'm150'])
    const escaped = JSON.stringify(JSON.stringify('C:\\x\\150').slice(1, -1)).slice(1, -1)
    expect((await store.listWhere('chat_item', { contains: escaped })).map((row) => row.id)).toEqual(['m150'])
    expect(filterRows(await store.list('chat_item'), { contains: escaped }).map((row) => row.id)).toEqual(['m150'])
  })

  it('the device command poller never lists the whole table', async () => {
    const { store, lists } = counted(open())
    const commands = new DeviceCommands({ store, selfId: () => 'me', noteBack: async () => undefined } as never)
    await (commands as unknown as { tickOnce(): Promise<void> }).tickOnce()
    expect(lists.get('device_command') ?? 0).toBe(0)
  })

  it('a chat title reads only that chat', async () => {
    const { store, lists } = counted(open())
    await store.upsert('chat_item', { kind: 'user', text: 'Plan the trip', meta: JSON.stringify({ chat: 'pc1' }), createdAt: 1 })
    await store.upsert('chat_item', { kind: 'user', text: 'other', meta: '{}', createdAt: 2 })
    expect(await titleOfChat(store, 'pc1')).toBe('Plan the trip')
    expect(lists.get('chat_item') ?? 0).toBe(0)
  })

  it('data.where input is cleaned and capped', () => {
    expect(listWhereArg({ chat: MAIN_CHAT, kinds: ['agent', 3], limit: 10 ** 9, evil: 'x' })).toEqual({ chat: MAIN_CHAT, kinds: ['agent'], limit: 2000 })
    expect(listWhereArg(null)).toEqual({ limit: 2000 })
  })
})

/**
 * The general class: nothing in the app reads the whole chat table to find a few rows. Each place still allowed
 * needs the whole history by nature (search, the daily pass, reading one past chat by its segment id).
 */
describe('no whole chat table on a hot path', () => {
  const root = join(__dirname, '..', 'src')
  const ALLOWED = new Set([
    'headless/main.ts',
    'main/memory/daily.ts',
    'main/memory/service.ts:newChat',
    'main/memory/service.ts:file',
    'main/memory/service.ts:compress',
    // Only the fallback for a store without listWhere (the line before reads by index).
    'main/runtime/project-agents.ts:checkAll',
    'main/memory/service.ts:searchChats',
    'main/tools/chats.ts',
  ])
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return files(path)
      return /\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts') ? [path] : []
    })
  }
  it('every list of chat_item is in the allowed places', () => {
    const found: string[] = []
    for (const file of files(root)) {
      const rel = relative(root, file).split('\\').join('/')
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      let fn = ''
      lines.forEach((line, at) => {
        const named = /^\s*(?:private |export )?(?:async )?(?:function )?([a-zA-Z]+)\(/.exec(line)
        if (named !== null && !/^\s*(if|for|while|return|await)\b/.test(line)) fn = named[1]!
        if (!/(store|agent\.data)\.list\(\s*['"]chat_item['"]/.test(line)) return
        // A fallback for a store without listWhere (a small fake) is not a hot path.
        if (/listWhere !== undefined \?/.test(line)) return
        if (ALLOWED.has(rel) || ALLOWED.has(`${rel}:${fn}`)) return
        found.push(`${rel}:${at + 1} (${fn})`)
      })
    }
    expect(found).toEqual([])
  })
})
