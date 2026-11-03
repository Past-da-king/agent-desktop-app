/**
 * Projects (Ayanda, 21 Oct 2026): one main agent in the main thread, projects with chats of their own, messages
 * between them, helpers in the project's profile, the main thread's New chat carrying on with a summary, and old
 * chats kept under "Earlier chats". On the real Runner, HelperManager and Store with a local fake AI server.
 */
import { memoryTools } from '../src/main/tools/memory'
import { testContext, toolNamed } from './support'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

// The fake project folder C:\Work\Acme is "on this computer" for these tests.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: (path: string) => path.startsWith('C:\\Work') || real.existsSync(path) }
})

import { DEFAULT_SETTINGS, EARLIER_CHATS_PROJECT, MAIN_CHAT, providerFor, type ChatItem, type JsonObject, type MemoryRow, type Settings } from '@agent/core'

import { startFakeAi, type FakeAi, type FakeReply } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { ProfileStore } from '../src/main/apps/profiles'
import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { COMPRESS_SYSTEM, MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'
import { adoptEarlierChats } from '../src/main/projects/earlier'
import { HelperManager } from '../src/main/runtime/helpers'
import { FOCUS_LINE, buildSystemPrompt } from '../src/main/runtime/prompt'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { sourceOfChat } from '../src/renderer/lib/source'
import { projectAskProgram } from '../src/renderer/openui/ask'
import { renderSource } from '../src/renderer/openui/lang'
import { singleEmoji } from '../src/renderer/lib/projects'
import { hashFor, parseHash } from '../src/renderer/state/route'
import { secretsView, settingsView } from './support'

let store: Store | null = null
let fake: FakeAi | null = null
const runners: Runner[] = []
const closers: Array<() => void | Promise<unknown>> = []

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  for (const close of closers.splice(0)) await close()
  await sleep(30)
  store?.close()
  store = null
  await fake?.close()
  fake = null
})

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false, agentName: 'Nova' }

function lastText(body: JsonObject): string {
  const list = Array.isArray(body['messages']) ? body['messages'] : []
  const last = list[list.length - 1] as { content?: unknown } | undefined
  const content = last?.content
  return typeof content === 'string' ? content : JSON.stringify(content ?? '')
}

function meta(row: ChatItem | undefined): Record<string, unknown> {
  return row === undefined ? {} : (JSON.parse(row.meta) as Record<string, unknown>)
}

function chatOf(row: ChatItem): string {
  const value = meta(row)['chat']
  return typeof value === 'string' ? value : MAIN_CHAT
}

function make(): { runner: Runner; db: Store } {
  store ??= new Store(':memory:')
  const db = store
  let runner: Runner | null = null
  const settings = settingsView({ ...DEFAULT_SETTINGS, ...READY })
  runner = new Runner({
    store: db,
    settings,
    secrets: secretsView('test-key'),
    tools: buildToolset({
      store: db,
      projects: {
        post: async (chat, text, via) => {
          await runner?.receive(chat, text, via)
        },
        state: (chat) => runner?.state(chat) ?? { running: false, waiting: [] },
        agentName: () => 'Nova',
      },
    }),
    providerFactory: () => (fake === null ? null : providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true })),
    timeZone: 'UTC',
  })
  runners.push(runner)
  return { runner, db }
}

describe('the main agent and project chats', () => {
  it('starts a chat in a project with a brief, and the project chat writes back to the main thread', async () => {
    fake = await startFakeAi((body): FakeReply => {
      const last = lastText(body)
      if (last.includes('START IT')) return { toolCalls: [{ name: 'project_chat_start', input: { project: 'acme', brief: 'PROJECT BRIEF count the overdue invoices' } }] }
      if (last.includes('REPORT BACK')) return { text: 'Main heard: 3 overdue.' }
      if (last.includes('PROJECT BRIEF')) return { toolCalls: [{ name: 'message_main', input: { message: 'REPORT BACK 3 invoices are overdue' } }] }
      return { text: 'ok' }
    })
    const { runner, db } = make()
    const project = await db.upsert('project', { name: 'Acme finance', description: 'Getting Acme paid.', icon: { glyph: 'building', color: 'ocean' }, path: 'C:\\Work\\Acme', profile: '', hidden: false, chats: [] })

    await runner.send('START IT please, on Acme')
    await waitFor(async () => (await db.list('chat_item')).some((row) => row.kind === 'agent' && row.text.includes('Main heard')), 8_000)

    const chats = (await db.get('project', project.id))?.chats ?? []
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatch(/^pc[a-z0-9]{16}$/)
    const all = await db.list('chat_item')
    // The project chat shows the brief as a message from the main agent, and ran with the project in its prompt.
    const brief = all.find((row) => row.kind === 'user' && chatOf(row) === chats[0])
    expect(brief?.text).toBe('PROJECT BRIEF count the overdue invoices')
    expect(meta(brief)['via']).toMatchObject({ from: 'main', name: 'Nova' })
    const projectTurn = fake.requests.find((request) => lastText(request.body).includes('PROJECT BRIEF'))
    const system = JSON.stringify((projectTurn?.body['messages'] as Array<{ role: string; content: unknown }> | undefined)?.find((m) => m.role === 'system')?.content ?? '')
    expect(JSON.parse(system) as string).toContain('You are working in the project "Acme finance"')
    expect(JSON.parse(system) as string).toContain('Its folder is C:\\Work\\Acme')
    expect(lastText(projectTurn?.body ?? {})).toContain('[From Nova, the main agent]')
    // Its message lands in the main thread, labelled with the project, and the main agent acts on it.
    const back = all.find((row) => row.kind === 'user' && chatOf(row) === MAIN_CHAT && row.text.includes('REPORT BACK'))
    expect(meta(back)['via']).toMatchObject({ from: 'project', name: 'Acme finance', chat: chats[0] })
    const mainTurn = fake.requests.find((request) => lastText(request.body).includes('REPORT BACK'))
    expect(lastText(mainTurn?.body ?? {})).toContain('[From project Acme finance')
    // Questions and approvals in a project chat carry its chat id (the side panel's approvals list reads it).
    expect(all.filter((row) => chatOf(row) === chats[0]).every((row) => meta(row)['chat'] === chats[0])).toBe(true)
    await waitFor(() => !runner.state(MAIN_CHAT).running && !runner.state(chats[0] ?? '').running, 8_000)
  }, 15_000)

  it('a helper started from a project chat works in the project profile', async () => {
    fake = await startFakeAi(() => ({ text: 'done' }))
    store = new Store(':memory:')
    const profiles = new ProfileStore(null)
    const made = profiles.create('Acme work')
    if (!made.ok) throw new Error(made.message)
    const chat = 'pcacme00000001'
    await store.upsert('project', { name: 'Acme', description: '', icon: { glyph: 'folder', color: 'iris' }, path: '', profile: made.value.id, hidden: false, chats: [chat] })
    const manager = new HelperManager({
      store,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake?.url ?? '', allowHttp: true }),
      workerTools: buildWorkerToolset({ store }),
      deliver: async () => undefined,
      profiles,
    })
    closers.push(() => manager.stopAll())
    await manager.delegate([{ label: 'Site', brief: 'Check the site' }], false, { chat })
    await manager.delegate([{ label: 'Main', brief: 'Check something' }])
    const helpers = (await store.list('chat_item')).filter((row) => row.kind === 'helper')
    expect(meta(helpers.find((row) => meta(row)['label'] === 'Site'))['profileId']).toBe(made.value.id)
    expect(meta(helpers.find((row) => meta(row)['label'] === 'Main'))['profileId']).toBe('general')
    await waitFor(() => manager.live().length === 0, 8_000)
  })
})

describe('making a project from the chat', () => {
  it('shows a card with the project, and Create makes it with the folder the agent found', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'acme-'))
    fake = await startFakeAi((body): FakeReply => {
      const last = lastText(body)
      if (last.includes('MAKE IT')) return { toolCalls: [{ name: 'project_create', input: { name: 'Acme relaunch', path: folder, description: 'The new acme.example.', icon: 'globe', color: 'teal' } }] }
      if (last.includes('MAKE A SECOND')) return { toolCalls: [{ name: 'project_create', input: { name: 'Second', path: folder } }] }
      if (last.includes('MAKE A MISSING')) return { toolCalls: [{ name: 'project_create', input: { name: 'Missing', path: join(folder, 'nope') } }] }
      return { text: 'ok' }
    })
    const { runner, db } = make()

    const sending = runner.send('MAKE IT in my folder')
    const card = await waitFor(async () => (await db.list('chat_item')).find((row) => row.kind === 'question'), 5_000)
    expect(meta(card)['card']).toMatchObject({ kind: 'project', name: 'Acme relaunch', path: folder, folderNew: false, profile: 'General', icon: { glyph: 'globe', color: 'teal' } })
    expect(meta(card)['options']).toEqual(['Create', 'Change'])
    expect(await db.list('project')).toHaveLength(0)
    await runner.answer(card?.id ?? '', 'Create')
    await sending
    const projects = await db.list('project')
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ name: 'Acme relaunch', path: folder, description: 'The new acme.example.', hidden: false, chats: [] })

    // No makes nothing; a folder that is not there is sent back to be found first, with no card.
    const second = runner.send('MAKE A SECOND one')
    const ask = await waitFor(async () => (await db.list('chat_item')).find((row) => row.kind === 'question' && meta(row)['answer'] === ''), 5_000)
    await runner.answer(ask?.id ?? '', 'No')
    await second
    await runner.send('MAKE A MISSING one')
    expect(await db.list('project')).toHaveLength(1)
    expect((await db.list('chat_item')).filter((row) => row.kind === 'question')).toHaveLength(2)
    const missing = fake.requests.find((request) => lastText(request.body).includes('There is no folder at'))
    expect(missing).toBeDefined()
    await waitFor(() => !runner.state(MAIN_CHAT).running, 8_000)
  }, 15_000)
})

describe('New chat in the main thread', () => {
  it('carries on with a summary of the conversation, handed over once, and still files it', async () => {
    fake = await startFakeAi(() => ({ text: 'Answered.' }))
    const { runner, db } = make()
    const index = new ChatIndex(':memory:')
    closers.push(() => index.close())
    const memory = new MemoryService({
      store: db,
      index,
      upkeep: new UpkeepFile(null),
      complete: async (system) => (system === COMPRESS_SYSTEM ? '**Working on**\n- SUMMARY the Durban trip, flights picked' : JSON.stringify({ title: 'Durban', summary: 'Planned Durban.', memories: [] })),
    })
    await db.upsert('chat_item', { kind: 'user', text: 'Plan my Durban trip for Friday please, flights and a guesthouse', meta: '{}' })
    await db.upsert('chat_item', { kind: 'agent', text: 'The 06:05 SkyHop is the best value.', meta: '{}' })

    const result = await memory.newChat({ chat: MAIN_CHAT, from: MAIN_CHAT })
    expect(result.saving).toBe(true)
    await waitFor(async () => meta((await db.get('chat_item', result.dividerId ?? '')) ?? undefined)['compress'] === 'done', 3_000)
    await memory.idle()
    const divider = await db.get('chat_item', result.dividerId ?? '')
    expect(meta(divider ?? undefined)).toMatchObject({ divider: true, compress: 'done', memory: { status: 'done' } })
    expect(meta(divider ?? undefined)['chat']).toBeUndefined()

    await runner.send('And the guesthouse?')
    await runner.send('Thanks')
    const first = fake.requests.find((request) => lastText(request.body).includes('And the guesthouse?'))
    expect(lastText(first?.body ?? {})).toContain('SUMMARY the Durban trip')
    expect(lastText(first?.body ?? {})).toContain('The user started fresh in this chat')
    // The old turns are out of context; the summary stands in for them, once.
    expect(JSON.stringify(first?.body)).not.toContain('06:05 SkyHop')
    const second = fake.requests.find((request) => lastText(request.body).includes('Thanks'))
    expect(lastText(second?.body ?? {})).not.toContain('started fresh')
    expect(meta((await db.get('chat_item', result.dividerId ?? '')) ?? undefined)['carried']).toBe(true)
    await waitFor(() => !runner.state(MAIN_CHAT).running, 8_000)
  })
})

describe('chats from before projects', () => {
  it('go under a hidden Earlier chats project; project chats and the main thread stay where they are', async () => {
    store = new Store(':memory:')
    await store.upsert('chat_item', { kind: 'user', text: 'old', meta: JSON.stringify({ chat: 'cold00000001' }) })
    await store.upsert('chat_item', { kind: 'user', text: 'older', meta: JSON.stringify({ chat: 'cold00000002' }) })
    await store.upsert('chat_item', { kind: 'user', text: 'project', meta: JSON.stringify({ chat: 'pcnew00000001' }) })
    await store.upsert('chat_item', { kind: 'user', text: 'main', meta: '{}' })
    expect(await adoptEarlierChats(store, false)).toBe(2)
    expect(await store.get('project', EARLIER_CHATS_PROJECT)).toMatchObject({ name: 'Earlier chats', hidden: true, chats: ['cold00000001', 'cold00000002'] })
    expect(await adoptEarlierChats(store, false)).toBe(0)
    await store.upsert('chat_item', { kind: 'user', text: 'late', meta: JSON.stringify({ chat: 'cold00000003' }) })
    expect(await adoptEarlierChats(store, true)).toBe(0)
  })
})

describe('the prompt', () => {
  const base = { settings: { ...DEFAULT_SETTINGS, agentName: 'Nova' }, now: new Date(Date.UTC(2026, 9, 21, 12)), platform: 'win32', goals: [], tasks: [], timeZone: 'UTC' }
  const note = (id: string, title: string, project?: string): MemoryRow => ({ id, createdAt: 1, updatedAt: 1, title, body: `${title} body`, kind: 'decision', topics: 'acme', pinned: false, source: 'user', ...(project === undefined ? {} : { project }) })

  it('in a project chat: the project, its folder and profile, its own memory first, and the focus rule', () => {
    const text = buildSystemPrompt({
      ...base,
      memories: [note('m1', 'Acme calls over R 10,000', 'p1'), note('m2', 'Acme statement in general')],
      latestUserText: 'what about acme invoices',
      role: 'main',
      project: { id: 'p1', name: 'Acme finance', description: 'Getting Acme paid.', path: 'C:\\Work\\Acme', profile: 'Work' },
    })
    expect(text).toContain('THIS PROJECT')
    expect(text).toContain('Its folder is C:\\Work\\Acme')
    expect(text).toContain('Its profile is Work')
    expect(text).toContain('ACME FINANCE PROJECT MEMORY')
    expect(text.indexOf('Acme calls over R 10,000')).toBeLessThan(text.indexOf('BACKGROUND MEMORIES'))
    expect(text).toContain(FOCUS_LINE)
  })

  it('a project chat and its helpers are told to keep the project memory, decisions updated never deleted', () => {
    const project = { id: 'p1', name: 'Acme finance', description: 'Getting Acme paid.', path: 'C:\\Work\\Acme', profile: 'Work' }
    const main = buildSystemPrompt({ ...base, memories: [], latestUserText: 'go', role: 'main', project })
    expect(main).toContain("PROJECT MEMORY: what you save here is Acme finance's own memory")
    expect(main).toContain('"About Acme finance" page')
    expect(main).toContain('Never delete a decision')
    const helper = buildSystemPrompt({ ...base, memories: [], latestUserText: 'check invoices', role: 'helper', helper: { label: 'Invoices', brief: 'check invoices' }, project })
    expect(helper).toContain('You are working for the project "Acme finance". Its folder is C:\\Work\\Acme.')
    expect(helper).toContain('PROJECT MEMORY')
    const plain = buildSystemPrompt({ ...base, memories: [], latestUserText: 'hi', role: 'main' })
    expect(plain).not.toContain('PROJECT MEMORY:')
  })

  it('an agent cannot delete project memory: it is closed and kept', async () => {
    const db = new Store(':memory:')
    const tools = memoryTools(db)
    const page = await db.upsert('memory', { title: 'Use Astro', body: 'Decided 21 Oct.', kind: 'decision', topics: '', pinned: false, source: 'agent', project: 'p1' })
    const out = await toolNamed(tools, 'memory_update').run({ id: page.id, delete: true, reason: 'old' }, testContext())
    expect(out).toContain('never deleted')
    expect((await db.get('memory', page.id))?.status).toBe('closed')
    const loose = await db.upsert('memory', { title: 'Scratch', body: 'x', kind: 'fact', topics: '', pinned: false, source: 'agent' })
    expect(await toolNamed(tools, 'memory_update').run({ id: loose.id, delete: true }, testContext())).toContain('Deleted')
    db.close()
  })

  it('nothing in the main prompt tells the agent to raise old things: memories, the day page, goals and tasks are background', () => {
    const text = buildSystemPrompt({
      ...base,
      memories: [{ ...note('w', 'Where we are'), id: 'where-we-are', pinned: true }, note('m2', 'Acme statement')],
      goals: [{ id: 'g1', createdAt: 1, title: 'Ship the site', why: '', status: 'open' }],
      latestUserText: 'when does the acme statement come',
      role: 'main',
    })
    expect(text).toContain(FOCUS_LINE)
    expect(text).not.toContain('pick up from it')
    expect(text).toContain('not news to tell the user')
    expect(text).toContain('do not list them or remind the user of them unless they ask')
    expect(text).toContain('never recite them or raise them unprompted')
  })

  it('in the main thread: the projects there are and how to hand work to them', () => {
    const text = buildSystemPrompt({ ...base, memories: [], latestUserText: 'hi', role: 'main', projectNames: ['Acme finance', 'Acme'] })
    expect(text).toContain('PROJECTS: Acme finance, Acme.')
    expect(text).toContain('project_chat_start')
    expect(text).not.toContain('THIS PROJECT')
  })
})

describe('in the window', () => {
  const project = { id: 'p1', createdAt: 1, name: 'Acme', description: '', icon: { glyph: 'building', color: 'ocean' as const }, path: '', profile: '', hidden: false, chats: ['pcx0000001'] }

  it('says where a chat lives, for the approvals panel', () => {
    expect(sourceOfChat('pcx0000001', [], [project])).toEqual({ kind: 'project', name: 'Acme', icon: project.icon, projectId: 'p1' })
    expect(sourceOfChat(MAIN_CHAT, [], [project])).toMatchObject({ kind: 'main', projectId: null, icon: null })
  })

  it('draws the project card as OpenUI: the project, its folder and profile, then Create, Change and No', () => {
    const source = projectAskProgram({ name: 'Acme', description: 'The site.', path: 'C:\\Sites\\acme', folderNew: false, profile: 'Work' }, ['Create', 'Change'])
    const root = renderSource(source).root
    expect(root?.type).toBe('Card')
    expect(source).toContain('C:\\\\Sites\\\\acme')
    expect(source.match(/Button\(/g)).toHaveLength(3)
    expect(source).toContain('"No"')
  })

  it('routes to a project page and takes one emoji as an icon', () => {
    expect(parseHash('#/project/p1')).toEqual({ page: 'project', id: 'p1' })
    expect(hashFor({ page: 'project', id: 'p1' })).toBe('#/project/p1')
    expect(parseHash('#/project/../x')).toBeNull()
    expect(singleEmoji('\u{1F3E1}')).toBe('\u{1F3E1}')
    expect(singleEmoji('abc')).toBe('')
    expect(singleEmoji('')).toBe('')
  })
})
