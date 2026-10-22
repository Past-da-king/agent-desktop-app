import type { ChatItem, DataChange } from '@agent/core'
import { describe, expect, it, vi } from 'vitest'

import { helperActivities, helperCards, helperView, projectChatLines } from '../src/shared/helper-cards'
import { visibleHelpers } from '../src/renderer/lib/helpers'

const heard: { listener: ((change: DataChange) => void) | null; lists: number } = { listener: null, lists: 0 }

vi.mock('../src/renderer/bridge', () => ({
  agent: {
    data: {
      list: async () => {
        heard.lists += 1
        return [{ id: 'a', createdAt: 1, kind: 'user', text: 'hello', meta: '{}' }]
      },
      onChanged: (callback: (change: DataChange) => void) => {
        heard.listener = callback
        return () => undefined
      },
    },
  },
}))

function row(id: string, kind: string, createdAt: number, meta: Record<string, unknown> = {}, text = id): ChatItem {
  return { id, createdAt, kind, text, meta: JSON.stringify(meta) }
}

/** A chat as big as a long-used install: many finished helpers, a few working, thousands of steps. */
function bigChat(helpers: number, stepsEach: number, working: number): ChatItem[] {
  const items: ChatItem[] = []
  let t = 0
  for (let h = 0; h < helpers; h += 1) {
    const id = `h${h}`
    items.push(row(id, 'helper', (t += 1), { id, label: `Job ${h}`, state: h < helpers - working ? 'done' : 'working', summary: 'On it' }))
    for (let s = 0; s < stepsEach; s += 1) items.push(row(`${id}-s${s}`, 'activity', (t += 1), { helper: id, status: 'done', summary: `Step ${s}` }))
    items.push(row(`${id}-r`, 'agent', (t += 1), {}, `Answer ${h}`))
  }
  return items
}

/** Counts how often the rows' fields are read, the measure of how many times a list is walked. */
function counted(items: ChatItem[]): { items: ChatItem[]; reads: () => number } {
  let reads = 0
  const wrapped = items.map(
    (item) =>
      new Proxy(item, {
        get(target, key, receiver) {
          if (key === 'kind') reads += 1
          return Reflect.get(target, key, receiver) as unknown
        },
      }),
  )
  return { items: wrapped, reads: () => reads }
}

describe('helper cards stay cheap on a big chat', () => {
  it('walks the rows a fixed number of times, not once per helper', () => {
    const big = bigChat(200, 60, 2)
    const { items, reads } = counted(big)
    const cards = helperCards(items, [])
    expect(cards.map((card) => card.id)).toEqual(['h198', 'h199'])
    expect(cards[0]!.steps).toHaveLength(60)
    expect(cards[1]!.line).toBe('Step 59')
    // 12,600 rows; once per helper would be about 2.5 million reads.
    expect(reads()).toBeLessThan(items.length * 4)
  })

  it('a helper view per helper (the thread) reads the list once, not once per helper', () => {
    const { items, reads } = counted(bigChat(200, 30, 0))
    for (const item of items) if (item.kind === 'helper') expect(helperView(item, items).activity).toHaveLength(30)
    expect(reads()).toBeLessThan(items.length * 4)
  })

  it('Home lists the helpers still showing without comparing every helper with every row', () => {
    const big = bigChat(150, 10, 1)
    big.push(row('late', 'helper', 0.5, { id: 'late', state: 'done', endedAt: 1e9 }))
    const { items, reads } = counted(big)
    expect(visibleHelpers(items).map((view) => view.id)).toEqual(['late', 'h149'])
    expect(reads()).toBeLessThan(items.length * 6)
  })

  it('keeps the old order and membership: ties in the list order, agent rows of a helper left out of its chat lines', () => {
    const items = [
      row('pa', 'helper', 1, { id: 'pa', state: 'working', projectChat: 'pc' }),
      row('b', 'activity', 5, { chat: 'pc', status: 'done', summary: 'second listed' }),
      row('a', 'activity', 5, { chat: 'pc', status: 'done', summary: 'first listed later' }),
      row('x', 'agent', 6, { chat: 'pc', helper: 'h1' }),
      row('y', 'agent', 7, { chat: 'pc' }),
      row('z', 'activity', 3, { chat: 'pc', helper: 'h1' }),
    ]
    expect(projectChatLines(items, 'pc').map((item) => item.id)).toEqual(['b', 'a', 'y'])
    expect(helperActivities(items, 'h1').map((item) => item.id)).toEqual(['z'])
    // A caller may change what it gets back without touching the next caller's list.
    helperActivities(items, 'h1').push(items[0]!)
    expect(helperActivities(items, 'h1')).toHaveLength(1)
    // A new list (a change) is read again.
    const next = [...items, row('z2', 'activity', 8, { chat: 'pc', helper: 'h1' })]
    expect(helperActivities(next, 'h1').map((item) => item.id)).toEqual(['z', 'z2'])
  })
})

describe('the window applies row changes together', () => {
  it('a burst of changes is one store update, and nothing is lost', async () => {
    vi.useFakeTimers()
    try {
      const { useData, DATA_BATCH_MS } = await import('../src/renderer/state/useData')
      await useData.getState().load('chat_item')
      expect(heard.listener).not.toBeNull()
      let updates = 0
      const off = useData.subscribe(() => (updates += 1))
      for (let i = 0; i < 25; i += 1) heard.listener!({ entity: 'chat_item', id: `n${i}`, row: { id: `n${i}`, createdAt: 10 + i, kind: 'activity', text: `step ${i}`, meta: '{}' } } as DataChange)
      heard.listener!({ entity: 'chat_item', id: 'a', row: { id: 'a', createdAt: 1, kind: 'user', text: 'hello again', meta: '{}' } } as DataChange)
      heard.listener!({ entity: 'chat_item', id: 'n3', deleted: true } as DataChange)
      expect(updates).toBe(0)
      vi.advanceTimersByTime(DATA_BATCH_MS)
      expect(updates).toBe(1)
      const rows = useData.getState().rows.chat_item
      expect(rows).toHaveLength(25)
      expect(rows[0]!.text).toBe('hello again')
      expect(rows.some((r) => r.id === 'n3')).toBe(false)
      expect(rows.map((r) => r.createdAt)).toEqual([...rows.map((r) => r.createdAt)].sort((a, b) => a - b))
      // A reset in the burst reads the list whole once instead of patching it.
      const before = heard.lists
      heard.listener!({ entity: 'chat_item', id: 'n9', row: { id: 'n9', createdAt: 99, kind: 'agent', text: 'x', meta: '{}' } } as DataChange)
      heard.listener!({ entity: 'chat_item', reset: true } as DataChange)
      vi.advanceTimersByTime(DATA_BATCH_MS)
      expect(heard.lists).toBe(before + 1)
      off()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('Home finds the newest reply without sorting every row', () => {
  it('picks the newest, and the first listed of rows made at the same moment, as the sort did', async () => {
    const { lastAgentWork } = await import('../src/renderer/state/useRun')
    const items = [row('a', 'agent', 5), row('r', 'report', 9), row('b', 'agent', 9), row('u', 'user', 20)]
    expect(lastAgentWork(items)?.id).toBe('r')
    expect(lastAgentWork([row('u', 'user', 1)])).toBeNull()
  })
})
