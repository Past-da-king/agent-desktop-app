/**
 * The running list (9 Nov 2026): everything working on the computer, across all projects at once, grouped by project
 * with the project of the chat on screen first. The whole block folds with one tap on its header and the device
 * remembers; it folds by itself while nothing runs. Each project group folds, and a helper's own helpers fold under
 * it. A card that waits on the person is never folded away. A project's page lists that project's own.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MAIN_CHAT, type ChatItem, type ProjectRow } from '@agent/core'

vi.mock('../src/renderer/bridge', () => ({
  agent: { helpers: { stop: async () => undefined, dismiss: async () => true }, chat: { stop: async () => undefined }, data: { upsert: async () => ({}) } },
  chat: {},
}))

import type { MainCard } from '../src/renderer/lib/card-open'
import { readClosedGroups, readWorkListOpen, WORK_GROUPS_CLOSED_KEY, WORK_LIST_OPEN_KEY } from '../src/renderer/lib/work-list-pref'
import { HelperCardList, type ListCollapse, type ListGroups } from '../src/renderer/shell/HelpersPanel'
import { foldCards, groupCards, helperCards, MAIN_GROUP, workCounts, workLineText } from '../src/shared/helper-cards'

const NOW = 1_000_000

function row(id: string, kind: string, at: number, meta: Record<string, unknown>, text = id): ChatItem {
  return { id, kind, text, meta: JSON.stringify(meta), createdAt: at } as ChatItem
}

function helper(id: string, chat: string, extra: Record<string, unknown> = {}): ChatItem {
  return row(id, 'helper', NOW - 5_000, { id, label: `Job ${id}`, state: 'working', queued: false, startedAt: NOW - 5_000, ...(chat === MAIN_CHAT ? {} : { chat }), ...extra }, `Brief of ${id}`)
}

function project(id: string, name: string, chats: string[]): ProjectRow {
  return { id, createdAt: 1, name, description: '', icon: { glyph: 'globe', color: 'iris' }, path: '', profile: '', hidden: false, chats } as ProjectRow
}

const projects = [project('p1', 'Shop Site', ['pc1', 'pc2']), project('p2', 'Tax Return', ['pc3']), project('p3', 'House Plans', ['pc4'])]

/** Three projects at work at once, and the main chat's own helper. pc1's helper h1 started two more. */
function busy(extra: Record<string, Record<string, unknown>> = {}): ChatItem[] {
  const h = (id: string, chat: string, meta: Record<string, unknown> = {}): ChatItem => helper(id, chat, { ...meta, ...(extra[id] ?? {}) })
  return [
    ...['pc1', 'pc2', 'pc3', 'pc4'].map((chat) => row(`${chat}-u`, 'user', NOW - 9_000, { chat }, `Ask in ${chat}`)),
    h('h1', 'pc1'),
    h('h1a', 'pc1', { parentHelper: 'h1' }),
    h('h1b', 'pc1', { parentHelper: 'h1' }),
    h('h2', 'pc1'),
    h('h3', 'pc2'),
    h('t1', 'pc3'),
    h('t2', 'pc3'),
    h('g1', 'pc4'),
    h('m1', MAIN_CHAT),
  ]
}

const mainCard: MainCard = { kind: 'main', id: MAIN_CHAT, label: 'Hina', line: 'Reading the brief', waiting: false }
const all = (extra: Record<string, Record<string, unknown>> = {}) => helperCards(busy(extra), projects, { now: NOW })
const noGroups = (first: string, closed: string[] = []): ListGroups => ({ first, closed: new Set(closed), onToggle: () => undefined })
const block = (open: boolean): ListCollapse => ({ open, onToggle: () => undefined })

function list(options: { first?: string; closed?: string[]; open?: boolean; needs?: string[]; main?: MainCard | null; extra?: Record<string, Record<string, unknown>>; cards?: ReturnType<typeof all> } = {}): string {
  return renderToStaticMarkup(
    createElement(HelperCardList, {
      cards: options.cards ?? all(options.extra),
      main: options.main === undefined ? mainCard : options.main,
      mascot: 'scout',
      onOpen: () => undefined,
      needs: new Set(options.needs ?? []),
      groups: noGroups(options.first ?? MAIN_GROUP, options.closed),
      ...(options.open === undefined ? {} : { collapse: block(options.open) }),
    }),
  )
}

const shownCards = (html: string): string[] => [...html.matchAll(/data-card="([^"]+)"/g)].map((match) => match[1]!)
const shownGroups = (html: string): string[] => [...html.matchAll(/data-group="([^"]+)"/g)].map((match) => match[1]!)

describe('the running list is global, grouped by project', () => {
  it('shows every project with running work, whatever chat is on screen, the chat\'s project first', () => {
    const cards = all()
    expect(groupCards(cards, true, MAIN_GROUP).map((group) => [group.id, group.name, group.cards.length])).toEqual([
      ['main', 'Main chat', 1],
      ['p1', 'Shop Site', 7],
      ['p2', 'Tax Return', 3],
      ['p3', 'House Plans', 2],
    ])
    // No card is lost to the grouping.
    expect(groupCards(cards, true, 'p2').flatMap((group) => group.cards).length).toBe(cards.length)
    // In a chat of Tax Return: that project first, and nothing dropped.
    expect(shownGroups(list({ first: 'p2' }))).toEqual(['p2', 'main', 'p1', 'p3'])
    expect(shownGroups(list({ first: 'p3' }))).toEqual(['p3', 'main', 'p1', 'p2'])
    // In the main chat, and on a page with no chat: the main chat's group first.
    expect(shownGroups(list({ first: MAIN_GROUP }))).toEqual(['main', 'p1', 'p2', 'p3'])
    expect(shownGroups(list({ first: '' }))).toEqual(['main', 'p1', 'p2', 'p3'])
    const html = list({ first: 'p2' })
    for (const id of ['main', 'm1', 'h1', 'h2', 'h3', 't1', 't2', 'g1']) expect(shownCards(html)).toContain(id)
  })

  it('each group header is a button with the project name and its running count', () => {
    const html = list({ first: 'p1' })
    expect(html).toMatch(/<button type="button" class="hp-group-h" aria-expanded="true">.*?<b>Shop Site<\/b><span>7 working<\/span>/)
    expect(html).toMatch(/<b>Tax Return<\/b><span>3 working<\/span>/)
    expect(html).toMatch(/<b>House Plans<\/b><span>2 working<\/span>/)
    expect(html).toMatch(/<b>Main chat<\/b><span>2 working<\/span>/)
  })

  it('a project group folds on its header: its cards leave, the others stay', () => {
    const html = list({ first: 'p1', closed: ['p1'] })
    expect(html).toMatch(/aria-expanded="false">.*?<b>Shop Site<\/b>/)
    const shown = shownCards(html)
    expect(shown).not.toContain('h1')
    expect(shown).not.toContain('h3')
    expect(shown).toContain('t1')
    expect(shown).toContain('g1')
    expect(shownGroups(html)).toEqual(['p1', 'main', 'p2', 'p3'])
  })

  it('a helper\'s own helpers are folded under it, with a count and a chevron button', () => {
    const html = list({ first: 'p1' })
    const shown = shownCards(html)
    expect(shown).toContain('h1')
    expect(shown).not.toContain('h1a')
    expect(shown).not.toContain('h1b')
    expect(html).toMatch(/data-fold="h1" aria-expanded="false" aria-label="Show the 2 helpers Job h1 started"/)
    expect(html).toContain('2 helpers under it')
    const own = all().filter((card) => card.owner.kind === 'project' && card.owner.id === 'p1')
    expect(foldCards(own, new Set(['h1'])).map((each) => [each.card.id, each.level]).filter(([id]) => String(id).startsWith('h1'))).toEqual([
      ['h1', 0],
      ['h1a', 1],
      ['h1b', 1],
    ])
    // A helper whose parent is not on the list stands on its own; a loop of parents loses no card.
    expect(foldCards(own.filter((card) => card.id !== 'h1')).map((each) => each.card.id)).toContain('h1a')
    const loop = [{ id: 'a', row: { meta: JSON.stringify({ parentHelper: 'b' }) } }, { id: 'b', row: { meta: JSON.stringify({ parentHelper: 'a' }) } }]
    expect(foldCards(loop).map((each) => [each.card.id, each.subs])).toEqual([['a', 1]])
    expect(foldCards(loop, new Set(['a'])).map((each) => each.card.id)).toEqual(['a', 'b'])
  })
})

describe('the whole block folds on its header', () => {
  it('the header is a real button with aria-expanded and the shared wording', () => {
    const html = list({ open: true })
    expect(html).toMatch(/<button type="button" class="hp-head" aria-expanded="true" aria-controls="work-list"/)
    expect(html).toContain('>14 working<')
    expect(workLineText(3, 0, 0)).toBe('3 working')
    expect(workLineText(3, 2, 0)).toBe('3 working, 2 waiting to start')
    expect(workLineText(3, 2, 1)).toBe('3 working, 2 waiting to start, 1 needs you')
    expect(workLineText(0, 0, 2)).toBe('2 need you')
    expect(workLineText(0, 0, 0)).toBe('Nothing running')
    expect(workLineText(1, 0, 0, 2)).toBe('1 working, 2 replied')
    const held = list({ open: true, extra: { t2: { queued: true, summary: 'Queued: waiting for a free slot' } } })
    expect(held).toContain('>13 working, 1 waiting to start<')
    expect(held).toMatch(/<b>Tax Return<\/b><span>2 working, 1 waiting to start<\/span>/)
  })

  it('folded, no card and no group header is left: only the header line', () => {
    const html = list({ open: false })
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('>14 working<')
    expect(shownCards(html)).toEqual([])
    expect(html).not.toContain('hp-group-h')
  })

  it('a card that needs the person is never hidden by a fold: the header warns and the card stays', () => {
    const html = list({ open: false, needs: ['t1'] })
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('<span class="small hp-warn">13 working, 1 needs you</span>')
    expect(shownCards(html)).toEqual(['t1'])
    expect(html).toContain('Needs you')
    // The main chat waiting on him, a project chat whose own agent asked, and a helper under a folded helper.
    expect(shownCards(list({ open: false, main: { ...mainCard, waiting: true, line: 'Waiting for you' } }))).toEqual(['main'])
    const chatAsk = list({ open: false, needs: ['chat:pc4'] })
    expect(shownCards(chatAsk)).toEqual(['pa-pc4'])
    expect(shownCards(list({ open: false, needs: ['h1a'] }))).toEqual(['h1a'])
    expect(shownCards(list({ open: true, needs: ['h1a'] }))).toContain('h1a')
    // A folded group keeps it too, and its header says so in the warn tone.
    const group = list({ open: true, closed: ['p2'], needs: ['t1'] })
    expect(group).toMatch(/<b>Tax Return<\/b><span class="hp-warn">2 working, 1 needs you<\/span>/)
    expect(shownCards(group)).toContain('t1')
    expect(shownCards(group)).not.toContain('t2')
  })

  it('folds by itself while nothing runs, whatever was remembered', () => {
    // Two project chats that answered and wait for his next message: on the list, nothing running.
    const items = [
      row('u1', 'user', NOW - 9_000, { chat: 'pc1' }, 'Fix the checkout'),
      row('r1', 'agent', NOW - 8_000, { chat: 'pc1' }, 'Fixed.'),
      row('u3', 'user', NOW - 9_000, { chat: 'pc3' }, 'File it'),
      row('r3', 'agent', NOW - 8_000, { chat: 'pc3' }, 'Filed.'),
    ]
    const cards = helperCards(items, projects, { now: NOW })
    expect(cards.length).toBe(2)
    expect(workCounts(cards, null)).toMatchObject({ working: 0, held: 0, needs: 0, replied: 2, text: '2 replied' })
    const html = list({ cards, main: null, open: true })
    expect(html).toContain('aria-expanded="false"')
    expect(shownCards(html)).toEqual([])
    // Without a folding header (the title bar's list, a project's page) the list stays open.
    expect(shownCards(list({ cards, main: null })).length).toBe(2)
    // Nothing at all on the computer: no block.
    expect(list({ cards: [], main: null, open: true })).toBe('')
  })
})

describe('the fold is remembered for the device', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  function storage(): Storage & { data: Map<string, string> } {
    const data = new Map<string, string>()
    return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) } as unknown as Storage & { data: Map<string, string> }
  }

  it('is open until the person folds it', () => {
    expect(WORK_LIST_OPEN_KEY).toBe('agent.workListOpen')
    expect(WORK_GROUPS_CLOSED_KEY).toBe('agent.workGroupsClosed')
    expect(readWorkListOpen(null)).toBe(true)
    expect(readWorkListOpen(storage())).toBe(true)
    expect(readClosedGroups(storage())).toEqual([])
  })

  it('one tap folds it and it stays folded in a fresh window; a folded project group too', async () => {
    const store = storage()
    vi.stubGlobal('window', { localStorage: store, matchMedia: () => ({ matches: false }) })
    vi.resetModules()
    const first = await import('../src/renderer/lib/work-list-pref')
    expect(first.useWorkList.getState().open).toBe(true)
    first.useWorkList.getState().toggle()
    first.useWorkList.getState().toggleGroup('p2')
    expect(store.data.get('agent.workListOpen')).toBe('0')
    expect(store.data.get('agent.workGroupsClosed')).toBe('["p2"]')
    // A fresh window: every module is loaded again, only the storage is the same.
    vi.resetModules()
    const second = await import('../src/renderer/lib/work-list-pref')
    expect(second.useWorkList).not.toBe(first.useWorkList)
    const state = second.useWorkList.getState()
    expect(state.open).toBe(false)
    expect([...state.closed]).toEqual(['p2'])
    const html = list({ open: state.open, closed: [...state.closed] })
    expect(html).toContain('class="hp-head" aria-expanded="false"')
    expect(shownCards(html)).toEqual([])
    // One tap opens it again, and that is remembered too; the group is still folded.
    state.toggle()
    vi.resetModules()
    const third = await import('../src/renderer/lib/work-list-pref')
    expect(third.useWorkList.getState().open).toBe(true)
    const open = list({ open: true, closed: [...third.useWorkList.getState().closed] })
    expect(shownCards(open)).toContain('h1')
    expect(shownCards(open)).not.toContain('t1')
    third.useWorkList.getState().toggleGroup('p2')
    expect(store.data.has('agent.workGroupsClosed')).toBe(false)
  })
})

describe("a project's page lists that project's own", () => {
  it('as one plain list under its own heading, helpers folded the same way', () => {
    const own = all().filter((card) => card.owner.kind === 'project' && card.owner.id === 'p1')
    const html = renderToStaticMarkup(createElement(HelperCardList, { cards: own, mascot: 'scout', onOpen: () => undefined, heading: 'WORKING NOW' }))
    expect(html).toContain('WORKING NOW')
    expect(html).not.toContain('hp-group-h')
    expect(html).not.toContain('hp-head')
    expect(shownCards(html)).toEqual(['pa-pc1', 'h1', 'h2', 'pa-pc2', 'h3'])
  })
})
