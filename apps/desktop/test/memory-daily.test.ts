import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type MemoryRow } from '@agent/core'

import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { WHERE_ID, dueDay, duplicateGroups, slotMinutes, startOfDay } from '../src/main/memory/daily'
import { MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'
import { buildSystemPrompt } from '../src/main/runtime/prompt'

let store: Store
let index: ChatIndex
let upkeep: UpkeepFile
// 21 Oct 2026 at 10:00 local time.
let clock = new Date(2026, 9, 21, 10, 0, 0).getTime()

beforeEach(() => {
  clock = new Date(2026, 9, 21, 10, 0, 0).getTime()
  store = new Store(':memory:', () => (clock += 1000))
  index = new ChatIndex(':memory:')
  upkeep = new UpkeepFile(null)
})

afterEach(() => {
  index.close()
  store.close()
})

type Reply = (system: string, prompt: string) => string

function service(reply: Reply, dailyAt = '23:30'): { memory: MemoryService; prompts: string[] } {
  const prompts: string[] = []
  const memory = new MemoryService({
    store,
    index,
    upkeep,
    complete: async (system, prompt) => {
      prompts.push(prompt)
      return reply(system, prompt)
    },
    dailyAt: () => dailyAt,
    now: () => clock,
  })
  return { memory, prompts }
}

const where = (body: string, memories: unknown[] = []): string => JSON.stringify({ where: body, memories })
const isWhere = (system: string): boolean => system.startsWith("You write the user's")

async function talk(text: string, answer: string): Promise<void> {
  await store.upsert('chat_item', { kind: 'user', text, meta: '{}' })
  await store.upsert('chat_item', { kind: 'agent', text: answer, meta: '{}' })
}

describe('end-of-day slot', () => {
  it('is due once the slot passes, once per day, and catches up a missed day', () => {
    const today = new Date(2026, 9, 21, 23, 40).getTime()
    expect(slotMinutes('23:30')).toBe(1410)
    expect(slotMinutes('nonsense')).toBe(1410)
    expect(dueDay(new Date(2026, 9, 21, 23, 0).getTime(), '23:30', '', 0)).toBeNull()
    expect(dueDay(today, '23:30', '', 0)).toMatchObject({ day: '2026-10-21', catchUp: false })
    expect(dueDay(today, '23:30', '2026-10-21', 0)).toBeNull()
    // The app was closed at 23:30 yesterday: on launch this morning, yesterday is compiled once.
    const morning = new Date(2026, 9, 22, 8, 0).getTime()
    const lastChat = new Date(2026, 9, 21, 17, 0).getTime()
    expect(dueDay(morning, '23:30', '2026-10-20', lastChat)).toMatchObject({ day: '2026-10-21', catchUp: true, from: startOfDay(lastChat) })
    expect(dueDay(morning, '23:30', '2026-10-21', lastChat)).toBeNull()
  })
})

describe('end-of-day pass', () => {
  it('compiles today into one pinned "Where we are" page that replaces yesterday and reaches new chats', async () => {
    await store.upsert('memory', { id: WHERE_ID, title: 'Where we are', body: '**Goals**\n- Old goal from yesterday.', kind: 'project', topics: 'continuation, daily, 2026-10-20', pinned: true, source: 'agent' })
    await talk('Ship the memory import tonight and then email Alex Meyer the summary', 'Done: the import is in. I will draft the email to Alex next.')
    const { memory, prompts } = service((system) =>
      isWhere(system)
        ? where('**Goals**\n- Memory import live.\n\n**Done today**\n- Import shipped.\n\n**Open threads**\n- Email to [[Alex Meyer]].\n\n**Next steps**\n- Send Alex the summary.', [
            { kind: 'person', title: 'Alex Meyer', body: 'CEO of Acme. Gets the weekly summary by email.' },
          ])
        : JSON.stringify({ changes: [] }),
    )

    const report = await memory.runNow()

    expect(report.ok).toBe(true)
    expect(report.chats).toBe(1)
    expect(prompts[0]).toContain('Old goal from yesterday.')
    expect(prompts[0]).toContain('Person: Ship the memory import tonight')
    const page = await store.get('memory', WHERE_ID)
    expect(page).toMatchObject({ pinned: true, kind: 'project' })
    expect(page?.body).toContain('Send Alex the summary.')
    expect((await store.list('memory')).filter((row) => row.title === 'Where we are')).toHaveLength(1)
    expect(memory.upkeepState().history).toEqual([{ day: '2026-10-20', body: '**Goals**\n- Old goal from yesterday.' }])
    expect(report.changes.map((change) => change.action)).toEqual(['where', 'filed'])

    // A fresh chat sees it: the pinned page is in every new conversation's prompt.
    const system = buildSystemPrompt({ settings: DEFAULT_SETTINGS, now: new Date(clock), platform: 'win32', memories: await store.list('memory'), goals: [], tasks: [], latestUserText: 'hi', timeZone: 'UTC' })
    expect(system).toContain('CORE MEMORIES (pinned')
    expect(system).toContain('Send Alex the summary.')
  })

  it('merges near-duplicates, rewrites stale pages and drops noise, all logged and undoable', async () => {
    const keep = await store.upsert('memory', { title: 'Lerato Dlamini', body: 'Runs the books at Acme.', kind: 'person', topics: 'acme', pinned: false, source: 'agent' })
    const dup = await store.upsert('memory', { title: 'lerato dlamini', body: 'Lives in Durban.', kind: 'person', topics: 'family', pinned: false, source: 'agent' })
    const noise = await store.upsert('memory', { title: 'Checking flights now', body: 'Currently comparing three flights for the trip.', kind: 'fact', topics: '', pinned: false, source: 'agent' })
    const stale = await store.upsert('memory', { title: 'Invoice day', body: 'Invoices go out on the 25th.', kind: 'preference', topics: '', pinned: false, source: 'agent' })
    // Newest first: the page edited last is the one kept.
    await store.upsert('memory', { ...keep })
    const { memory } = service((system) =>
      isWhere(system)
        ? where('unused')
        : JSON.stringify({
            changes: [
              { id: noise.id, action: 'drop', reason: 'Progress note, only true that day' },
              { id: stale.id, action: 'rewrite', body: 'Invoices go out on the 26th since October 2026, as PDF.', reason: 'Date moved' },
              { id: 'not-a-page', action: 'drop' },
            ],
          }),
    )

    const report = await memory.runNow()

    expect(report).toMatchObject({ ok: true, chats: 0, merged: 1, rewritten: 1, dropped: 2 })
    const left = await store.list('memory')
    expect(left.map((row) => row.title).sort()).toEqual(['Invoice day', 'Lerato Dlamini'])
    expect((await store.get('memory', keep.id))?.body).toBe('Runs the books at Acme.\nLives in Durban.')
    expect((await store.get('memory', keep.id))?.topics).toBe('acme, family')
    expect((await store.get('memory', stale.id))?.body).toBe('Invoices go out on the 26th since October 2026, as PDF.')
    expect(report.message).toContain('1 merged')

    // Every change is reversible.
    for (const change of report.changes) expect(await memory.undo(change.id)).toBe(true)
    expect(await memory.undo(report.changes[0]?.id ?? '')).toBe(false)
    const back = await store.list('memory')
    expect(back.map((row: MemoryRow) => row.id).sort()).toEqual([keep.id, dup.id, noise.id, stale.id].sort())
    expect((await store.get('memory', stale.id))?.body).toBe('Invoices go out on the 25th.')
    expect((await store.get('memory', keep.id))?.body).toBe('Runs the books at Acme.')
    expect(memory.upkeepState().report?.changes.every((change) => change.undone === true)).toBe(true)
  })

  it('runs on the timer only when due, and reports a model failure without losing the sweep', async () => {
    await talk('Plan the Lisbon trip for March with a budget of R18,000', 'Here are three flight options.')
    const { memory } = service(() => {
      throw new Error('The AI provider says we are sending too much right now.')
    })
    expect(await memory.tick()).toBeNull()
    clock = new Date(2026, 9, 21, 23, 45).getTime()
    const report = await memory.tick()
    expect(report?.trigger).toBe('schedule')
    expect(report?.ok).toBe(false)
    expect(report?.message).toContain('sending too much')
    // A failed compile leaves the day open so it is tried again.
    expect(memory.upkeepState().lastDay).toBe('')
  })

  it('once the day is done, the minute check reads no chats at all', async () => {
    await talk('Plan the Lisbon trip for March', 'Here are three flight options.')
    let userReads = 0
    const counting = Object.create(store) as typeof store
    counting.listWhere = (async (entity, where) => {
      if (entity === 'chat_item' && where.kind === 'user' && where.limit === 1) userReads += 1
      return store.listWhere(entity, where)
    }) as typeof store.listWhere
    const memory = new MemoryService({ store: counting, index, upkeep, complete: async () => where('x'), dailyAt: () => '23:30', now: () => clock })
    // Today's upkeep has run.
    upkeep.update((state) => {
      state.lastDay = '2026-10-21'
    })
    expect(memory.upkeepState().lastDay).toBe('2026-10-21')
    for (let minute = 46; minute < 60; minute += 1) {
      clock = new Date(2026, 9, 21, 23, minute).getTime()
      expect(await memory.tick()).toBeNull()
    }
    expect(userReads).toBe(0)
  })

  it('leaves a day another brain claimed to that brain', async () => {
    await talk('Plan the Lisbon trip for March', 'Here are three flight options.')
    const asked: string[] = []
    const memory = new MemoryService({ store, index, upkeep, complete: async () => where('x'), dailyAt: () => '23:30', now: () => clock, claimDaily: async (day) => (asked.push(day), false) })
    clock = new Date(2026, 9, 21, 23, 45).getTime()
    expect(await memory.tick()).toBeNull()
    expect(asked).toEqual(['2026-10-21'])
    expect(memory.upkeepState().lastDay).toBe('')
  })

  it('finds duplicate groups by kind and title', () => {
    const now = Date.now()
    const row = (id: string, title: string, kind: MemoryRow['kind'] = 'how-to', updatedAt = now): MemoryRow => ({ id, title, body: id, kind, topics: '', pinned: false, source: 'agent', createdAt: now, updatedAt })
    const groups = duplicateGroups([
      row('a', 'Deploy the Creek sites to Cloudflare Pages', 'how-to', now),
      row('b', 'Deploy the Creek sites to Cloudflare Pages.', 'how-to', now - 5),
      row('c', 'Deploy the Creek sites to Cloudflare Pages', 'decision'),
      row('d', 'Something else entirely'),
    ])
    expect(groups.map((group) => group.map((item) => item.id))).toEqual([['a', 'b']])
  })
})
