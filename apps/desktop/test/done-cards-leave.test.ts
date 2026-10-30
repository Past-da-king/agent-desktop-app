/**
 * A helper card that finished (done, failed or stopped) leaves the side panel at once, in the window and in the feed
 * a linked phone hears. A project chat's card is different (decision of 23 Oct 2026): once its agent has answered it
 * stays, waiting on the person, until he closes it (test/panel-chat-cards.test.ts); with nothing waiting it leaves.
 * A project chat that was stopped is recorded as stopped, not done.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ChatItem, HelperCardsSnapshot } from '@agent/core'

const rows: { chat_item: ChatItem[]; project: unknown[] } = { chat_item: [], project: [] }

vi.mock('../src/renderer/bridge', () => ({ agent: { helpers: { stop: async () => undefined } } }))
vi.mock('../src/renderer/state/useData', () => ({ useEntity: (entity: 'chat_item' | 'project') => rows[entity], useCalmEntity: (entity: 'chat_item' | 'project') => rows[entity] }))

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperFeed } from '../src/main/devices/helper-feed'
import { ProjectAgentRows } from '../src/main/runtime/project-agents'
import { HelpersPanel } from '../src/renderer/shell/HelpersPanel'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  rows.chat_item = []
  rows.project = []
})

function projectCard(state: 'working' | 'done' | 'stopped', now: number): ChatItem {
  const meta = {
    id: 'pa-pc1',
    label: 'Shop Site',
    state,
    summary: state === 'working' ? 'Fixing the checkout' : 'Done. Checkout is fixed.',
    result: state === 'working' ? '' : 'Done. Checkout is fixed.',
    projectChat: 'pc1',
    startedAt: now - 60_000,
    endedAt: state === 'working' ? null : now - 1_000,
    project: { id: 'p1', name: 'Shop Site', glyph: 'globe', color: 'iris' },
  }
  return { id: 'pa-pc1', kind: 'helper', text: 'Fix the checkout', meta: JSON.stringify(meta), createdAt: now - 60_000, updatedAt: now } as ChatItem
}

const shop = { id: 'p1', createdAt: 1, updatedAt: 1, name: 'Shop Site', description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats: ['pc1'] }

function reply(now: number): ChatItem {
  return { id: 'r1', kind: 'agent', text: 'Done. Checkout is fixed.', meta: JSON.stringify({ chat: 'pc1' }), createdAt: now - 1_000 } as ChatItem
}

describe('finished cards and the side panel', () => {
  it('a project chat card stays once it is done and its agent answered, saying it is his turn; stopped with nothing to read, it leaves', () => {
    const now = Date.now()
    rows.project = [shop]
    rows.chat_item = [projectCard('working', now)]
    const live = renderToStaticMarkup(createElement(HelpersPanel))
    expect(live).toContain('Shop Site')
    expect(live).toContain('1 working')

    rows.chat_item = [projectCard('done', now), reply(now)]
    const done = renderToStaticMarkup(createElement(HelpersPanel))
    expect(done).toContain('Shop Site')
    expect(done).toContain('Your turn')
    expect(done).toContain('1 replied')
    expect(done).toContain('Done. Checkout is fixed.')

    // Nothing from its agent to read (it was stopped before it said anything): no card.
    rows.chat_item = [projectCard('stopped', now)]
    expect(renderToStaticMarkup(createElement(HelpersPanel))).toBe('')
  })

  it('the phone feed keeps the answered project chat card too', async () => {
    const store = new Store(':memory:')
    const heard: HelperCardsSnapshot[] = []
    const feed = new HelperFeed({ store, emit: (s) => heard.push(s), debounceMs: 10 })
    cleanups.push(() => feed.dispose())
    cleanups.push(() => store.close())
    const now = Date.now()
    await store.upsert('project', { id: 'p1', name: 'Shop Site', description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats: ['pc1'] })
    const working = projectCard('working', now)
    await store.upsert('chat_item', { id: working.id, kind: 'helper', text: working.text, meta: working.meta })
    expect((await feed.snapshot()).cards.map((c) => c.id)).toEqual(['pa-pc1'])
    await store.upsert('chat_item', { kind: 'agent', text: 'Done. Checkout is fixed.', meta: JSON.stringify({ chat: 'pc1' }) })
    const done = projectCard('done', now)
    await store.upsert('chat_item', { id: done.id, kind: 'helper', text: done.text, meta: done.meta })
    await waitFor(() => heard.length > 0 && heard[heard.length - 1]!.cards[0]?.state === 'done', 2000)
    expect((await feed.snapshot()).cards.map((c) => [c.id, c.waiting, c.done])).toEqual([['pa-pc1', true, 'Done. Checkout is fixed.']])
  })
})

describe('a stopped project chat reads as stopped', () => {
  it('its main-chat row closes with state stopped when the chat ended on the Stopped notice', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const project = await store.upsert('project', { name: 'Shop Site', description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats: ['pc1'] })
    let running = true
    const agents = new ProjectAgentRows({ store, state: () => ({ running, waiting: [] }), checkMs: 50 })
    cleanups.push(() => agents.dispose())
    await agents.delegated('pc1', project, 'Fix the checkout button')
    await store.upsert('chat_item', { kind: 'agent', text: 'Looking at it.', meta: JSON.stringify({ chat: 'pc1' }) })
    await store.upsert('chat_item', { kind: 'notice', text: 'Stopped', meta: JSON.stringify({ chat: 'pc1' }) })
    running = false
    const state = async (): Promise<unknown> => (JSON.parse((await store.get('chat_item', 'pa-pc1'))!.meta) as Record<string, unknown>)['state']
    await waitFor(async () => (await state()) !== 'working', 2000)
    expect(await state()).toBe('stopped')
  })
})
