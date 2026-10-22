import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type ChatItem, type RunState, type Settings } from '@agent/core'

import { startFakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { ProjectAgentRows, rowIdFor } from '../src/main/runtime/project-agents'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

const meta = (row: ChatItem | null): Record<string, unknown> => (row === null ? {} : (JSON.parse(row.meta) as Record<string, unknown>))

describe('project agents in the main chat', () => {
  it('the main agent hands work to a project: a helper row in the main chat follows it, with the project icon, and closes when it is done', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const project = await store.upsert('project', { name: 'Garden Planner', description: 'Plans the garden', icon: { glyph: 'heart', color: 'teal', image: 'data:image/png;base64,AAAA' }, path: '', profile: '', hidden: false, chats: [] })
    const fake = await startFakeAi((body, index) => {
      const all = JSON.stringify(body['messages'] ?? [])
      if (index === 0) return { toolCalls: [{ name: 'project_chat_start', input: { project: 'Garden Planner', brief: 'List three spring flowers.' } }] }
      if (all.includes('List three spring flowers') && !all.includes('Started a chat')) {
        // The project chat's own turn: a step, then its answer.
        if (!all.includes('"now"') && !all.includes('tool_call')) return { toolCalls: [{ name: 'now', input: {} }] }
        return { text: 'Tulips, daffodils and crocuses.' }
      }
      return { text: 'Started it in Garden Planner.' }
    })
    cleanups.push(() => fake.close())

    let runner: Runner | null = null
    const agents = new ProjectAgentRows({ store, state: (chat): RunState => runner?.state(chat) ?? { running: false, waiting: [] }, checkMs: 100 })
    cleanups.push(() => agents.dispose())
    runner = new Runner({
      store,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
      secrets: secretsView('test-key'),
      providerFactory: (_s, key) => providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true }),
      tools: buildToolset({
        store,
        projects: {
          agents,
          post: async (chat, text, via) => runner?.receive(chat, text, via),
          state: (chat) => runner?.state(chat) ?? { running: false, waiting: [] },
          agentName: () => 'Kit',
        },
      }),
      isFocused: () => true,
      timeZone: 'UTC',
      classifier: null,
    })
    cleanups.push(() => runner?.dispose())

    await runner.send('Ask the garden project for three spring flowers.')
    const chat = (await store.get('project', project.id))?.chats[0] ?? ''
    expect(chat).not.toBe('')
    const id = rowIdFor(chat)
    const first = await waitFor(() => store.get('chat_item', id), 3000)
    expect(first.kind).toBe('helper')
    // In the MAIN chat (no chat tag), so a phone that shows only main-chat rows shows it.
    expect(meta(first)['chat']).toBeUndefined()
    expect(meta(first)).toMatchObject({
      label: 'Garden Planner',
      projectChat: chat,
      project: { id: project.id, name: 'Garden Planner', glyph: 'heart', color: 'teal', image: 'data:image/png;base64,AAAA' },
    })
    const done = await waitFor(async () => {
      const row = await store.get('chat_item', id)
      return meta(row)['state'] === 'done' ? row : null
    }, 8000)
    expect(meta(done)).toMatchObject({ state: 'done', summary: 'Tulips, daffodils and crocuses.', result: 'Tulips, daffodils and crocuses.' })
    expect(typeof meta(done)['endedAt']).toBe('number')
  })

  it('the status line follows the project chat: its steps, its helpers, a question; it stays open while a helper works', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const project = await store.upsert('project', { name: 'Shop Site', description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats: ['pc1'] })
    let running = true
    const agents = new ProjectAgentRows({ store, state: () => ({ running, waiting: [] }), checkMs: 50 })
    cleanups.push(() => agents.dispose())
    await agents.delegated('pc1', project, 'Fix the checkout button')
    const status = async (): Promise<Record<string, unknown>> => meta(await store.get('chat_item', 'pa-pc1'))
    expect(await status()).toMatchObject({ state: 'working', summary: 'Starting', project: { glyph: 'globe', color: 'iris' } })

    await store.upsert('chat_item', { kind: 'activity', text: 'Read the checkout page', meta: JSON.stringify({ chat: 'pc1', status: 'running' }) })
    await waitFor(async () => (await status())['summary'] === 'Read the checkout page', 2000)
    const helper = await store.upsert('chat_item', { kind: 'helper', text: 'Test it', meta: JSON.stringify({ chat: 'pc1', label: 'Tester', state: 'working', summary: 'Clicking through' }) })
    await waitFor(async () => (await status())['summary'] === 'Tester: Clicking through', 2000)

    // The project chat's own turn ends, but its helper still works: the row stays open.
    running = false
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await status())['state']).toBe('working')
    await store.upsert('chat_item', { id: helper.id, kind: 'helper', text: 'Test it', meta: JSON.stringify({ chat: 'pc1', label: 'Tester', state: 'done', summary: 'All good' }) })
    await store.upsert('chat_item', { kind: 'agent', text: 'Fixed and tested.', meta: JSON.stringify({ chat: 'pc1' }) })
    await waitFor(async () => (await status())['state'] === 'done', 2000)
    expect((await status())['summary']).toBe('Fixed and tested.')

    // More work sent later opens the same row again.
    running = true
    await agents.delegated('pc1', project, 'Now the cart page')
    expect(await status()).toMatchObject({ state: 'working', lastBrief: 'Now the cart page' })
    expect((await store.list('chat_item')).filter((row) => row.id === 'pa-pc1')).toHaveLength(1)
  })
})
