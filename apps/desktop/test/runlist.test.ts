/**
 * The running list (29 Oct 2026): no card stays stuck, a card's X/swipe stops it and takes it off every device, a
 * project chat shows only its project's cards, and a mini-app's read-only learned-app calls run without a card.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { MAIN_CHAT, providerFor, type ChatItem, type HelperCardInfo, type JsonObject, type MiniAppRow, type ProjectRow, type Settings } from '@agent/core'

import { Store } from '../src/main/db'
import { MiniAppHost } from '../src/main/miniapps/host'
import { plainHost } from '../src/main/miniapps/plugin-host'
import { MiniAppStore } from '../src/main/miniapps/store'
import { dismissCard } from '../src/main/runtime/card-dismiss'
import { HelperManager, ORPHAN_ANY_MS, ORPHAN_ROUTINE_MS, type OffloadLink } from '../src/main/runtime/helpers'
import { ProjectAgentRows } from '../src/main/runtime/project-agents'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { cardClosed, cardInfo, cardsForChat, helperCards, WAITING_CARD_MS } from '../src/shared/helper-cards'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

const T0 = 1_790_000_000_000
const meta = (row: ChatItem | null): Record<string, unknown> => (row === null ? {} : (JSON.parse(row.meta) as Record<string, unknown>))

function item(id: string, kind: string, text: string, m: Record<string, unknown>, createdAt = T0): ChatItem {
  return { id, kind, text, meta: JSON.stringify(m), createdAt }
}

function project(id: string, name: string, chats: string[], extra: Partial<ProjectRow> = {}): ProjectRow {
  return { id, name, description: '', icon: { glyph: 'folder', color: 'iris' }, path: '', profile: '', hidden: false, chats, createdAt: T0, ...extra } as ProjectRow
}

describe('cards for the chat on screen', () => {
  const projects = [project('p1', 'Agent App', ['c1', 'c1b']), project('p2', 'Cosmiprint', ['c2'])]
  const items = [
    item('u1', 'user', 'fix the list', { chat: 'c1' }, T0),
    item('h1', 'helper', 'build it', { label: 'Builder', state: 'working', chat: 'c1', startedAt: T0 + 1 }, T0 + 1),
    item('u2', 'user', 'make a video', { chat: 'c2' }, T0),
    item('h2', 'helper', 'render', { label: 'Render', state: 'working', chat: 'c2', startedAt: T0 + 2 }, T0 + 2),
    item('h3', 'helper', 'research', { label: 'Research', state: 'working', startedAt: T0 + 3 }, T0 + 3),
  ]
  const cards = helperCards(items, projects, { running: (chat) => chat === 'c1' || chat === 'c2', now: T0 + 10 })

  it('the main chat (and any other page) shows every card across all projects', () => {
    expect(cardsForChat(cards, projects, MAIN_CHAT).map((card) => card.id).sort()).toEqual(cards.map((card) => card.id).sort())
    expect(cardsForChat(cards, projects, '').length).toBe(cards.length)
    expect(cards.map((card) => card.label)).toEqual(expect.arrayContaining(['Agent App', 'Builder', 'Cosmiprint', 'Render', 'Research']))
  })

  it("inside a project chat only that project's cards show, from any of its chats", () => {
    expect(cardsForChat(cards, projects, 'c1').map((card) => card.label)).toEqual(['Agent App', 'Builder'])
    expect(cardsForChat(cards, projects, 'c1b').map((card) => card.label)).toEqual(['Agent App', 'Builder'])
    expect(cardsForChat(cards, projects, 'c2').map((card) => card.label)).toEqual(['Cosmiprint', 'Render'])
  })

  it('works on the cards a linked device gets too', () => {
    const infos = cards.map((card) => ({ ...cardInfo(card), row: { meta: card.row.meta } }))
    expect(cardsForChat(infos, projects, 'c2').map((card) => card.label)).toEqual(['Cosmiprint', 'Render'])
  })
})

describe('no card stays for ever', () => {
  const projects = [project('p1', 'Agent App', ['c1'])]
  const base = [
    item('u1', 'user', 'go', { chat: 'c1' }, T0),
    item('a1', 'agent', 'Done, here it is.', { chat: 'c1' }, T0 + 50),
  ]

  it('a finished helper closed with its X leaves its project chat card; it comes back only if it works again', () => {
    const done = item('h1', 'helper', 'job', { label: 'Builder', state: 'done', chat: 'c1', startedAt: T0 + 10, endedAt: T0 + 40, result: 'ok' }, T0 + 10)
    expect(helperCards([...base, done], projects, { now: T0 + 100 }).map((card) => card.label)).toEqual(['Agent App', 'Builder'])
    const closed = item('h1', 'helper', 'job', { ...meta(done), cardClosedAt: T0 + 60 }, T0 + 10)
    expect(cardClosed(closed)).toBe(true)
    expect(helperCards([...base, closed], projects, { now: T0 + 100 }).map((card) => card.label)).toEqual(['Agent App'])
    const again = item('h1', 'helper', 'job', { ...meta(closed), state: 'working', startedAt: T0 + 70, endedAt: null }, T0 + 10)
    expect(cardClosed(again)).toBe(false)
  })

  it('a project chat waiting on him leaves by itself after a day with nothing new', () => {
    expect(helperCards(base, projects, { now: T0 + 1000 }).map((card) => card.waiting)).toEqual([true])
    expect(helperCards(base, projects, { now: T0 + 50 + WAITING_CARD_MS + 1 })).toEqual([])
  })
})

function cardOf(c: Partial<HelperCardInfo> & { id: string }): HelperCardInfo {
  return { kind: 'helper', parentChat: '', row: c.id, chat: MAIN_CHAT, label: 'x', state: 'working', queued: false, line: '', done: '', depth: 0, projectChat: '', owner: { kind: 'main' }, model: '', startedAt: T0, endedAt: null, brief: '', result: '', steps: [], waiting: false, activityAt: T0, ...c }
}

describe("a card's X or swipe (helpers.dismiss)", () => {
  it('a working helper is stopped and its card stamped closed, so it leaves every list', async () => {
    const store = new Store(':memory:', () => T0)
    cleanups.push(() => store.close())
    const row = await store.upsert('chat_item', { kind: 'helper', text: 'job', meta: JSON.stringify({ label: 'Builder', state: 'working', chat: 'c1', startedAt: T0 }) })
    const stops: string[] = []
    let now = T0 + 1000
    const result = await dismissCard(row.id, {
      get: (id) => store.get('chat_item', id),
      upsertItem: (patch) => store.upsert('chat_item', patch),
      projects: () => store.list('project'),
      upsertProject: (patch) => store.upsert('project', patch),
      cards: async () => [cardOf({ id: row.id, row: row.id })],
      stopHelper: async (id) => {
        stops.push(id)
        const fresh = await store.get('chat_item', id)
        await store.upsert('chat_item', { ...fresh!, meta: JSON.stringify({ ...meta(fresh), state: 'stopped', endedAt: now }) })
        return true
      },
      stopChat: () => undefined,
      chatRunning: () => false,
      now: () => (now += 1),
      sleep: async () => undefined,
    })
    expect(result).toEqual({ ok: true, stopped: true })
    expect(stops).toEqual([row.id])
    const after = await store.get('chat_item', row.id)
    expect(meta(after)['state']).toBe('stopped')
    expect(cardClosed(after!)).toBe(true)
  })

  it("a project chat's card: its run is stopped, a row left working with nothing running is ended, and the card is closed until the chat moves", async () => {
    const store = new Store(':memory:', () => T0)
    cleanups.push(() => store.close())
    const p = await store.upsert('project', { name: 'Agent App', description: '', path: '', profile: '', hidden: false, chats: ['c1'] } as never)
    const pa = await store.upsert('chat_item', { id: 'pa-c1', kind: 'helper', text: 'brief', meta: JSON.stringify({ id: 'pa-c1', label: 'Agent App', state: 'working', projectChat: 'c1', startedAt: T0 }) })
    let running = true
    const stopped: string[] = []
    const result = await dismissCard('pa-c1', {
      get: (id) => store.get('chat_item', id),
      upsertItem: (patch) => store.upsert('chat_item', patch),
      projects: () => store.list('project'),
      upsertProject: (patch) => store.upsert('project', patch),
      cards: async () => [cardOf({ id: pa.id, row: pa.id, kind: 'project-chat', projectChat: 'c1', activityAt: T0 + 5 })],
      stopHelper: async () => false,
      stopChat: (chat) => {
        stopped.push(chat)
        running = false
      },
      chatRunning: () => running,
      now: () => T0 + 2000,
      sleep: async () => undefined,
    })
    expect(result).toEqual({ ok: true, stopped: true })
    expect(stopped).toEqual(['c1'])
    expect(meta(await store.get('chat_item', 'pa-c1'))['state']).toBe('stopped')
    expect((await store.get('project', p.id))?.panelHidden).toEqual({ c1: T0 + 2000 })
  })

  it('an unknown card says so', async () => {
    const store = new Store(':memory:', () => T0)
    cleanups.push(() => store.close())
    const result = await dismissCard('nope', {
      get: (id) => store.get('chat_item', id),
      upsertItem: (patch) => store.upsert('chat_item', patch),
      projects: () => store.list('project'),
      upsertProject: (patch) => store.upsert('project', patch),
      cards: async () => [],
      stopHelper: async () => false,
      stopChat: () => undefined,
      chatRunning: () => false,
    })
    expect(result.ok).toBe(false)
  })
})

function manager(store: Store, now: () => number, offload?: OffloadLink): HelperManager {
  const m = new HelperManager({
    store,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: 'http://127.0.0.1:9', allowHttp: true }),
    workerTools: buildWorkerToolset({ store }),
    deliver: () => undefined,
    platform: 'linux',
    timeZone: 'UTC',
    reapEveryMs: 0,
    now,
    ...(offload === undefined ? {} : { offload }),
  })
  cleanups.push(() => m.shutdown())
  return m
}

describe('the orphan watch ends cards nobody will ever end', () => {
  it('a card naming no brain and with no lease (a phone reset, an older app) is ended after ORPHAN_ANY_MS of silence, not before', async () => {
    let clock = T0
    const store = new Store(':memory:', () => clock)
    cleanups.push(() => store.close())
    const m = manager(store, () => clock)
    const row = await store.upsert('chat_item', { kind: 'helper', text: 'job', meta: JSON.stringify({ label: 'Ghost', state: 'working', startedAt: clock }) })
    clock += 10 * 60_000
    expect(await m.reap()).toBe(0)
    clock = T0 + ORPHAN_ANY_MS + 1
    expect(await m.reap()).toBe(1)
    expect(meta(await store.get('chat_item', row.id))['state']).toBe('stopped')
  })

  it('one that still writes steps is left alone', async () => {
    let clock = T0
    const store = new Store(':memory:', () => clock)
    cleanups.push(() => store.close())
    const m = manager(store, () => clock)
    const row = await store.upsert('chat_item', { kind: 'helper', text: 'job', meta: JSON.stringify({ label: 'Busy', state: 'working', startedAt: clock }) })
    clock = T0 + ORPHAN_ANY_MS + 1
    await store.upsert('chat_item', { kind: 'activity', text: 'a step', meta: JSON.stringify({ helper: row.id, status: 'done' }) })
    expect(await m.reap()).toBe(0)
    expect(meta(await store.get('chat_item', row.id))['state']).toBe('working')
  })

  it('placed by a brain that is gone for good: another brain ends it once it has been silent that long', async () => {
    let clock = T0
    const store = new Store(':memory:', () => clock)
    cleanups.push(() => store.close())
    const link: OffloadLink = {
      selfId: () => 'me',
      isSelf: (id) => id === 'me',
      up: () => false,
      place: async () => ({ device: 'gone', name: 'Old server', why: '' }),
      send: async () => undefined,
      leaseHolder: async () => ({ device: '', running: false }),
      deviceName: async () => 'Old server',
    }
    const m = manager(store, () => clock, link)
    const row = await store.upsert('chat_item', { kind: 'helper', text: 'job', meta: JSON.stringify({ label: 'Lost', state: 'working', startedAt: clock, placedBy: 'gone', runOn: 'gone-too' }) })
    clock += 30 * 60_000
    expect(await m.reap()).toBe(0)
    clock = T0 + ORPHAN_ANY_MS + 1
    expect(await m.reap()).toBe(1)
    expect(meta(await store.get('chat_item', row.id))['state']).toBe('stopped')
  })

  it("a routine's card left working after its app closed is ended after ORPHAN_ROUTINE_MS", async () => {
    let clock = T0
    const store = new Store(':memory:', () => clock)
    cleanups.push(() => store.close())
    const m = manager(store, () => clock)
    const row = await store.upsert('chat_item', { id: 'rt-x', kind: 'helper', text: 'routine', meta: JSON.stringify({ label: 'Morning brief', state: 'working', startedAt: clock, routine: { id: 'x' } }) })
    clock += ORPHAN_ANY_MS + 1
    expect(await m.reap()).toBe(0)
    clock = T0 + ORPHAN_ROUTINE_MS + 1
    expect(await m.reap()).toBe(1)
    expect(meta(await store.get('chat_item', row.id))['state']).toBe('stopped')
  })
})

describe("project agent rows nobody follows", () => {
  it('a row marked working that arrives after start (another device wrote it, then went away) is closed once its chat is quiet', async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const agents = new ProjectAgentRows({ store, state: () => ({ running: false, waiting: [] }), checkMs: 20, resumeGraceMs: 0, sweepMs: 30 })
    cleanups.push(() => agents.dispose())
    await agents.restore()
    await store.upsert('chat_item', { kind: 'agent', text: 'All done.', meta: JSON.stringify({ chat: 'c9' }) })
    await store.upsert('chat_item', { id: 'pa-c9', kind: 'helper', text: 'brief', meta: JSON.stringify({ id: 'pa-c9', label: 'P', state: 'working', projectChat: 'c9', startedAt: Date.now() }) })
    const deadline = Date.now() + 3000
    while (Date.now() < deadline && meta(await store.get('chat_item', 'pa-c9'))['state'] === 'working') await new Promise((r) => setTimeout(r, 30))
    expect(meta(await store.get('chat_item', 'pa-c9'))['state']).toBe('done')
  })
})

describe('mini-apps reach learned apps like small apps', () => {
  it("a read-only learned-app tool runs without a card; one that changes things asks; one not granted is refused", async () => {
    const store = new Store(':memory:')
    cleanups.push(() => store.close())
    const apps = new MiniAppStore({ store })
    const made = await apps.create(
      {
        name: 'Inbox board',
        description: 'Reads the site',
        icon: 'grid',
        permissions: ['webapp_run:Site/read', 'webapp_run:Site/post', 'apps_run:GMAIL_FETCH_EMAILS', 'apps_run:GMAIL_SEND_EMAIL'],
        subscribe: [],
        refreshMinutes: 0,
        files: {
          'index.html': '<!doctype html><html><head><title>Inbox</title></head><body><ul class="list" id="list"></ul><script src="app.js"></script></body></html>',
          'app.js': "async function load(){const a=await agent.call('webapp_run',{app:'Site',tool:'read'});const b=await agent.call('apps_run',{slug:'GMAIL_FETCH_EMAILS'});document.getElementById('list').textContent=JSON.stringify([a,b])};load()",
        },
      },
      { by: 'agent', profile: '' },
    )
    if (!made.ok) throw new Error(made.why)
    const asked: string[] = []
    const ran: string[] = []
    const host = new MiniAppHost({
      apps,
      onRowsChange: (listener) => store.onChange(listener),
      runTool: async (_app: MiniAppRow, tool: string, args: JsonObject) => {
        ran.push(`${tool}:${String(args['tool'] ?? args['slug'])}`)
        return '[]'
      },
      approve: async (_app, summary) => {
        asked.push(summary)
        return true
      },
      reads: (tool, args) => (tool === 'webapp_run' ? args['tool'] === 'read' : null),
      host: plainHost(),
    })
    await host.start()
    cleanups.push(() => host.stop())
    const session = host.openSession(made.app.id, () => undefined, 'window')!
    expect(await host.handle(session, { op: 'call', id: 1, tool: 'webapp_run', args: { app: 'Site', tool: 'read' } })).toMatchObject({ ok: true })
    expect(await host.handle(session, { op: 'call', id: 2, tool: 'apps_run', args: { slug: 'GMAIL_FETCH_EMAILS' } })).toMatchObject({ ok: true })
    expect(asked).toEqual([])
    expect(await host.handle(session, { op: 'call', id: 3, tool: 'webapp_run', args: { app: 'Site', tool: 'post' } })).toMatchObject({ ok: true })
    expect(await host.handle(session, { op: 'call', id: 4, tool: 'apps_run', args: { slug: 'GMAIL_SEND_EMAIL' } })).toMatchObject({ ok: true })
    expect(asked.length).toBe(2)
    expect(await host.handle(session, { op: 'call', id: 5, tool: 'webapp_run', args: { app: 'Site', tool: 'delete' } })).toMatchObject({ ok: false })
    expect(await host.handle(session, { op: 'call', id: 6, tool: 'apps_run', args: { slug: 'GMAIL_DELETE_MESSAGE' } })).toMatchObject({ ok: false })
    expect(ran).toEqual(['webapp_run:read', 'apps_run:GMAIL_FETCH_EMAILS', 'webapp_run:post', 'apps_run:GMAIL_SEND_EMAIL'])
  })
})
