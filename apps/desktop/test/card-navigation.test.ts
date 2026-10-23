/**
 * Side panel cards jump into the real conversation (23 Oct 2026). A project chat's card opens that chat in full (the
 * chat page with that chat, at its newest message, the cursor in the box), from the main chat, from another project's
 * page and from Settings, and wherever the chat runs. A helper's card opens the helper's own view, which links to the
 * project chat it works in. The main chat's card opens the main chat. Back returns to where the person was. The
 * agent can do the same through window.show.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { MAIN_CHAT, type ChatItem, type JobRow, type DeviceRow, type ProjectRow } from '@agent/core'

// The stores reach the app bridge; here it answers nothing.
vi.mock('../src/renderer/bridge', () => ({
  agent: { platform: 'web', data: { list: async () => [] }, chat: {} },
  chat: { state: async () => ({ running: false, waiting: [] }), states: async () => [], onEvent: () => () => undefined },
}))

// A window with an address bar, so the hash the app writes can be read back.
const fakeWindow = { location: { hash: '', search: '' }, localStorage: new Map<string, string>() }
const storage = {
  getItem: (key: string) => fakeWindow.localStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void fakeWindow.localStorage.set(key, value),
  removeItem: (key: string) => void fakeWindow.localStorage.delete(key),
}
vi.stubGlobal('window', { location: fakeWindow.location, localStorage: storage, matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }), setTimeout, clearTimeout })

const { useUi } = await import('../src/renderer/state/useUi')
const { useChats } = await import('../src/renderer/state/useChats')
const { usePanel } = await import('../src/renderer/state/usePanel')
const { useData } = await import('../src/renderer/state/useData')
const { cardTarget, mainCard, openCard, openTarget } = await import('../src/renderer/lib/card-open')
const { helperCards, helperParentChat, cardInfo } = await import('../src/shared/helper-cards')
const { HelperCardList, HelperDetail } = await import('../src/renderer/shell/HelpersPanel')
const { routeTo } = await import('../src/renderer/state/keys')
const { hashFor, parseHash } = await import('../src/renderer/state/route')
const { chatPlaces } = await import('../src/renderer/lib/chat-place')
const { parseRouteTarget } = await import('../src/shared/route-target')
const { APP_ACTION_POLICY } = await import('../src/main/tools/app-actions')

function row(id: string, kind: string, createdAt: number, meta: Record<string, unknown> = {}, text = id): ChatItem {
  return { id, createdAt, kind, text, meta: JSON.stringify(meta) }
}

function project(id: string, name: string, chats: string[]): ProjectRow {
  return { id, createdAt: 1, updatedAt: 1, name, description: '', icon: { glyph: 'code', color: 'iris' }, path: '', profile: '', hidden: false, chats } as unknown as ProjectRow
}

const website = project('p-web', 'Website', ['pcweb1'])
const server = project('p-srv', 'Server work', ['pcsrv1'])

/** A project agent row in the main chat (runtime/project-agents.ts), a helper inside that project chat, a main helper. */
function rows(): ChatItem[] {
  return [
    row('u1', 'user', 1, {}, 'Fix the website footer'),
    row('pa-pcweb1', 'helper', 10, { id: 'pa-pcweb1', label: 'Website', state: 'working', summary: 'Editing the footer', startedAt: 10, projectChat: 'pcweb1', project: { id: 'p-web', name: 'Website', glyph: 'code', color: 'iris' } }, 'Fix the footer'),
    row('pa-pcsrv1', 'helper', 11, { id: 'pa-pcsrv1', label: 'Server work', state: 'working', summary: 'Deploying', startedAt: 11, projectChat: 'pcsrv1', project: { id: 'p-srv', name: 'Server work', glyph: 'code', color: 'iris' } }, 'Deploy'),
    row('h-web', 'helper', 12, { id: 'h-web', label: 'Footer check', state: 'working', summary: '', startedAt: 12, chat: 'pcweb1' }, 'Check every footer link'),
    row('h-web-step', 'activity', 13, { helper: 'h-web', chat: 'pcweb1', status: 'running', summary: 'Opening the contact page' }),
    row('h-main', 'helper', 14, { id: 'h-main', label: 'Inbox sweep', state: 'working', summary: '', startedAt: 14 }, 'Sweep the inbox'),
    row('a-web', 'agent', 15, { chat: 'pcweb1' }, 'Footer updated'),
    row('m-step', 'activity', 16, { status: 'running', summary: 'Reading the calendar' }),
  ]
}

/** The claim row that says a project chat runs on another device (main/runtime/offload.ts placeChat). */
const claim = { id: 'chat-pcsrv1', kind: 'claim', op: 'chat', status: 'running', device: 'node-srv', createdAt: 1, updatedAt: 1 } as unknown as JobRow
const serverNode = { id: 'node-srv', name: 'server-node', createdAt: 1, updatedAt: 1 } as unknown as DeviceRow

beforeEach(() => {
  fakeWindow.location.hash = ''
  useUi.setState({ route: { page: 'chat', chat: MAIN_CHAT }, back: [], overlay: null, composerFocus: 0, chatScroll: 0 })
  useChats.setState({ open: MAIN_CHAT })
  usePanel.setState({ helper: null, report: null, collapsed: false })
  const data = useData.getState()
  useData.setState({
    rows: { ...data.rows, chat_item: rows(), project: [website, server], job: [claim], device: [serverNode] },
    loaded: { ...data.loaded, chat_item: true, project: true, job: true, device: true },
  })
})

function cards(): ReturnType<typeof helperCards> {
  return helperCards(rows(), [website, server])
}

function card(id: string): ReturnType<typeof helperCards>[number] {
  const found = cards().find((each) => each.id === id)
  if (found === undefined) throw new Error(`no card ${id}`)
  return found
}

describe('a project chat card', () => {
  it('is a project chat, not a helper, and a helper is a helper', () => {
    expect(card('pa-pcweb1').kind).toBe('project-chat')
    expect(card('h-web').kind).toBe('helper')
    expect(card('h-main').kind).toBe('helper')
    expect(cardTarget(card('pa-pcweb1'))).toEqual({ kind: 'project-chat', chat: 'pcweb1' })
    expect(cardTarget(card('h-web'))).toEqual({ kind: 'helper', id: 'h-web' })
    // A card from an older computer has no kind: the projectChat field still says what it is.
    expect(cardTarget({ id: 'pa-x', projectChat: 'pcx' })).toEqual({ kind: 'project-chat', chat: 'pcx' })
    expect(cardTarget({ id: 'h-x', projectChat: '' })).toEqual({ kind: 'helper', id: 'h-x' })
    // A linked device hears the kind too.
    expect(cardInfo(card('pa-pcweb1')).kind).toBe('project-chat')
    expect(cardInfo(card('h-web')).parentChat).toBe('pcweb1')
  })

  it('opens that chat in full from the main chat: the chat page with that chat, at the bottom, cursor in the box', () => {
    const before = useUi.getState()
    openCard(card('pa-pcweb1'))
    const after = useUi.getState()
    expect(after.route).toEqual({ page: 'chat', chat: 'pcweb1' })
    expect(useChats.getState().open).toBe('pcweb1')
    expect(after.chatScroll).toBe(before.chatScroll + 1)
    expect(after.composerFocus).toBe(before.composerFocus + 1)
    expect(fakeWindow.location.hash).toBe('#/chat/pcweb1')
    expect(usePanel.getState().helper).toBeNull()
  })

  it('opens from a different project page, and Back returns to that page', () => {
    useUi.getState().navigate({ page: 'project', id: 'p-srv' })
    openCard(card('pa-pcweb1'))
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: 'pcweb1' })
    expect(useUi.getState().goBack()).toBe(true)
    expect(useUi.getState().route).toEqual({ page: 'project', id: 'p-srv' })
    expect(fakeWindow.location.hash).toBe('#/project/p-srv')
  })

  it('opens from Settings, and Back returns to Settings', () => {
    useUi.getState().navigate({ page: 'settings' })
    openCard(card('pa-pcweb1'))
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: 'pcweb1' })
    expect(useUi.getState().goBack()).toBe(true)
    expect(useUi.getState().route.page).toBe('settings')
  })

  it('Back from a project chat returns to the main chat it was opened from, in that chat', () => {
    openCard(card('pa-pcweb1'))
    expect(useUi.getState().back).toEqual([{ page: 'chat', chat: MAIN_CHAT }])
    useUi.getState().goBack()
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: MAIN_CHAT })
    expect(useChats.getState().open).toBe(MAIN_CHAT)
    expect(fakeWindow.location.hash).toBe('#/chat')
    // Nothing more to go back to.
    expect(useUi.getState().goBack()).toBe(false)
  })

  it('still opens the full chat here when its claim row says it runs on another device', () => {
    expect(chatPlaces([claim], [serverNode]).get('pcsrv1')).toBe('server-node')
    openCard(card('pa-pcsrv1'))
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: 'pcsrv1' })
    expect(useChats.getState().open).toBe('pcsrv1')
  })

  it('marks the card whose chat is on screen, and only that one', () => {
    const html = renderToStaticMarkup(createElement(HelperCardList, { cards: cards(), main: mainCard(rows(), true, 0, 'Scout'), current: 'pcweb1', mascot: 'scout', onOpen: () => undefined }))
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    expect(html).toMatch(/aria-current="true"[^>]*aria-label="Open the Website chat"|aria-label="Open the Website chat"[^>]*aria-current="true"/)
    const onMain = renderToStaticMarkup(createElement(HelperCardList, { cards: cards(), main: mainCard(rows(), true, 0, 'Scout'), current: MAIN_CHAT, mascot: 'scout', onOpen: () => undefined }))
    expect(onMain).toMatch(/data-kind="main"[^>]*aria-current="true"|aria-current="true"[^>]*data-kind="main"/)
  })
})

describe('a helper card', () => {
  it('opens the helper view and leaves the page where it is', () => {
    useUi.getState().navigate({ page: 'settings' })
    openCard(card('h-web'))
    expect(usePanel.getState().helper).toBe('h-web')
    expect(useUi.getState().route.page).toBe('settings')
  })

  it("links to the project chat it works in, which opens that chat in full; a main chat helper has no link", () => {
    const items = rows()
    expect(helperParentChat(items.find((item) => item.id === 'h-web') as ChatItem, [website, server])).toBe('pcweb1')
    expect(helperParentChat(items.find((item) => item.id === 'h-main') as ChatItem, [website, server])).toBe('')
    expect(helperParentChat(items.find((item) => item.id === 'pa-pcweb1') as ChatItem, [website, server])).toBe('')

    const view = (id: string): string => renderToStaticMarkup(createElement(HelperDetail, { id, items, projects: [website, server], onClose: () => undefined }))
    const html = view('h-web')
    // Still the helper's own view: its brief and its steps.
    expect(html).toContain('Check every footer link')
    expect(html).toContain('Opening the contact page')
    expect(html).toContain('Open the project chat')
    expect(html).toContain('data-chat="pcweb1"')
    expect(html).toContain('Website')
    expect(view('h-main')).not.toContain('Open the project chat')
  })
})

describe('the main chat card', () => {
  it('shows while the main chat works or waits, and opens the main chat at the bottom with the cursor in the box', () => {
    expect(mainCard(rows(), false, 0, 'Scout')).toBeNull()
    const main = mainCard(rows(), true, 0, 'Scout')
    expect(main).toMatchObject({ kind: 'main', label: 'Scout', line: 'Reading the calendar' })
    expect(mainCard(rows(), false, 2, 'Scout')?.line).toBe('2 waiting for you')

    useUi.getState().navigate({ page: 'project', id: 'p-web' })
    const before = useUi.getState()
    openTarget(cardTarget(main as NonNullable<typeof main>))
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: MAIN_CHAT })
    expect(useUi.getState().chatScroll).toBe(before.chatScroll + 1)
    expect(useUi.getState().composerFocus).toBe(before.composerFocus + 1)
  })

  it('leads the card list, and each card says which kind it is', () => {
    const html = renderToStaticMarkup(createElement(HelperCardList, { cards: cards(), main: mainCard(rows(), true, 0, 'Scout'), mascot: 'scout', onOpen: () => undefined }))
    expect(html.indexOf('data-kind="main"')).toBeLessThan(html.indexOf('data-kind="project-chat"'))
    expect(html.match(/data-kind="project-chat"/g)).toHaveLength(2)
    expect(html.match(/data-kind="helper"/g)).toHaveLength(2)
    expect(html).toContain('Open the main chat with Scout')
    expect(html).toContain('5 working')
  })
})

describe('the address and the agent', () => {
  it('names the chat in the address, so a reload or Back lands in the same chat', () => {
    expect(hashFor({ page: 'chat', chat: 'pcweb1' })).toBe('#/chat/pcweb1')
    expect(hashFor({ page: 'chat', chat: MAIN_CHAT })).toBe('#/chat')
    expect(parseHash('#/chat/pcweb1')).toEqual({ page: 'chat', chat: 'pcweb1' })
    expect(parseHash('#/chat')).toEqual({ page: 'chat' })
    useUi.getState().applyHash('#/chat/pcsrv1')
    expect(useChats.getState().open).toBe('pcsrv1')
    useUi.getState().applyHash('#/chat')
    expect(useChats.getState().open).toBe(MAIN_CHAT)
  })

  it('does what a tap does when the agent asks (window.show), a notification card id included', () => {
    expect(APP_ACTION_POLICY['window.show']?.kind).toBe('free')
    expect(parseRouteTarget('pcweb1')).toEqual({ view: 'chat', id: 'pcweb1' })
    useUi.getState().navigate({ page: 'settings' })
    routeTo({ view: 'chat', id: 'pcweb1' })
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: 'pcweb1' })
    routeTo({ view: 'back', id: '' })
    expect(useUi.getState().route.page).toBe('settings')
    // A "needs you" notification names the card: its chat opens.
    routeTo({ view: 'chat', id: 'a-web' })
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: 'pcweb1' })
    routeTo({ view: 'chat', id: '' })
    expect(useUi.getState().route).toEqual({ page: 'chat', chat: MAIN_CHAT })
    routeTo({ view: 'helper', id: 'h-web' })
    expect(usePanel.getState().helper).toBe('h-web')
  })
})
