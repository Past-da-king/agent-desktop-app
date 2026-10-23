import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ConnectBackend, RestBackend, identity, keyKind } from '../src/main/apps/composio'
import { AppGuard, candidates, isWrite } from '../src/main/apps/guard'
import { AppsService, COMPOSIO_SECRET, NO_KEY } from '../src/main/apps/service'
import { ConnectedAppsFile, LearnedStore } from '../src/main/apps/store'
import { appTools } from '../src/main/tools/apps'
import { testContext, toolNamed } from './support'

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

/** A fake of Composio's REST API: no network. Accounts and keys are what the test sets. */
function fakeComposio(options: { header?: string; key?: string } = {}) {
  const header = options.header ?? 'x-api-key'
  const key = options.key ?? 'ak_test'
  const calls: Call[] = []
  const state = {
    accounts: [] as Array<Record<string, unknown>>,
    executed: [] as Array<{ slug: string; body: unknown }>,
    authConfigs: [] as Array<Record<string, unknown>>,
  }
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push({ method, url: url.toString(), headers, body })
    const json = (status: number, value: unknown): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (headers[header] !== key) return json(401, { error: { message: 'No authentication provided' } })
    const path = url.pathname.replace('/api/v3.1', '')
    if (path === '/toolkits') return json(200, { items: [] })
    if (path === '/connected_accounts' && method === 'GET') return json(200, { items: state.accounts })
    if (path.startsWith('/connected_accounts/') && method === 'DELETE') {
      const id = path.split('/').pop()
      state.accounts = state.accounts.filter((a) => a['id'] !== id)
      return json(200, {})
    }
    if (path === '/auth_configs' && method === 'GET') return json(200, { items: state.authConfigs })
    if (path === '/auth_configs' && method === 'POST') {
      const created = { id: 'ac_1', toolkit: { slug: 'gmail' }, status: 'ENABLED' }
      state.authConfigs.push(created)
      return json(200, { auth_config: created })
    }
    if (path === '/connected_accounts/link') return json(200, { redirect_url: 'https://connect.example/sign-in' })
    if (path === '/tools') return json(200, { items: [{ slug: 'GMAIL_FETCH_EMAILS', description: 'Fetch emails', input_parameters: { type: 'object' } }] })
    if (path.startsWith('/tools/execute/')) {
      state.executed.push({ slug: path.split('/').pop() ?? '', body })
      return json(200, { successful: true, data: { messages: ['hello'] } })
    }
    return json(404, { error: { message: 'not found' } })
  }) as typeof fetch
  return { fetchImpl, calls, state }
}

function account(id: string, slug: string, email: string, status = 'ACTIVE'): Record<string, unknown> {
  return { id, status, alias: null, toolkit: { slug }, data: { email } }
}

let dir = ''
let secretValues: Map<string, string>
const secrets = {
  get: (name: string) => secretValues.get(name) ?? null,
  set: (name: string, value: string) => void secretValues.set(name, value),
  delete: (name: string) => void secretValues.delete(name),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-apps-'))
  secretValues = new Map()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function service(fetchImpl: typeof fetch, opened: string[] = []): AppsService {
  return new AppsService({
    secrets,
    file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
    learned: new LearnedStore(join(dir, 'learned-apps.json')),
    openExternal: async (url) => {
      opened.push(url)
    },
    fetchImpl,
    pollMs: 5,
    waitMs: 500,
  })
}

describe('Composio keys', () => {
  it('tells the kind of key from how it looks', () => {
    expect(keyKind('ak_123')).toBe('project')
    expect(keyKind('uak_123')).toBe('user')
    expect(keyKind('oak_123')).toBe('org')
    expect(keyKind('ck_123')).toBe('consumer')
    expect(keyKind('  ')).toBe('')
  })

  it('works out the right header when the key is not where its look suggests', async () => {
    const fake = fakeComposio({ header: 'x-user-api-key', key: 'ak_really_user' })
    const rest = new RestBackend('ak_really_user', 'u1', fake.fetchImpl)
    expect(await rest.verify()).toBeNull()
    await rest.accounts()
    const last = fake.calls[fake.calls.length - 1]
    expect(last?.headers['x-user-api-key']).toBe('ak_really_user')
  })

  it('refuses a key Composio does not accept, and does not store it', async () => {
    const fake = fakeComposio({ key: 'ak_good' })
    const apps = service(fake.fetchImpl)
    const res = await apps.setKey('ak_wrong')
    expect(res.ok).toBe(false)
    expect(res.message).toContain('did not accept')
    expect(secretValues.has(COMPOSIO_SECRET)).toBe(false)
  })

  it('stores a good key in the secrets module only, never in its own file', async () => {
    const fake = fakeComposio({ key: 'ak_good' })
    const apps = service(fake.fetchImpl)
    expect((await apps.setKey('ak_good')).ok).toBe(true)
    expect(secretValues.get(COMPOSIO_SECRET)).toBe('ak_good')
    apps.setRules('acc1', { read: 'allow', change: 'never' })
    expect(readFileSync(join(dir, 'connected-apps.json'), 'utf8')).not.toContain('ak_good')
    expect((await apps.status()).keyKind).toBe('project')
  })
})

describe('Composio accounts', () => {
  it('lists accounts with who they are signed in as and their rules', async () => {
    const fake = fakeComposio()
    fake.state.accounts = [account('a1', 'gmail', 'work@example.com'), account('a2', 'slack', '', 'INITIATED')]
    secretValues.set(COMPOSIO_SECRET, 'ak_test')
    const apps = service(fake.fetchImpl)
    apps.setRules('a1', { read: 'ask', change: 'never' })
    const status = await apps.status()
    expect(status.accounts).toHaveLength(2)
    expect(status.accounts[0]).toMatchObject({ id: 'a1', app: 'gmail', appName: 'Gmail', label: 'work@example.com', status: 'active', rules: { read: 'ask', change: 'never' } })
    expect(status.accounts[1]?.status).toBe('pending')
    expect(status.accounts[1]?.label).toBe('Slack workspace a2')
  })

  it('connecting opens the sign-in link in the browser and waits until the new account is active', async () => {
    const fake = fakeComposio()
    secretValues.set(COMPOSIO_SECRET, 'ak_test')
    const opened: string[] = []
    const apps = service(fake.fetchImpl, opened)
    const started = await apps.begin('gmail')
    expect(opened).toEqual(['https://connect.example/sign-in'])
    expect((await apps.status()).connecting).toEqual(['gmail'])
    setTimeout(() => {
      fake.state.accounts.push(account('new1', 'gmail', 'me@example.com'))
    }, 20)
    expect(await started.wait()).toBe('connected')
    expect((await apps.status()).connecting).toEqual([])
    const link = fake.calls.find((c) => c.url.endsWith('/connected_accounts/link'))
    expect(link?.body).toMatchObject({ auth_config_id: 'ac_1' })
  })

  it('gives up waiting after the time limit', async () => {
    const fake = fakeComposio()
    secretValues.set(COMPOSIO_SECRET, 'ak_test')
    const apps = service(fake.fetchImpl)
    const started = await apps.begin('gmail')
    expect(await started.wait()).toBe('timeout')
  })

  it('disconnects an account and forgets its rules', async () => {
    const fake = fakeComposio()
    fake.state.accounts = [account('a1', 'gmail', 'work@example.com')]
    secretValues.set(COMPOSIO_SECRET, 'ak_test')
    const apps = service(fake.fetchImpl)
    apps.setRules('a1', { read: 'never', change: 'never' })
    await apps.disconnect('a1')
    expect(fake.state.accounts).toHaveLength(0)
    expect(apps.rulesFor('a1')).toEqual({ read: 'allow', change: 'allow' })
  })

  it('reads who an account is from the places apps keep it', () => {
    expect(identity({ data: { email: 'a@example.com' } })).toBe('a@example.com')
    expect(identity({ user_info: { team: 'Design team' } })).toBe('Design team')
    expect(identity({ data: { authed_user: { name: 'sam' } } })).toBe('sam')
  })
})

describe('the rules gate', () => {
  it('knows reads from changes by the action name', () => {
    expect(isWrite('GMAIL_SEND_EMAIL', 'gmail')).toBe(true)
    expect(isWrite('GMAIL_FETCH_EMAILS', 'gmail')).toBe(false)
    expect(isWrite('GOOGLECALENDAR_CREATE_EVENT', 'googlecalendar')).toBe(true)
    expect(isWrite('SLACK_ADD_REACTION', 'slack')).toBe(true)
    expect(candidates('MICROSOFT_TEAMS_SEND_MESSAGE')).toEqual(['microsoft', 'microsoft_teams'])
  })

  const accounts = [
    { id: 'w', app: 'gmail', status: 'ACTIVE', label: 'work@example.com' },
    { id: 'p', app: 'gmail', status: 'ACTIVE', label: 'me@example.com' },
  ]

  it('never: refuses without asking', async () => {
    const guard = new AppGuard({
      rulesFor: (id) => (id === 'w' ? { read: 'never', change: 'never' } : { read: 'allow', change: 'ask' }),
      accountsFor: async () => accounts,
    })
    let asked = 0
    const ctx = testContext({ approve: async () => ((asked += 1), true) })
    const v = await guard.check(ctx, ['GMAIL_FETCH_EMAILS'], 'w', '{}')
    expect(v.refuse).toContain('never reads anything')
    expect(asked).toBe(0)
  })

  it('with no account named, holds the action to the strictest account of that app', async () => {
    const guard = new AppGuard({
      rulesFor: (id) => (id === 'p' ? { read: 'ask', change: 'ask' } : { read: 'allow', change: 'allow' }),
      accountsFor: async () => accounts,
    })
    const summaries: string[] = []
    const ctx = testContext({ approve: async (summary) => (summaries.push(summary), false) })
    const v = await guard.check(ctx, ['GMAIL_FETCH_EMAILS'], null, '{}')
    expect(summaries).toHaveLength(1)
    expect(v.refuse).toContain('declined')
  })

  it('an account picked by its label runs with that account id', async () => {
    const guard = new AppGuard({ rulesFor: () => ({ read: 'allow', change: 'allow' }), accountsFor: async () => accounts })
    const v = await guard.check(testContext(), ['GMAIL_SEND_EMAIL'], 'me@example.com', '{}')
    expect(v).toEqual({ account: 'p' })
  })
})

describe('the apps_* tools', () => {
  it('without a key every tool says to add one in Connections', async () => {
    const tools = appTools(service(fakeComposio().fetchImpl))
    expect(tools.map((t) => t.spec.name)).toEqual(['apps_connected', 'apps_find_tools', 'apps_run', 'apps_connect'])
    for (const tool of tools) {
      expect(await tool.run({ slug: 'GMAIL_FETCH_EMAILS', arguments: {}, toolkit: 'gmail', query: 'x', reason: 'x' }, testContext())).toBe(NO_KEY)
    }
    expect(NO_KEY).toContain('Connections')
  })

  it('apps_run reads straight away under the default rules and passes the account', async () => {
    const fake = fakeComposio()
    fake.state.accounts = [account('a1', 'gmail', 'work@example.com')]
    secretValues.set(COMPOSIO_SECRET, 'ak_test')
    const run = toolNamed(appTools(service(fake.fetchImpl)), 'apps_run')
    const out = await run.run({ slug: 'GMAIL_FETCH_EMAILS', arguments: { max: 3 } }, testContext())
    expect(out).toContain('hello')
    // The only Gmail account is picked by id, so one connected from the phone or the dashboard works too.
    expect(fake.state.executed[0]?.body).toEqual({ user_id: expect.any(String), arguments: { max: 3 }, connected_account_id: 'a1' })
  })

  it('apps_run sends without a card, asks before deleting (a no means nothing happens), and asks every change when the person set Ask me', async () => {
    const fake = fakeComposio()
    fake.state.accounts = [account('a1', 'gmail', 'work@example.com')]
    secretValues.set(COMPOSIO_SECRET, 'ak_test')
    const apps = service(fake.fetchImpl)
    const run = toolNamed(appTools(apps), 'apps_run')
    const asked: string[] = []
    const no = testContext({ approve: async (summary) => (asked.push(summary), false) })
    await run.run({ slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'x@example.com' } }, no)
    expect(asked).toEqual([])
    expect(fake.state.executed).toHaveLength(1)
    const out = await run.run({ slug: 'GMAIL_MOVE_TO_TRASH', arguments: { message_id: 'm1' } }, no)
    expect(out).toContain('declined')
    expect(asked).toHaveLength(1)
    expect(fake.state.executed).toHaveLength(1)
    apps.setRules('a1', { read: 'allow', change: 'ask' })
    expect(await run.run({ slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'x@example.com' } }, no)).toContain('declined')
    expect(fake.state.executed).toHaveLength(1)
  })

  it('apps_connect asks first, then opens the sign-in and waits', async () => {
    const fake = fakeComposio()
    secretValues.set(COMPOSIO_SECRET, 'ak_test')
    const opened: string[] = []
    const connect = toolNamed(appTools(service(fake.fetchImpl, opened)), 'apps_connect')
    const questions: string[] = []
    setTimeout(() => fake.state.accounts.push(account('n1', 'gmail', 'me@example.com')), 30)
    const out = await connect.run(
      { toolkit: 'gmail', reason: 'so I can read your invoices' },
      testContext({ ask: async (q) => (questions.push(q), 'Connect') }),
    )
    expect(questions[0]).toBe('Connect Gmail so I can read your invoices?')
    expect(opened).toHaveLength(1)
    expect(out).toContain('connected now')
  })
})

describe('Composio Connect (ck_ keys over MCP)', () => {
  it('initialises, then lists accounts through COMPOSIO_MANAGE_CONNECTIONS', async () => {
    const methods: string[] = []
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      if (headers['x-consumer-api-key'] !== 'ck_test') return new Response('{}', { status: 401 })
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } }
      methods.push(body.params?.name ?? body.method)
      if (body.id === undefined) return new Response('', { status: 202 })
      const result =
        body.method === 'tools/call'
          ? { content: [{ type: 'text', text: JSON.stringify({ successful: true, data: { results: { gmail: { accounts: [{ id: 'c1', status: 'active', email: 'me@example.com' }] } } } }) }] }
          : { protocolVersion: '2025-06-18' }
      // Their server answers as a server-sent event stream.
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200 })
    }) as typeof fetch
    const backend = new ConnectBackend('ck_test', fetchImpl)
    const list = await backend.accounts(['gmail'])
    expect(list).toEqual([{ id: 'c1', app: 'gmail', status: 'ACTIVE', label: 'me@example.com' }])
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'COMPOSIO_MANAGE_CONNECTIONS'])
  })
})
