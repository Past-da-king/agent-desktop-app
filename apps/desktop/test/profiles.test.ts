import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type AgentProfileInfo, type JsonObject, type Settings, type Tool } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { RestBackend, toolkitChoice, type AppAccount } from '../src/main/apps/composio'
import { AppGuard } from '../src/main/apps/guard'
import { BASE_PARTITION, GENERAL_ID, ProfileStore, cleanName, partitionFor } from '../src/main/apps/profiles'
import { AppsService } from '../src/main/apps/service'
import { ConnectedAppsFile, LearnedStore } from '../src/main/apps/store'
import { pickTab } from '../src/main/browser/tab-pick'
import { Store } from '../src/main/db'
import { HelperManager } from '../src/main/runtime/helpers'
import { buildSystemPrompt, helperProfileLines, profileLines } from '../src/main/runtime/prompt'
import { parseTasks } from '../src/main/tools/helpers'
import { gateTool } from '../src/main/tools/profile-gate'
import { profileTools } from '../src/main/tools/profiles'
import { secretsView, settingsView, testContext, toolNamed } from './support'

let dir = ''
let fake: FakeAi | null = null
let db: Store | null = null
const managers: HelperManager[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-profiles-'))
})

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAll()
  db?.close()
  db = null
  await fake?.close()
  fake = null
  rmSync(dir, { recursive: true, force: true })
})

let seq = 0
function store(path: string | null = join(dir, 'profiles.json')): ProfileStore {
  return new ProfileStore(path, () => `p${++seq}`)
}

const workGmail = { id: 'ca_work', app: 'gmail', label: 'me@work.example' }
const homeGmail = { id: 'ca_home', app: 'gmail', label: 'me@home.example' }
const slack = { id: 'ca_slack', app: 'slack', label: 'Example workspace' }
const accounts: AppAccount[] = [workGmail, homeGmail, slack].map((a) => ({ ...a, status: 'ACTIVE' }))

function guard(profileOf: (profile: string | undefined) => AgentProfileInfo | null): AppGuard {
  return new AppGuard({
    rulesFor: () => ({ read: 'allow', change: 'allow' }),
    accountsFor: async (apps) => accounts.filter((a) => apps.includes(a.app)),
    profileOf: (ctx) => profileOf(ctx.profile),
  })
}

describe('the profile store', () => {
  it('always has General first, with no accounts, and it cannot be renamed or deleted', () => {
    const profiles = store()
    const general = profiles.general()
    expect(general).toMatchObject({ id: GENERAL_ID, name: 'General', general: true, accounts: [], color: 'graphite' })
    expect(profiles.update(GENERAL_ID, { name: 'Other' }).ok).toBe(false)
    expect(profiles.update(GENERAL_ID, { accounts: [workGmail], learned: ['hn'] }).ok).toBe(true)
    expect(profiles.general().accounts).toEqual([])
    expect(profiles.general().learned).toEqual([])
    expect(profiles.remove(GENERAL_ID)).toBe(false)
    expect(profiles.setMember(GENERAL_ID, workGmail, true)).toBe(false)
  })

  it('makes profiles with clean names, a colour each and no duplicate names or accounts', () => {
    const profiles = store()
    const work = profiles.create('  Strat   Edge  work ', [workGmail, workGmail, slack])
    const home = profiles.create('Personal', [homeGmail])
    expect(work.ok && work.value.name).toBe('Strat Edge work')
    expect(work.ok && work.value.accounts.map((a) => a.id)).toEqual(['ca_work', 'ca_slack'])
    expect(work.ok && home.ok && work.value.color !== home.value.color).toBe(true)
    expect(profiles.create('personal').ok).toBe(false)
    expect(profiles.create('   ').ok).toBe(false)
    expect(cleanName('x'.repeat(80))).toHaveLength(40)
    expect(profiles.all().map((p) => p.name)).toEqual(['General', 'Strat Edge work', 'Personal'])
  })

  it('keeps profiles in profiles.json and reads them back', () => {
    const path = join(dir, 'profiles.json')
    const first = store(path)
    const made = first.create('Work', [workGmail], 'teal', '', ['hacker_news'])
    expect(made.ok).toBe(true)
    const saved = JSON.parse(readFileSync(path, 'utf8')) as AgentProfileInfo[]
    expect(saved.map((p) => p.name)).toEqual(['General', 'Work'])
    const again = store(path)
    expect(again.find('work')).toMatchObject({ name: 'Work', color: 'teal', accounts: [workGmail], learned: ['hacker_news'] })
  })

  it('moves accounts in and out, and a disconnected account or forgotten app leaves every profile', () => {
    const profiles = store()
    const a = profiles.create('Work')
    const b = profiles.create('Side project')
    if (!a.ok || !b.ok) throw new Error('not made')
    profiles.setMember(a.value.id, workGmail, true)
    profiles.setMember(b.value.id, workGmail, true)
    profiles.setLearned(b.value.id, 'shop', true)
    expect(profiles.profilesWith('ca_work').map((p) => p.name)).toEqual(['Work', 'Side project'])
    profiles.setMember(a.value.id, workGmail, false)
    expect(profiles.profilesWith('ca_work').map((p) => p.name)).toEqual(['Side project'])
    profiles.forgetAccount('ca_work')
    profiles.forgetLearned('shop')
    expect(profiles.find(b.value.id)).toMatchObject({ accounts: [], learned: [] })
  })
})

describe('browser sign-ins per profile', () => {
  it('gives General the original partition and every other profile its own', () => {
    expect(partitionFor(GENERAL_ID)).toBe('persist:agent-browser')
    expect(partitionFor(null)).toBe(BASE_PARTITION)
    expect(partitionFor('p1a2b')).toBe('persist:agent-browser-p1a2b')
    expect(partitionFor('../evil id')).toBe('persist:agent-browser-evilid')
  })

  it('lets a profile borrow another one\'s sign-ins, and deleting the lender gives it its own back', () => {
    const profiles = store()
    const work = profiles.create('Work')
    if (!work.ok) throw new Error('not made')
    const client = profiles.create('Client', [], undefined, work.value.id)
    if (!client.ok) throw new Error('not made')
    expect(profiles.partitionOf(client.value.id)).toBe(partitionFor(work.value.id))
    expect(profiles.partitionOf(work.value.id)).toBe(partitionFor(work.value.id))
    profiles.remove(work.value.id)
    expect(profiles.find(client.value.id)?.browser).toBe('')
    expect(profiles.partitionOf(client.value.id)).toBe(partitionFor(client.value.id))
  })

  it('hands the agent only a tab of its own partition', () => {
    const tabs = [
      { id: 't1', partition: BASE_PARTITION },
      { id: 't2', partition: 'persist:agent-browser-p1' },
      { id: 't3', partition: BASE_PARTITION },
    ]
    expect(pickTab(tabs, 't2', 'persist:agent-browser-p1')?.id).toBe('t2')
    expect(pickTab(tabs, 't2', BASE_PARTITION)?.id).toBe('t3')
    expect(pickTab(tabs, 't1', 'persist:agent-browser-p9')).toBeNull()
  })

  it('switches the browser to the helper profile partition before every browser tool, and back for the main agent', async () => {
    const profiles = store()
    const work = profiles.create('Work')
    if (!work.ok) throw new Error('not made')
    const used: string[] = []
    const open: Tool = { spec: { name: 'browser_open', description: '', schema: { type: 'object' } }, run: async () => 'opened' }
    const gated = gateTool(open, {
      profileOf: (ctx) => (ctx.profile === undefined ? null : profiles.find(ctx.profile)),
      partitionOf: (id) => profiles.partitionOf(id),
      usePartition: (p) => used.push(p),
    })
    await gated.run({ url: 'example.com' }, testContext({ profile: work.value.id }))
    await gated.run({ url: 'example.com' }, testContext())
    await gated.run({ url: 'example.com' }, testContext({ profile: GENERAL_ID }))
    expect(used).toEqual([partitionFor(work.value.id), BASE_PARTITION, BASE_PARTITION])
  })

  it('runs a learned app only inside a profile that has it, and files one a helper saves in its profile', async () => {
    const learned = new LearnedStore(join(dir, 'learned.json'))
    learned.save({ id: 'shop', name: 'Shop', startUrl: 'https://shop.example', about: '', tools: [], trusted: false, updatedAt: 0 })
    const profiles = store()
    const work = profiles.create('Work')
    if (!work.ok) throw new Error('not made')
    const deps = {
      profileOf: (ctx: { profile?: string }) => (ctx.profile === undefined ? null : profiles.find(ctx.profile)),
      partitionOf: (id: string | null) => profiles.partitionOf(id),
      learned,
      addLearned: (profileId: string, appId: string) => void profiles.setLearned(profileId, appId, true),
    }
    const run = gateTool({ spec: { name: 'webapp_run', description: '', schema: { type: 'object' } }, run: async () => 'ran' }, deps)
    const save = gateTool({ spec: { name: 'webapp_save', description: '', schema: { type: 'object' } }, run: async () => 'Saved Shop with 1 tool' }, deps)
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: work.value.id }))).toContain('not in your profile (Work)')
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: GENERAL_ID }))).toContain('not in your profile (General)')
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext())).toBe('ran')
    await save.run({ name: 'Shop' }, testContext({ profile: work.value.id }))
    expect(await run.run({ app: 'Shop', tool: 'x' }, testContext({ profile: work.value.id }))).toBe('ran')
  })
})

describe('connected apps inside a profile', () => {
  it('picks the one Gmail account a helper profile has, by itself', async () => {
    const profiles = store()
    const work = profiles.create('Work', [workGmail, slack])
    if (!work.ok) throw new Error('not made')
    const verdict = await guard((id) => (id === undefined ? null : profiles.find(id))).check(
      testContext({ profile: work.value.id }),
      ['GMAIL_FETCH_EMAILS'],
      null,
      '',
    )
    expect(verdict).toEqual({ account: 'ca_work' })
  })

  it('refuses an account outside the helper profile, and asks it to choose when the profile has two', async () => {
    const profiles = store()
    const work = profiles.create('Work', [workGmail])
    const both = profiles.create('Both', [workGmail, homeGmail])
    if (!work.ok || !both.ok) throw new Error('not made')
    const g = guard((id) => (id === undefined ? null : profiles.find(id)))
    const outside = await g.check(testContext({ profile: work.value.id }), ['GMAIL_SEND_EMAIL'], 'ca_home', '')
    expect(outside.refuse).toContain('not in your profile (Work)')
    const two = await g.check(testContext({ profile: both.value.id }), ['GMAIL_FETCH_EMAILS'], null, '')
    expect(two.refuse).toContain('has 2 Gmail accounts')
    const named = await g.check(testContext({ profile: both.value.id }), ['GMAIL_FETCH_EMAILS'], 'me@home.example', '')
    expect(named).toEqual({ account: 'ca_home' })
  })

  it('lets a helper in General use no connected app at all, while the main agent may use any account', async () => {
    const profiles = store()
    const g = guard((id) => (id === undefined ? null : profiles.find(id)))
    const general = await g.check(testContext({ profile: GENERAL_ID }), ['SLACK_SEND_MESSAGE'], null, '')
    expect(general.refuse).toContain('Your profile (General) has no Slack account')
    const mainAgent = await g.check(testContext(), ['GMAIL_FETCH_EMAILS'], 'ca_home', '')
    expect(mainAgent).toEqual({ account: 'ca_home' })
  })

  it('profile_create files only accounts that are really connected and says what it left out', async () => {
    const apps = new AppsService({
      secrets: { get: () => null, set: () => undefined, delete: () => undefined },
      file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
      learned: new LearnedStore(join(dir, 'learned.json')),
      profiles: store(),
      openExternal: async () => undefined,
    })
    apps.activeAccounts = async (slugs) => accounts.filter((a) => slugs.includes(a.app))
    const tool = toolNamed(profileTools(apps), 'profile_create')
    const out = await tool.run({ name: 'Job hunt', apps: ['gmail:me@home.example', 'linkedin'] }, testContext())
    expect(out).toContain('Made the profile Job hunt with Gmail me@home.example')
    expect(out).toContain('left out: linkedin')
    expect(apps.profiles.find('job hunt')?.accounts).toEqual([homeGmail])
    expect(await tool.run({ name: 'job hunt' }, testContext())).toContain('already a profile called Job hunt')
  })
})

describe('delegate with profiles', () => {
  it('reads a profile per task, or from the profiles list in task order', () => {
    expect(parseTasks([{ label: 'A', brief: 'do a', profile: 'Work' }, { label: 'B', brief: 'do b' }], ['', 'Personal'])).toEqual([
      { label: 'A', brief: 'do a', profile: 'Work' },
      { label: 'B', brief: 'do b', profile: 'Personal' },
    ])
  })

  it('starts nothing when a profile does not exist, and runs a helper inside the one it was given', async () => {
    const profiles = store()
    const work = profiles.create('Work', [workGmail])
    if (!work.ok) throw new Error('not made')
    const seen: Array<string | undefined> = []
    const whoami: Tool = {
      spec: { name: 'whoami', description: 'Says which profile.', schema: { type: 'object', properties: {} } },
      run: async (_input, ctx) => {
        seen.push(ctx.profile)
        return 'noted'
      },
    }
    fake = await startFakeAi((body: JsonObject) =>
      JSON.stringify(body['messages'] ?? []).includes('noted') ? { text: 'Done.' } : { toolCalls: [{ name: 'whoami', input: {} }] },
    )
    const fakeUrl = fake.url
    db = new Store(':memory:')
    const ready: Partial<Settings> = { ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }
    const delivered: string[] = []
    const manager = new HelperManager({
      store: db,
      settings: settingsView(ready),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fakeUrl, allowHttp: true }),
      workerTools: [whoami],
      deliver: (note) => void delivered.push(note),
      platform: 'linux',
      timeZone: 'UTC',
      profiles,
    })
    managers.push(manager)

    const refused = await manager.delegate([{ label: 'X', brief: 'do x', profile: 'Nope' }, { label: 'Y', brief: 'do y' }])
    expect(refused).toContain('No profile called "Nope"')
    expect(refused).toContain('Nothing was started')
    expect((await db.list('chat_item')).filter((r) => r.kind === 'helper')).toHaveLength(0)

    const started = await manager.delegate([{ label: 'Inbox', brief: 'read my work mail', profile: 'work' }])
    expect(started).toContain('(in Work)')
    await waitFor(async () => (delivered.length > 0 ? true : null))
    expect(seen).toEqual([work.value.id])
    const row = (await db.list('chat_item')).find((r) => r.kind === 'helper')
    expect(JSON.parse(row?.meta ?? '{}')).toMatchObject({ profile: 'Work', profileId: work.value.id })
    const system = JSON.stringify(fake.requests[0]?.body ?? {})
    expect(system).toContain('YOUR PROFILE: Work')
    expect(system).toContain('me@work.example (account ca_work)')
  })
})

describe('profile prompts', () => {
  const all: AgentProfileInfo[] = [
    { id: GENERAL_ID, name: 'General', color: 'graphite', accounts: [], learned: [], browser: '', general: true },
    { id: 'p1', name: 'Work', color: 'ocean', accounts: [workGmail, slack], learned: ['shop'], browser: '', general: false },
    { id: 'p2', name: 'Client', color: 'ember', accounts: [], learned: [], browser: 'p1', general: false },
  ]

  it('lists the profiles for the main agent and how to name one in delegate', () => {
    const lines = profileLines(all, { shop: 'Shop' }).join('\n')
    expect(lines).toContain('- Work: Gmail me@work.example, Slack Example workspace; learned apps: Shop')
    expect(lines).toContain("- Client: no accounts; browser sign-ins: Work's")
    expect(lines).toContain("- General: none of the user's accounts")
    expect(lines).toContain('`profile` in delegate')
    expect(lines).toContain('profile_create')
    const prompt = buildSystemPrompt({
      settings: DEFAULT_SETTINGS,
      now: new Date('2026-10-20T10:00:00Z'),
      platform: 'linux',
      memories: [],
      goals: [],
      tasks: [],
      latestUserText: 'hi',
      role: 'main',
      timeZone: 'UTC',
      profiles: all,
    })
    expect(prompt).toContain('PROFILES: every helper works inside exactly one')
  })

  it('tells a helper its profile, or that General has nothing', () => {
    expect(helperProfileLines(all[1] as AgentProfileInfo).join('\n')).toContain('Use ONLY these connected accounts: Gmail me@work.example (account ca_work)')
    expect(helperProfileLines(all[0] as AgentProfileInfo).join('\n')).toContain('none of the user\'s connected accounts')
  })
})

describe('Composio listing', () => {
  it('reads a toolkit with its logo and categories', () => {
    expect(
      toolkitChoice({ slug: 'GMAIL', name: 'Gmail', meta: { logo: 'https://logos.composio.dev/api/gmail', description: 'Mail', categories: [{ id: 'productivity', name: 'Productivity' }] } }),
    ).toEqual({ slug: 'gmail', name: 'Gmail', line: 'Mail', logo: 'https://logos.composio.dev/api/gmail', categories: ['Productivity'] })
    expect(toolkitChoice({ slug: 'x y' })).toBeNull()
  })

  it('lists every connected account across pages, whichever Composio user it hangs off, and runs it as that user', async () => {
    const pages: Record<string, unknown> = {
      '': { items: [{ id: 'a1', status: 'ACTIVE', toolkit: { slug: 'gmail' }, user_id: 'phone-user', data: { email: 'a@example.com' } }], next_cursor: 'c2' },
      c2: { items: [{ id: 'a2', status: 'ACTIVE', toolkit: { slug: 'slack' }, user_id: 'default', alias: 'Team' }], next_cursor: null },
    }
    const urls: string[] = []
    const bodies: unknown[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      urls.push(url.toString())
      if (url.pathname.endsWith('/connected_accounts')) return new Response(JSON.stringify(pages[url.searchParams.get('cursor') ?? '']), { status: 200 })
      bodies.push(JSON.parse(String(init?.body ?? '{}')))
      return new Response(JSON.stringify({ successful: true, data: {} }), { status: 200 })
    }) as typeof fetch
    const rest = new RestBackend('ak_test', 'agent-desktop-me', fetchImpl)
    const list = await rest.accounts()
    expect(list.map((a) => [a.id, a.label])).toEqual([
      ['a1', 'a@example.com'],
      ['a2', 'Team'],
    ])
    expect(urls.every((u) => !u.includes('user_ids'))).toBe(true)
    await rest.execute('GMAIL_FETCH_EMAILS', {}, 'a1')
    expect(bodies[0]).toMatchObject({ user_id: 'phone-user', connected_account_id: 'a1' })
  })
})

describe('apps_* tools for a helper', () => {
  it('refuse every Composio tool in General and apps outside the profile, and stay open for the main agent', async () => {
    const { appTools } = await import('../src/main/tools/apps')
    const apps = new AppsService({
      secrets: { get: (name) => (name === 'composioKey' ? 'ak_test' : null), set: () => undefined, delete: () => undefined },
      file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
      learned: new LearnedStore(join(dir, 'learned.json')),
      profiles: store(),
      openExternal: async () => undefined,
      fetchImpl: (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch,
    })
    const work = apps.profiles.create('Work', [workGmail])
    if (!work.ok) throw new Error('not made')
    const tools = appTools(apps)
    const find = toolNamed(tools, 'apps_find_tools')
    const connect = toolNamed(tools, 'apps_connect')
    expect(await find.run({ query: 'send', toolkit: 'gmail' }, testContext({ profile: GENERAL_ID }))).toContain('none of the person')
    expect(await find.run({ query: 'post', toolkit: 'slack' }, testContext({ profile: work.value.id }))).toContain('has no Slack account')
    expect(await connect.run({ toolkit: 'slack', reason: 'x' }, testContext({ profile: GENERAL_ID }))).toContain('cannot connect or use Slack')
    expect(await find.run({ query: 'send', toolkit: 'slack' }, testContext())).not.toContain('profile')
  })
})
