import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, schema, type Tool } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'
import { CliHost } from '../src/main/runtime/cli-host'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { chatTools } from '../src/main/tools/chats'
import { chatSegments, SEGMENT_ROWS } from '../src/main/memory/chats'
import { listWhere } from '../src/main/runtime/data'
import { secretsView, settingsView, testContext, toolNamed } from './support'

let store: Store
let index: ChatIndex
let memory: MemoryService
let clock = 1_760_000_000_000
let fake: FakeAi | null = null

beforeEach(() => {
  clock = 1_760_000_000_000
  store = new Store(':memory:', () => (clock += 10))
  index = new ChatIndex(':memory:')
  memory = new MemoryService({
    store,
    index,
    upkeep: new UpkeepFile(null),
    complete: async () => JSON.stringify({ title: '', summary: '', memories: [] }),
    now: () => clock,
  })
})

afterEach(async () => {
  index.close()
  store.close()
  await fake?.close()
  fake = null
})

async function chat(lines: Array<[string, string]>, summary = ''): Promise<void> {
  for (const [kind, text] of lines) await store.upsert('chat_item', { kind, text, meta: '{}' })
  const made = await memory.newChat()
  if (summary !== '' && made.dividerId !== null) {
    const divider = await store.get('chat_item', made.dividerId)
    if (divider !== null) {
      await store.upsert('chat_item', { id: divider.id, kind: divider.kind, text: divider.text, meta: JSON.stringify({ ...JSON.parse(divider.meta), summary, title: 'Summarised chat' }) })
    }
  }
  await memory.idle()
}

describe('past chat search', () => {
  it('finds the right chat, ranked, with snippets, and leaves the current chat out', async () => {
    await chat([
      ['user', 'Book a table at Marble for Friday, the usual window spot for four people please'],
      ['agent', 'Booked Marble for four at 19:00 on Friday, window table.'],
    ])
    await chat([
      ['user', 'Compare the three running shoes I sent you for marathon training this season'],
      ['agent', 'The Pegasus is the best value for your mileage.'],
    ])
    await chat([['user', 'Something about the garden and the roses this weekend, can you remind me']], 'Talked about running a marathon in May and the training plan.')
    await store.upsert('chat_item', { kind: 'user', text: 'Marble again tonight?', meta: '{}' })

    expect(index.fts).toBe(true)
    const hits = await memory.searchChats('marathon running', 5)
    expect(hits.length).toBe(2)
    for (const hit of hits) expect(hit.snippets.join(' ')).toMatch(/\[running\]|\[marathon\]/i)
    expect(hits.map((hit) => hit.title)).toContain('Summarised chat')
    // Porter stemming: "booking" finds "Booked"/"Book".
    const marble = await memory.searchChats('booking marble', 5)
    expect(marble).toHaveLength(1)
    expect(marble[0]?.title).toContain('Book a table at Marble')
    expect(marble[0]?.at).toBeGreaterThan(0)
  })

  it('keeps the index in step when rows change or go', async () => {
    await chat([['user', 'Remember the zebra crossing outside the school on Smith Street'], ['agent', 'Noted the zebra crossing.']])
    expect(await memory.searchChats('zebra')).toHaveLength(1)
    const row = (await store.list('chat_item')).find((item) => item.text.startsWith('Noted'))
    const first = (await store.list('chat_item')).find((item) => item.text.startsWith('Remember'))
    if (row === undefined || first === undefined) throw new Error('missing rows')
    await store.upsert('chat_item', { id: row.id, kind: row.kind, text: 'Noted the giraffe.', meta: row.meta })
    await store.remove('chat_item', first.id)
    expect(await memory.searchChats('zebra')).toHaveLength(0)
    expect(await memory.searchChats('giraffe')).toHaveLength(1)
  })

  it('works without FTS5 too', async () => {
    const plain = new ChatIndex(':memory:', { useFts: false })
    try {
      await chat([['user', 'Let us talk about the quarterly budget for the Durban office'], ['agent', 'The Durban budget is R120,000.']])
      plain.refresh(await store.list('chat_item'))
      const hits = plain.search('durban budget')
      expect(plain.fts).toBe(false)
      expect(hits).toHaveLength(1)
      expect(hits[0]?.snippets[0]).toContain('Durban')
    } finally {
      plain.close()
    }
  })

  it('chats_search and chat_read give the agent ids, dates and numbered messages', async () => {
    const lines: Array<[string, string]> = [['user', 'Plan the Lisbon trip in March with a budget of R18,000 all in']]
    for (let i = 1; i <= 50; i += 1) lines.push([i % 2 === 0 ? 'user' : 'agent', `Lisbon detail number ${i}`])
    await chat(lines)
    const tools = chatTools({ store, search: (query, limit) => memory.searchChats(query, limit) })
    const found = await toolNamed(tools, 'chats_search').run({ query: 'Lisbon budget' }, testContext())
    const id = /chat (\S+):/.exec(found)?.[1] ?? ''
    expect(id).not.toBe('')
    expect(found).toContain('Plan the [Lisbon] trip')

    const read = await toolNamed(tools, 'chat_read').run({ chat_id: id }, testContext())
    expect(read).toContain('51 messages')
    expect(read).toContain('[1] Person')
    expect(read).toContain('[40] Agent')
    expect(read).not.toContain('[41]')
    expect(read).toContain('pass from 41')
    const range = await toolNamed(tools, 'chat_read').run({ chat_id: id, from: 49, to: 60 }, testContext())
    expect(range).toContain('[49] Person')
    expect(range).toContain('[51] Person')
    expect(range).not.toContain('[48]')
    expect(await toolNamed(tools, 'chat_read').run({ chat_id: 'nope' }, testContext())).toBe('No chat with id nope.')
    expect(await toolNamed(tools, 'chats_search').run({ query: 'kangaroo' }, testContext())).toContain('No earlier chat')
  })

  it('chat_read never reads helpers\' steps: they are left out in SQL, and the chats come out the same (27 Nov 2026 freeze)', async () => {
    // Two chats side by side, helper cards and thousands of their steps between the messages, main-agent steps,
    // branch markers, look-alike metas and a divider that files the first chat from another one.
    await store.upsert('chat_item', { kind: 'activity', text: 'early helper step', meta: JSON.stringify({ helper: 'h0' }) })
    for (let i = 0; i < 40; i += 1) {
      await store.upsert('chat_item', { kind: i % 2 === 0 ? 'user' : 'agent', text: `Durban move line ${i}`, meta: i % 3 === 0 ? JSON.stringify({ chat: 'pc9' }) : '{}' })
      await store.upsert('chat_item', { kind: 'helper', text: 'helper card', meta: JSON.stringify({ helper: 'h1', brief: 'x'.repeat(500) }) })
      for (let j = 0; j < 25; j += 1) await store.upsert('chat_item', { kind: 'activity', text: 'y'.repeat(400), meta: JSON.stringify({ helper: `h${j}`, chat: i % 3 === 0 ? 'pc9' : 'main' }) })
      await store.upsert('chat_item', { kind: 'activity', text: 'main step', meta: JSON.stringify({ helper: i % 4 === 0 ? '' : 0 }) })
      if (i % 7 === 0) await store.upsert('chat_item', { kind: 'branch', text: '', meta: '{}' })
      if (i % 11 === 0) await store.upsert('chat_item', { kind: 'activity', text: 'odd meta', meta: 'not json' })
    }
    const first = chatSegments(await store.list('chat_item'))[0]
    await store.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify({ divider: true, chat: 'pc9', memory: { chat: first?.id, status: 'done' }, title: 'Durban move', summary: 'Planning the move.' }) })
    await store.upsert('chat_item', { kind: 'user', text: 'After the divider', meta: JSON.stringify({ chat: 'pc9' }) })

    const shape = (list: ReturnType<typeof chatSegments>) =>
      list.map((segment) => ({ id: segment.id, chat: segment.chat, start: segment.startDivider?.id ?? null, end: segment.endDivider?.id ?? null, items: segment.items.map((item) => item.id), startedAt: segment.startedAt, endedAt: segment.endedAt }))
    const whole = chatSegments(await store.list('chat_item'))
    const read = await listWhere(store, 'chat_item', SEGMENT_ROWS)
    expect(shape(chatSegments(read))).toEqual(shape(whole))
    expect(read.some((row) => row.kind === 'helper' || row.kind === 'branch' || (row.kind === 'activity' && /"helper":"h/.test(row.meta)))).toBe(false)
    expect(read.length).toBeLessThan(200)

    // The tool itself: never the whole chat table, and the same answer as before.
    const reads: string[] = []
    const watched = new Proxy(store, {
      get(target, key) {
        if (key === 'list') return (entity: string) => (reads.push(entity), target.list(entity as never))
        const value = Reflect.get(target, key) as unknown
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    const tools = chatTools({ store: watched, search: (query, limit) => memory.searchChats(query, limit) })
    for (const segment of whole) {
      const answer = await toolNamed(tools, 'chat_read').run({ chat_id: segment.id, from: 1, to: 60 }, testContext())
      expect(answer).toContain(`chat ${segment.id}:`)
    }
    const filed = whole.find((segment) => segment.id === first?.id)
    expect(filed?.endDivider).not.toBeNull()
    expect(await toolNamed(tools, 'chat_read').run({ chat_id: first?.id ?? '' }, testContext())).toContain('summary: Planning the move.')
    expect(reads.filter((entity) => entity === 'chat_item')).toEqual([])
  })
})

describe('New Chat and the model context', () => {
  it('sends only the turns after the newest divider', async () => {
    fake = await startFakeAi(() => ({ text: 'ok' }))
    const fakeUrl = fake.url
    const runner = new Runner({
      store,
      settings: settingsView({ ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake', allowHttp: true }),
      secrets: secretsView('test-key'),
      tools: buildToolset({ store }),
      providerFactory: (_current, key) => providerFor({ provider: 'openai', key, baseUrl: fakeUrl, allowHttp: true }),
      timeZone: 'UTC',
    })
    try {
      await runner.send('The secret codeword is pineapple')
      await memory.newChat()
      await memory.idle()
      await runner.send('What is the codeword?')
      const last = JSON.stringify(fake.requests.at(-1)?.body ?? {})
      expect(last).toContain('What is the codeword?')
      expect(last).not.toContain('pineapple')
      // Nothing was deleted.
      expect((await store.list('chat_item')).some((row) => row.text.includes('pineapple'))).toBe(true)
      // The one-shot model call files with no tools on the same runtime.
      expect(await runner.oneShot('Reply ok', 'hello')).toBe('ok')
      expect(JSON.stringify(fake.requests.at(-1)?.body ?? {})).not.toContain('"tools"')
    } finally {
      runner.dispose()
    }
  })

  it('keeps a run that was still going when New chat was pressed in the old chat (the app path: a fresh chat)', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered: () => void = () => undefined
    const inTool = new Promise<void>((resolve) => (entered = resolve))
    const slowTool: Tool = {
      spec: { name: 'slow_lookup', description: 'Looks something up slowly.', schema: schema([], {}) },
      run: async () => {
        entered()
        await gate
        return 'OLD-TOOL-RESULT'
      },
    }
    let late: (() => void) | null = null
    fake = await startFakeAi((_body, index) => {
      if (index === 0) return { toolCalls: [{ name: 'slow_lookup', input: {} }] }
      if (index === 1) {
        // A helper's result lands while the old run is finishing: it becomes one more turn of that run.
        late?.()
        return { text: 'OLD-FINAL-ANSWER' }
      }
      return { text: index === 2 ? 'OLD-ACK' : 'fresh' }
    })
    const fakeUrl = fake.url
    const runner = new Runner({
      store,
      settings: settingsView({ ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake', allowHttp: true }),
      secrets: secretsView('test-key'),
      tools: [...buildToolset({ store }), slowTool],
      providerFactory: (_current, key) => providerFor({ provider: 'openai', key, baseUrl: fakeUrl, allowHttp: true }),
      timeZone: 'UTC',
    })
    try {
      const running = runner.send('The old question about apricots')
      await inTool
      // What the New chat button does (renderer/lib/chat-actions.ts): open a fresh chat, filed from the one it left.
      const fresh = 'cfreshchat00001'
      const made = await memory.newChat({ chat: fresh, from: 'main' })
      const divider = (await store.list('chat_item')).find((row) => row.id === made.dividerId)
      expect(JSON.parse(divider?.meta ?? '{}')['chat']).toBe(fresh)
      // A helper started by the old run reports back to the chat that started it (HelperManager.deliver(note, chat)).
      late = () => void runner.deliver('[Helper #1] OLD-HELPER-NOTE', 'main')
      release()
      await running
      while (runner.state().running) await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fake.requests).toHaveLength(3)
      await memory.idle()
      // The old run finished after the divider, but its turns belong to the old chat.
      expect((await store.list('chat_item')).some((row) => row.text === 'OLD-FINAL-ANSWER')).toBe(true)
      // The helper's note stayed with the old chat's run.
      expect(JSON.stringify(fake.requests[2]?.body ?? {})).toContain('OLD-HELPER-NOTE')
      await runner.send('A brand new question', [], fresh)
      const last = JSON.stringify(fake.requests.at(-1)?.body ?? {})
      expect(last).toContain('A brand new question')
      expect(last).not.toContain('apricots')
      expect(last).not.toContain('OLD-TOOL-RESULT')
      expect(last).not.toContain('OLD-FINAL-ANSWER')
      expect(last).not.toContain('OLD-HELPER-NOTE')
    } finally {
      runner.dispose()
    }
  })
})

describe('the plan session after New chat', () => {
  it('forgetting main clears it on every engine and keeps helpers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-cli-forget-'))
    const host = new CliHost(dir, () => DEFAULT_SETTINGS, dir)
    writeFileSync(join(dir, 'sessions.json'), JSON.stringify({ 'claude:main': 's1', 'claude:main#rev': '2', 'codex:main': 's2', 'claude:helper:x': 's3' }))
    host.forget('main')
    expect(JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8'))).toEqual({ 'claude:helper:x': 's3' })
  })
})
