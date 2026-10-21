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

  it('keeps a run that was still going when New chat was pressed in the old chat', async () => {
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
      await memory.newChat()
      late = () => void runner.deliver('[Helper #1] OLD-HELPER-NOTE')
      release()
      await running
      while (runner.state().running) await new Promise((resolve) => setTimeout(resolve, 20))
      expect(fake.requests).toHaveLength(3)
      await memory.idle()
      // The old run finished after the divider, but its turns belong to the old chat.
      expect((await store.list('chat_item')).some((row) => row.text === 'OLD-FINAL-ANSWER')).toBe(true)
      await runner.send('A brand new question')
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
