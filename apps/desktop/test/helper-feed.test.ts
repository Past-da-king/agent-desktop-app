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
    expect(pa.line).toBe('Reading the plan')
    expect(pa.brief).toBe('Plan the spring beds')
    expect(pa.steps.map((s) => s.text)).toEqual(['Opened the plan'])
    expect(first.cards[2]!.line).toBe('Searching seed shops')
    expect(first.cards[2]!.owner).toMatchObject({ kind: 'project', name: 'Garden' })
    expect(first.cards[0]!.owner).toEqual({ kind: 'main' })

    // A new step: the live line moves, and the device hears the whole new list.
    await store.upsert('chat_item', { id: 'a3', kind: 'activity', text: 'Comparing prices', meta: JSON.stringify({ helper: 'h-proj', chat: 'pc1', status: 'running' }) })
    await waitFor(() => heard.some((s) => s.cards.find((c) => c.id === 'h-proj')?.line === 'Comparing prices'))
    // It finishes: one line saying what it did.
    await store.upsert('chat_item', { id: 'h-proj', kind: 'helper', text: 'Find seeds', meta: JSON.stringify({ id: 'h-proj', chat: 'pc1', label: 'Seeds', state: 'done', startedAt: t - 200, endedAt: Date.now(), result: '## Found\nThree shops sell **heirloom** seeds.\nMore detail' }) })
    await waitFor(() => heard.some((s) => s.cards.find((c) => c.id === 'h-proj')?.state === 'done'))
    const last = heard[heard.length - 1]!
    const done = last.cards.find((c) => c.id === 'h-proj')!
    expect(done.done).toBe('Found')
    expect(done.depth).toBe(1)
    expect(last.seq).toBeGreaterThan(first.seq)
    // Nothing changed: nothing is sent.
    const count = heard.length
    await store.upsert('chat_item', { id: 'u1', kind: 'user', text: 'hello', meta: '{}' })
    await new Promise((r) => setTimeout(r, 60))
    expect(heard.length).toBe(count)
  })

  it('a stopped helper leaves at once; a finished one leaves when its time is up', async () => {
    let clock = Date.now()
    const { store, feed, heard } = await setup(() => clock)
    await store.upsert('chat_item', { id: 'h1', kind: 'helper', text: 'x', meta: JSON.stringify({ id: 'h1', label: 'One', state: 'stopped', startedAt: clock - 10, endedAt: clock }) })
    await store.upsert('chat_item', { id: 'h2', kind: 'helper', text: 'y', meta: JSON.stringify({ id: 'h2', label: 'Two', state: 'done', startedAt: clock - 10, endedAt: clock, result: 'All good' }) })
    expect((await feed.snapshot()).cards.map((c) => c.id)).toEqual(['h2'])
    clock += 21 * 60_000
    await store.upsert('chat_item', { id: 'a', kind: 'activity', text: 'tick', meta: JSON.stringify({ helper: 'h2' }) })
    await waitFor(() => heard.length > 0 && heard[heard.length - 1]!.cards.length === 0)
  })

  it('the side panel model is unchanged: working helpers only', () => {
    const rows = [
      { id: 'w', kind: 'helper', text: '', meta: JSON.stringify({ state: 'working' }), createdAt: 1, updatedAt: 1 },
      { id: 'd', kind: 'helper', text: '', meta: JSON.stringify({ state: 'done', endedAt: Date.now() }), createdAt: 2, updatedAt: 2 },
    ]
    expect(helperCards(rows as never, []).map((c) => c.id)).toEqual(['w'])
  })

  it('starts after a restart with the cards a device had (snapshot on reconnect)', async () => {
    const { store } = await setup()
    await store.upsert('chat_item', { id: 'h9', kind: 'helper', text: 'z', meta: JSON.stringify({ id: 'h9', label: 'Nine', state: 'working', startedAt: Date.now() }) })
    const again = new HelperFeed({ store, emit: () => undefined })
    cleanups.push(() => again.dispose())
    expect((await again.snapshot()).cards.map((c) => c.label)).toEqual(['Nine'])
  })
})
