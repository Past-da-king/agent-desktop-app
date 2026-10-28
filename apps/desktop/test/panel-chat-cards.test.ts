/**
 * Project chats stay in the side panel until the person closes them (decision of 23 Oct 2026). Every project chat
 * that is working, or done with its agent speaking last, is a card (in the side panel, the collapsed strip, the title
 * bar's list and a linked device's feed), with the helpers it started under it. Its X shows only while the card is
 * hovered, hides the card without stopping or deleting anything, lasts through a restart (it is kept on the project
 * row), and the card comes back when the chat moves again: a new turn, a helper under it starting or finishing, a
 * new agent message.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EARLIER_CHATS_PROJECT, type ChatItem, type HelperCardsSnapshot, type ProjectRow } from '@agent/core'

const upserts: Array<{ entity: string; patch: Record<string, unknown> }> = []
vi.mock('../src/renderer/bridge', () => ({
  agent: {
    helpers: { stop: async () => undefined },
    data: {
      upsert: async (entity: string, patch: Record<string, unknown>) => {
        upserts.push({ entity, patch })
        return patch
      },
    },
  },
  chat: {},
}))

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperFeed } from '../src/main/devices/helper-feed'
import { closeCard } from '../src/renderer/lib/card-open'
import { HelperCardList } from '../src/renderer/shell/HelpersPanel'
import { closedChats, closePatch, helperCards } from '../src/shared/helper-cards'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
  upserts.length = 0
})

function row(id: string, kind: string, at: number, meta: Record<string, unknown>, text = id): ChatItem {
  return { id, kind, text, meta: JSON.stringify(meta), createdAt: at } as ChatItem
}

function project(chats: string[], extra: Partial<ProjectRow> = {}): ProjectRow {
  return { id: 'p-site', createdAt: 1, name: 'Shop Site', description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats, ...extra } as ProjectRow
}

/** A project chat he talks to himself (no main-chat row stands for it): he asked, its agent answered. */
function answered(): ChatItem[] {
  return [
    row('u1', 'user', 1_000, { chat: 'pc1' }, 'Fix the checkout'),
    row('s1', 'activity', 1_100, { chat: 'pc1', status: 'done', summary: 'Read the cart code' }),
    row('r1', 'agent', 1_200, { chat: 'pc1' }, 'Fixed: the checkout button submits again.'),
  ]
}

const cards = (items: ChatItem[], projects: ProjectRow[], running: string[] = []): Array<[string, number, string, boolean]> =>
  helperCards(items, projects, { running: (chat) => running.includes(chat) }).map((card) => [card.id, card.depth, card.state, card.waiting])

describe('project chat cards stay until he closes them', () => {
  it('a project chat he talks to directly is a card while it works, and stays once its agent answered', () => {
    const site = project(['pc1'])
    // Working: the turn is running, nothing answered yet.
    expect(cards(answered().slice(0, 2), [site], ['pc1'])).toEqual([['pa-pc1', 0, 'working', false]])
    // Done, its agent spoke last: it stays, his turn, with the answer as its line.
    const done = helperCards(answered(), [site])
    expect(done.map((card) => [card.id, card.kind, card.state, card.waiting, card.projectChat])).toEqual([['pa-pc1', 'project-chat', 'done', true, 'pc1']])
    expect(done[0]!.line).toBe('Fixed: the checkout button submits again.')
    expect(done[0]!.owner).toMatchObject({ kind: 'project', name: 'Shop Site' })
    // Named by its chat (his first message), so two chats of one project are told apart.
    expect(done[0]!.chatTitle).toBe('Fix the checkout')
    // Nothing removes it by itself: days later it is still there.
    expect(cards(answered(), [site])).toHaveLength(1)
  })

  it('no card when he spoke last and nothing runs, for hidden projects, or for the earlier-chats archive', () => {
    const items = [...answered(), row('u2', 'user', 1_300, { chat: 'pc1' }, 'Thanks')]
    expect(cards(items, [project(['pc1'])])).toEqual([])
    expect(cards(answered(), [project(['pc1'], { hidden: true })])).toEqual([])
    expect(cards(answered(), [project(['pc1'], { id: EARLIER_CHATS_PROJECT })])).toEqual([])
  })

  it('the helpers that chat started sit under it: working ones, and the finished ones of its latest turn', () => {
    const items = [
      ...answered(),
      row('h-old', 'helper', 500, { id: 'h-old', chat: 'pc1', label: 'Earlier job', state: 'done', startedAt: 500, endedAt: 600, result: 'old' }),
      row('h-now', 'helper', 1_050, { id: 'h-now', chat: 'pc1', label: 'Cart check', state: 'done', startedAt: 1_050, endedAt: 1_150, result: 'Cart is fine' }),
      row('h-main', 'helper', 1_060, { id: 'h-main', label: 'Main job', state: 'done', startedAt: 1_060, endedAt: 1_070 }),
    ]
    const list = helperCards(items, [project(['pc1'])])
    expect(list.map((card) => [card.id, card.depth])).toEqual([
      ['pa-pc1', 0],
      ['h-now', 1],
    ])
    expect(list[1]!.line).toBe('Cart is fine')
  })

  it('a working chat with nothing of its own to show yet says its helpers are on it, not Starting', () => {
    const items = [row('u1', 'user', 1_000, { chat: 'pc1' }, 'Compress the images'), row('h1', 'helper', 1_010, { id: 'h1', chat: 'pc1', label: 'Squeeze', state: 'working', startedAt: 1_010 })]
    expect(helperCards(items, [project(['pc1'])])[0]!.line).toBe('1 helper working')
  })

  it('working cards first, then the chats waiting on him, newest first', () => {
    const items = [
      ...answered(),
      row('u-b', 'user', 2_000, { chat: 'pc2' }, 'Second'),
      row('r-b', 'agent', 2_100, { chat: 'pc2' }, 'Answer two'),
      row('u-c', 'user', 3_000, { chat: 'pc3' }, 'Third'),
      row('h-w', 'helper', 900, { id: 'h-w', label: 'Loose job', state: 'working', startedAt: 900 }),
    ]
    expect(cards(items, [project(['pc1', 'pc2', 'pc3'])], ['pc3'])).toEqual([
      ['h-w', 0, 'working', false],
      ['pa-pc3', 0, 'working', false],
      ['pa-pc2', 0, 'done', true],
      ['pa-pc1', 0, 'done', true],
    ])
  })

  it('closing hides the card and the helpers under it, and it comes back on new activity of every kind', () => {
    const base = [...answered(), row('h1', 'helper', 1_050, { id: 'h1', chat: 'pc1', label: 'Cart check', state: 'done', startedAt: 1_050, endedAt: 1_150 })]
    const site = project(['pc1'])
    const card = helperCards(base, [site])[0]!
    expect(card.activityAt).toBe(1_200)
    const closed = project(['pc1'], { panelHidden: closePatch(site, 'pc1', card.activityAt) })
    expect(closed.panelHidden).toEqual({ pc1: 1_200 })
    expect(cards(base, [closed])).toEqual([])

    // A new agent message.
    expect(cards([...base, row('r2', 'agent', 1_300, { chat: 'pc1' }, 'One more thing')], [closed])[0]).toEqual(['pa-pc1', 0, 'done', true])
    // A new turn: he writes and it runs.
    expect(cards([...base, row('u2', 'user', 1_300, { chat: 'pc1' }, 'And the cart?')], [closed], ['pc1'])[0]).toEqual(['pa-pc1', 0, 'working', false])
    // A helper under it starts.
    expect(cards([...base, row('h2', 'helper', 1_300, { id: 'h2', chat: 'pc1', label: 'Late job', state: 'working', startedAt: 1_300 })], [closed])[0]).toEqual(['pa-pc1', 0, 'working', false])
    // A helper under it finishes.
    const finished = base.map((item) => (item.id === 'h1' ? row('h1', 'helper', 1_050, { id: 'h1', chat: 'pc1', label: 'Cart check', state: 'done', startedAt: 1_050, endedAt: 1_400 }) : item))
    expect(cards(finished, [closed])[0]).toEqual(['pa-pc1', 0, 'done', true])
    // A main-chat row standing for the chat that the main agent hands new work.
    expect(cards([...base, row('pa-pc1', 'helper', 1_500, { id: 'pa-pc1', label: 'Shop Site', state: 'working', projectChat: 'pc1', startedAt: 1_500 })], [closed])[0]).toEqual(['pa-pc1', 0, 'working', false])
  })

  it('a close only counts for chats the project still holds, and never goes back to an older stamp', () => {
    const site = project(['pc1'], { panelHidden: { pc1: 5_000, gone: 9 } })
    expect([...closedChats([site]).entries()]).toEqual([['pc1', 5_000]])
    expect(closePatch(site, 'pc1', 1_000)).toEqual({ pc1: 5_000 })
  })

  it('the X writes the stamp on the project row and nothing else: no stop, no delete', async () => {
    const site = project(['pc1', 'pc2'], { panelHidden: { pc2: 7 } })
    await closeCard({ projectChat: 'pc1', activityAt: 1_200 }, [site])
    expect(upserts).toEqual([{ entity: 'project', patch: { id: 'p-site', panelHidden: { pc2: 7, pc1: 1_200 } } }])
    await closeCard({ projectChat: '', activityAt: 1 }, [site])
    expect(upserts).toHaveLength(1)
  })
})

describe('the X on a card', () => {
  it('closes only project chat cards, and every working card has a stop X instead', () => {
    const items = [...answered(), row('h-w', 'helper', 900, { id: 'h-w', label: 'Loose job', state: 'working', startedAt: 900 })]
    const list = helperCards(items, [project(['pc1'])])
    const closing = renderToStaticMarkup(createElement(HelperCardList, { cards: list, mascot: 'scout', onOpen: () => undefined, onClose: () => undefined }))
    expect(closing.match(/class="hp-close"/g)).toHaveLength(1)
    // The working helper's card stops it (28 Oct 2026: nothing at work without a stop on screen).
    expect(closing.match(/class="hp-close hp-stop"/g)).toHaveLength(1)
    expect(closing).toContain('aria-label="Stop Loose job"')
    expect(closing).toContain('aria-label="Close the Shop Site card. The chat keeps going"')
    expect(closing).toContain('class="hp-li waiting closable"')
    expect(closing).toContain('Your turn')
    const plain = renderToStaticMarkup(createElement(HelperCardList, { cards: list, mascot: 'scout', onOpen: () => undefined }))
    expect(plain).not.toContain('class="hp-close"')
    expect(plain).toContain('hp-stop')
  })

  it('is invisible until the card is hovered (or the X has keyboard focus), and then takes the place of the pill', () => {
    const css = readFileSync(new URL('../src/renderer/styles/plan.css', import.meta.url), 'utf8')
    const rule = /\.hp-close\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).toMatch(/opacity:0/)
    expect(rule).toMatch(/pointer-events:none/)
    expect(css).toMatch(/\.hp-li\.closable:hover \.hp-close,\.hp-close:focus-visible\{opacity:1;pointer-events:auto\}/)
    expect(css).toMatch(/\.hp-li\.closable:hover \.hp-card>\.pill/)
  })
})

describe('a linked device hears the same cards', () => {
  it('a waiting chat stays in the feed, leaves when closed (kept through a restart), and comes back on a new message', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const heard: HelperCardsSnapshot[] = []
    const feed = new HelperFeed({ store, emit: (s) => heard.push(s), debounceMs: 10 })
    cleanups.push(() => feed.dispose())
    const site = await store.upsert('project', { name: 'Shop Site', description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats: ['pc1'] })
    await store.upsert('chat_item', { kind: 'user', text: 'Fix the checkout', meta: JSON.stringify({ chat: 'pc1' }) })
    await store.upsert('chat_item', { kind: 'agent', text: 'Fixed it.', meta: JSON.stringify({ chat: 'pc1' }) })
    const first = (await feed.snapshot()).cards
    expect(first.map((c) => [c.id, c.kind, c.waiting, c.done])).toEqual([['pa-pc1', 'project-chat', true, 'Fixed it.']])

    await store.upsert('project', { id: site.id, panelHidden: { pc1: first[0]!.activityAt! } })
    await waitFor(() => heard.length > 0 && heard[heard.length - 1]!.cards.length === 0, 2000)

    // A restart: a new feed on the same rows still has it closed.
    const again = new HelperFeed({ store, emit: () => undefined })
    cleanups.push(() => again.dispose())
    expect((await again.snapshot()).cards).toEqual([])

    await new Promise((r) => setTimeout(r, 5))
    await store.upsert('chat_item', { kind: 'agent', text: 'One more thing.', meta: JSON.stringify({ chat: 'pc1' }) })
    await waitFor(() => heard[heard.length - 1]!.cards.length === 1, 2000)
    expect(heard[heard.length - 1]!.cards[0]!.done).toBe('One more thing.')
  })

  it('a chat the runner says is running is a working card on the device', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const feed = new HelperFeed({ store, emit: () => undefined, running: (chat) => chat === 'pc1' })
    cleanups.push(() => feed.dispose())
    await store.upsert('project', { name: 'Shop Site', description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats: ['pc1'] })
    await store.upsert('chat_item', { kind: 'user', text: 'Fix the checkout', meta: JSON.stringify({ chat: 'pc1' }) })
    expect((await feed.snapshot()).cards.map((c) => [c.id, c.state, c.waiting])).toEqual([['pa-pc1', 'working', false]])
  })
})
