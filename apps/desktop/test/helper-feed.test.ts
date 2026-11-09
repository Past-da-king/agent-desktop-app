import { afterEach, describe, expect, it } from 'vitest'

import type { HelperCardsSnapshot } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperFeed } from '../src/main/devices/helper-feed'
import { RPC_ALLOWED, RPC_CHANNELS, RPC_EVENTS } from '../src/shared/rpc-methods'
import { CHANNELS, EVENTS } from '../src/shared/channels'
import { helperCards } from '../src/shared/helper-cards'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function setup(now: () => number = () => Date.now()): Promise<{ store: Store; feed: HelperFeed; heard: HelperCardsSnapshot[] }> {
  const store = new Store(':memory:')
  const heard: HelperCardsSnapshot[] = []
  const feed = new HelperFeed({ store, emit: (s) => heard.push(s), debounceMs: 10, now })
  cleanups.push(() => feed.dispose())
  cleanups.push(() => store.close())
  return { store, feed, heard }
}

describe('helper cards for linked devices', () => {
  it('helpers.cards is on the device allowlist with its own event', () => {
    expect(RPC_ALLOWED.has('helpers.cards')).toBe(true)
    expect(RPC_CHANNELS['helpers.cards']).toBe(CHANNELS.helpers.cards)
    expect(RPC_EVENTS.has(EVENTS.helperCards)).toBe(true)
  })

  it('every working helper from any chat, project agent first with its helpers under it, then live lines and the done line', async () => {
    const { store, feed, heard } = await setup()
    const project = await store.upsert('project', { name: 'Garden', description: '', icon: { glyph: 'heart', color: 'teal' }, path: '', profile: '', hidden: false, chats: ['pc1'] })
    const t = Date.now()
    // A helper in the main chat, an older project agent row restarted now, and a helper inside that project's chat.
    await store.upsert('chat_item', { id: 'h-main', kind: 'helper', text: 'Look up the weather', meta: JSON.stringify({ id: 'h-main', label: 'Weather', state: 'working', startedAt: t - 1000 }) })
    await store.upsert('chat_item', {
      id: 'pa-pc1',
      kind: 'helper',
      text: 'old brief',
      meta: JSON.stringify({ id: 'pa-pc1', label: 'Garden', state: 'working', summary: 'Reading the plan', startedAt: t - 500, projectChat: 'pc1', lastBrief: 'Plan the spring beds', project: { id: project.id, name: 'Garden', glyph: 'heart', color: 'teal' } }),
    })
    await store.upsert('chat_item', { id: 'h-proj', kind: 'helper', text: 'Find seeds', meta: JSON.stringify({ id: 'h-proj', chat: 'pc1', label: 'Seeds', state: 'working', startedAt: t - 200 }) })
    await store.upsert('chat_item', { id: 'a1', kind: 'activity', text: 'Searching seed shops', meta: JSON.stringify({ helper: 'h-proj', chat: 'pc1', status: 'running' }) })
    await store.upsert('chat_item', { id: 'a2', kind: 'activity', text: 'Opened the plan', meta: JSON.stringify({ chat: 'pc1' }) })

    const first = await feed.snapshot()
    expect(first.cards.map((c) => [c.id, c.depth])).toEqual([
      ['h-main', 0],
      ['pa-pc1', 0],
      ['h-proj', 1],
    ])
    const pa = first.cards[1]!
    expect(pa.owner).toMatchObject({ kind: 'project', name: 'Garden', icon: { glyph: 'heart', color: 'teal' } })
    // Its line is the step its project chat is on now, not the row's older status line.
    expect(pa.line).toBe('Opened the plan')
    expect(pa.brief).toBe('Plan the spring beds')
    expect(pa.steps.map((s) => s.text)).toEqual(['Opened the plan'])
    expect(first.cards[2]!.line).toBe('Searching seed shops')
    expect(first.cards[2]!.owner).toMatchObject({ kind: 'project', name: 'Garden' })
    expect(first.cards[0]!.owner).toEqual({ kind: 'main' })

    // A new step: the live line moves, and the device hears the whole new list.
    await store.upsert('chat_item', { id: 'a3', kind: 'activity', text: 'Comparing prices', meta: JSON.stringify({ helper: 'h-proj', chat: 'pc1', status: 'running' }) })
    await waitFor(() => heard.some((s) => s.cards.find((c) => c.id === 'h-proj')?.line === 'Comparing prices'))
    // It finishes: it stays threaded under its project chat's card (that chat's latest turn), with its done line.
    await store.upsert('chat_item', { id: 'h-proj', kind: 'helper', text: 'Find seeds', meta: JSON.stringify({ id: 'h-proj', chat: 'pc1', label: 'Seeds', state: 'done', startedAt: t - 200, endedAt: Date.now(), result: '## Found\nThree shops sell **heirloom** seeds.\nMore detail' }) })
    await waitFor(() => heard.length > 0 && heard[heard.length - 1]!.cards.find((c) => c.id === 'h-proj')?.state === 'done')
    const last = heard[heard.length - 1]!
    expect(last.cards.map((c) => [c.id, c.depth])).toEqual([
      ['h-main', 0],
      ['pa-pc1', 0],
      ['h-proj', 1],
    ])
    expect(last.cards[2]!.done).toBe('Found')
    expect(last.seq).toBeGreaterThan(first.seq)
    // Nothing changed: nothing is sent.
    const count = heard.length
    await store.upsert('chat_item', { id: 'u1', kind: 'user', text: 'hello', meta: '{}' })
    await new Promise((r) => setTimeout(r, 60))
    expect(heard.length).toBe(count)
  })

  it('holds only the helpers that can make a card, not every helper there ever was', async () => {
    const { store, feed, heard } = await setup()
    const t = Date.now()
    for (let i = 0; i < 120; i += 1) {
      await store.upsert('chat_item', { id: `old-${i}`, kind: 'helper', text: `Old job ${i}`, meta: JSON.stringify({ id: `old-${i}`, label: `Old ${i}`, state: i % 3 === 0 ? 'failed' : 'done', result: 'x'.repeat(1500), startedAt: t - 90_000, endedAt: t - 60_000 }) })
    }
    await store.upsert('chat_item', { id: 'h-live', kind: 'helper', text: 'Look up the weather', meta: JSON.stringify({ id: 'h-live', label: 'Weather', state: 'working', startedAt: t - 1000 }) })
    const first = await feed.snapshot()
    expect(first.cards.map((c) => c.id)).toEqual(['h-live'])
    expect(feed.held()).toBe(1)
    // It finishes: its card goes, and so does the row from memory. Another old helper's row changing is no news.
    await store.upsert('chat_item', { id: 'h-live', kind: 'helper', text: 'Look up the weather', meta: JSON.stringify({ id: 'h-live', label: 'Weather', state: 'done', result: 'Sunny.', startedAt: t - 1000, endedAt: t }) })
    await waitFor(() => heard.length > 0 && heard[heard.length - 1]!.cards.length === 0, 2000)
    expect(feed.held()).toBe(0)
    const sent = heard.length
    await store.upsert('chat_item', { id: 'old-1', kind: 'helper', text: 'Old job 1', meta: JSON.stringify({ id: 'old-1', label: 'Old 1', state: 'done', result: 'changed', noticed: 'k' }) })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(heard.length).toBe(sent)
  })

  it('stopped, done and failed helpers are not on the list at all', async () => {
    const clock = Date.now()
    const { store, feed } = await setup(() => clock)
    await store.upsert('chat_item', { id: 'h1', kind: 'helper', text: 'x', meta: JSON.stringify({ id: 'h1', label: 'One', state: 'stopped', startedAt: clock - 10, endedAt: clock }) })
    await store.upsert('chat_item', { id: 'h2', kind: 'helper', text: 'y', meta: JSON.stringify({ id: 'h2', label: 'Two', state: 'done', startedAt: clock - 10, endedAt: clock, result: 'All good' }) })
    await store.upsert('chat_item', { id: 'h3', kind: 'helper', text: 'z', meta: JSON.stringify({ id: 'h3', label: 'Three', state: 'failed', startedAt: clock - 10, endedAt: clock }) })
    await store.upsert('chat_item', { id: 'h4', kind: 'helper', text: 'w', meta: JSON.stringify({ id: 'h4', label: 'Four', state: 'working', startedAt: clock - 10 }) })
    expect((await feed.snapshot()).cards.map((c) => c.id)).toEqual(['h4'])
  })

  it('the side panel model by default: working helpers only', () => {
    const rows = [
      { id: 'w', kind: 'helper', text: '', meta: JSON.stringify({ state: 'working' }), createdAt: 1, updatedAt: 1 },
      { id: 'd', kind: 'helper', text: '', meta: JSON.stringify({ state: 'done', endedAt: Date.now() }), createdAt: 2, updatedAt: 2 },
    ]
    expect(helperCards(rows as never, []).map((c) => c.id)).toEqual(['w'])
  })

  it('side panel project card: live step while it works, its newest steps, and gone once idle', () => {
    const now = Date.now()
    const row = (id: string, kind: string, text: string, meta: Record<string, unknown>, at: number): unknown => ({ id, kind, text, meta: JSON.stringify(meta), createdAt: at, updatedAt: at })
    const working = [
      row('pa-c', 'helper', 'brief', { id: 'pa-c', label: 'Site', state: 'working', summary: 'Starting', projectChat: 'c', startedAt: now - 9 }, now - 9),
      row('s1', 'activity', 'Read the repo', { chat: 'c', status: 'done' }, now - 8),
      row('s2', 'activity', 'Running the tests', { chat: 'c', status: 'running' }, now - 7),
      row('hs', 'activity', 'A helper step', { chat: 'c', helper: 'other', status: 'running' }, now - 6),
      row('d1', 'helper', 'old', { id: 'd1', label: 'Old helper', state: 'done', endedAt: now - 5, result: 'x' }, now - 20),
    ]
    const live = helperCards(working as never, [])
    expect(live.map((c) => c.id)).toEqual(['pa-c'])
    expect(live[0]!.line).toBe('Running the tests')
    expect(live[0]!.steps.map((s) => s.text)).toEqual(['Read the repo', 'Running the tests'])
    const idle = [
      row('pa-c', 'helper', 'brief', { id: 'pa-c', label: 'Site', state: 'done', projectChat: 'c', startedAt: now - 9, endedAt: now - 1, result: 'Shipped the gallery fix.\nDetails' }, now - 9),
    ]
    expect(helperCards(idle as never, [])).toEqual([])
  })

  it('starts after a restart with the cards a device had (snapshot on reconnect)', async () => {
    const { store } = await setup()
    await store.upsert('chat_item', { id: 'h9', kind: 'helper', text: 'z', meta: JSON.stringify({ id: 'h9', label: 'Nine', state: 'working', startedAt: Date.now() }) })
    const again = new HelperFeed({ store, emit: () => undefined })
    cleanups.push(() => again.dispose())
    expect((await again.snapshot()).cards.map((c) => c.label)).toEqual(['Nine'])
  })
})
