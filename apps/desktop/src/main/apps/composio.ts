/**
 * Composio with the person's OWN key (we never hold a key of ours). One Composio "user" per install;
 * every account the person connects hangs off it.
 *
 * Two ways in, chosen by the key, ported from reference phone tools/Composio.kt and ComposioConnect.kt:
 *   - a project, user or organisation key speaks Composio's REST API (backend.composio.dev);
 *   - a Composio Connect consumer key (ck_) only works on their MCP server, so the same operations go
 *     through its COMPOSIO_* tools there.
 * Both sit behind `ComposioBackend`, so the agent's tools and Connections do not care which.
 */
import type { ComposioKeyKind, JsonObject, JsonValue } from '@agent/core'

import { appName, POPULAR_APPS, workspaceLabel } from './catalog'

export const REST_BASE = 'https://backend.composio.dev/api/v3.1'
export const CONNECT_URL = 'https://connect.composio.dev/mcp'

/** One signed-in account of an app. Status is Composio's: ACTIVE, INITIATED, FAILED... */
export interface AppAccount {
  id: string
  app: string
  status: string
  label: string
}

export interface ComposioBackend {
  readonly kind: ComposioKeyKind
  /** Null when the key works, otherwise what Composio said, in plain words. */
  verify(): Promise<string | null>
  /** Every account; `apps` narrows it (the Connect server can only list apps it is asked about). */
  accounts(apps?: string[]): Promise<AppAccount[]>
  /** Starts connecting an app and returns the sign-in link the person opens. */
  connectLink(app: string): Promise<string>
  disconnect(account: AppAccount): Promise<void>
  /** The actions an app offers, as text for the model. */
  findTools(query: string, toolkit: string, limit: number): Promise<string>
  /** Runs one action. The text is what the model sees; `ok` false means it failed. */
  execute(slug: string, args: JsonObject, account: string | null): Promise<{ ok: boolean; text: string }>
}

export class ComposioError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export function keyKind(key: string): ComposioKeyKind {
  const k = key.trim()
  if (k === '') return ''
  if (k.startsWith('ck_')) return 'consumer'
  if (k.startsWith('uak_')) return 'user'
  if (k.startsWith('oak_') || k.startsWith('org_')) return 'org'
  return 'project'
}

export function backendFor(key: string, userId: string, fetchImpl: typeof fetch = fetch): ComposioBackend {
  return keyKind(key) === 'consumer' ? new ConnectBackend(key, fetchImpl) : new RestBackend(key, userId, fetchImpl)
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asText(value: unknown): string {
  return typeof value === 'string' && value !== 'null' ? value : ''
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function errorMessage(code: number, text: string): string {
  const said = asText(asObject(asObject(parse(text))['error'])['message'])
  return `Composio ${code}: ${said !== '' ? said : text.slice(0, 200)}`
}

/**
 * Who an account signed in as. Mail apps give an email; others (GitHub, Slack) a username, handle or
 * workspace name, under whatever key that app uses.
 */
export function identity(account: unknown): string {
  const keys = [
    'email', 'username', 'login', 'user_name', 'screen_name', 'handle', 'display_name', 'name',
    'team_name', 'workspace_name', 'workspace', 'team_domain', 'domain', 'enterprise_name', 'team_id',
  ]
  const pick = (value: unknown): string => {
    const o = asObject(value)
    for (const key of keys) {
      const found = asText(o[key])
      if (found !== '') return found
    }
    return ''
  }
  const a = asObject(account)
  const info = asObject(a['user_info'])
  const data = asObject(a['data'])
  const team = asText(info['team'])
  if (team !== '') return team
  for (const candidate of [info, info['user'], info['team'], data, data['team'], data['authed_user'], a['profile'], a['team'], a]) {
    const found = pick(candidate)
    if (found !== '') return found
  }
  return ''
}

// ---- REST: project, user and organisation keys ---------------------------------------------------

/**
 * Composio has a kind of key per header: a PROJECT key in x-api-key, a USER key in x-user-api-key, an
 * ORGANISATION key in x-org-api-key; user and org keys may also need the project (x-project-id). A key in
 * the wrong header is a 401, so the first call works out which this key is and every later call reuses it.
 */
export class RestBackend implements ComposioBackend {
  readonly kind: ComposioKeyKind
  private auth: Record<string, string> | null = null

  constructor(
    private readonly key: string,
    private readonly userId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base: string = REST_BASE,
  ) {
    this.kind = keyKind(key)
  }

  private guessHeader(): string {
    if (this.kind === 'user') return 'x-user-api-key'
    if (this.kind === 'org') return 'x-org-api-key'
    return 'x-api-key'
  }

  private headers(): Record<string, string> {
    return this.auth ?? { [this.guessHeader()]: this.key }
  }

  private async raw(url: string, headers: Record<string, string>, init: RequestInit = {}): Promise<{ code: number; text: string }> {
    const res = await this.fetchImpl(url, { ...init, headers: { ...headers, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) } })
    return { code: res.status, text: await res.text() }
  }

  /** A 401/403 on a key not yet proven: work out its real header once, then try again. */
  private async request(method: string, path: string, body?: JsonObject): Promise<Record<string, unknown>> {
    const once = async (): Promise<Record<string, unknown>> => {
      const init: RequestInit = { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
      const { code, text } = await this.raw(`${this.base}${path}`, this.headers(), init)
      if (code < 200 || code > 299) throw new ComposioError(errorMessage(code, text), code)
      return asObject(parse(text))
    }
    try {
      return await once()
    } catch (cause) {
      if (cause instanceof ComposioError && (cause.status === 401 || cause.status === 403) && this.auth === null) {
        if ((await this.verify()) === null) return once()
      }
      throw cause
    }
  }

  async verify(): Promise<string | null> {
    if (this.key.trim() === '') return 'No Composio key yet.'
    const probe = `${this.base}/toolkits?limit=1`
    let last = ''
    const ok = async (headers: Record<string, string>): Promise<boolean> => {
      const { code, text } = await this.raw(probe, headers)
      if (code >= 200 && code <= 299) {
        this.auth = headers
        return true
      }
      last = errorMessage(code, text)
      return false
    }
    const order =
      this.kind === 'user'
        ? ['x-user-api-key', 'x-api-key', 'x-org-api-key']
        : this.kind === 'org'
          ? ['x-org-api-key', 'x-api-key', 'x-user-api-key']
          : ['x-api-key', 'x-user-api-key', 'x-org-api-key']
    for (const header of order) {
      const plain = { [header]: this.key }
      if (await ok(plain)) return null
      // User and org keys can need the project spelled out: find it, then try again.
      let project = ''
      if (header === 'x-user-api-key') {
        const info = await this.raw(`${this.base}/auth/session/info`, plain)
        if (info.code >= 200 && info.code <= 299) {
          const p = asObject(asObject(parse(info.text))['project'])
          project = asText(p['nano_id']) || asText(p['id'])
        }
      } else if (header === 'x-org-api-key') {
        const list = await this.raw(`${this.base}/org/projects`, plain)
        if (list.code >= 200 && list.code <= 299) {
          const o = parse(list.text)
          const items = Array.isArray(o) ? o : asArray(asObject(o)['items']).length > 0 ? asArray(asObject(o)['items']) : asArray(asObject(o)['data'])
          const first = asObject(items[0])
          project = asText(first['nano_id']) || asText(first['id'])
        }
      }
      if (project !== '' && (await ok({ ...plain, 'x-project-id': project }))) return null
    }
    return `Composio did not accept that key (${last}). Use a key from your Composio project's Settings, API Keys.`
  }

  async accounts(apps?: string[]): Promise<AppAccount[]> {
    const query = new URLSearchParams({ user_ids: this.userId, limit: '200' })
    const res = await this.request('GET', `/connected_accounts?${query.toString()}`)
    const all = asArray(res['items']).map((item): AppAccount => {
      const c = asObject(item)
      const app = asText(asObject(c['toolkit'])['slug'])
      const id = asText(c['id'])
      const alias = asText(c['alias'])
      const label = alias || identity(c) || workspaceLabel(app, id) || appName(app)
      return { id, app, status: asText(c['status']).toUpperCase(), label }
    })
    return apps === undefined ? all : all.filter((a) => apps.includes(a.app))
  }

  /** Find or create a Composio-managed auth config for a toolkit. */
  private async authConfigFor(app: string): Promise<string> {
    const res = await this.request('GET', `/auth_configs?${new URLSearchParams({ toolkit_slug: app }).toString()}`)
    for (const item of asArray(res['items'])) {
      const a = asObject(item)
      const slug = asText(asObject(a['toolkit'])['slug'])
      if (slug.toLowerCase() === app && asText(a['status']) !== 'DISABLED') return asText(a['id'])
    }
    const created = await this.request('POST', '/auth_configs', {
      toolkit: { slug: app },
      auth_config: { type: 'use_composio_managed_auth' },
    })
    const id = asText(asObject(created['auth_config'])['id']) || asText(created['id'])
    if (id === '') throw new ComposioError(`Composio could not set up ${appName(app)}.`, 0)
    return id
  }

  async connectLink(app: string): Promise<string> {
    const res = await this.request('POST', '/connected_accounts/link', {
      auth_config_id: await this.authConfigFor(app),
      user_id: this.userId,
    })
    const link = asText(res['redirect_url'])
    if (!/^https:\/\//.test(link)) throw new ComposioError(`Composio returned no sign-in link for ${appName(app)}.`, 0)
    return link
  }

  async disconnect(account: AppAccount): Promise<void> {
    await this.request('DELETE', `/connected_accounts/${encodeURIComponent(account.id)}`)
  }

  async findTools(query: string, toolkit: string, limit: number): Promise<string> {
    const q = new URLSearchParams({ limit: String(limit) })
    if (toolkit !== '') q.set('toolkit_slug', toolkit)
    if (query !== '') q.set('query', query)
    const res = await this.request('GET', `/tools?${q.toString()}`)
    const tools = asArray(res['items']).map((item) => {
      const t = asObject(item)
      return {
        slug: asText(t['slug']),
        description: asText(t['description']).slice(0, 400),
        parameters: (t['input_parameters'] ?? {}) as JsonValue,
      }
    })
    if (tools.length === 0) return 'No matching actions. Try other words, or another toolkit.'
    return JSON.stringify(tools, null, 1).slice(0, 16_000)
  }

  async execute(slug: string, args: JsonObject, account: string | null): Promise<{ ok: boolean; text: string }> {
    const res = await this.request('POST', `/tools/execute/${encodeURIComponent(slug)}`, {
      user_id: this.userId,
      arguments: args,
      ...(account === null ? {} : { connected_account_id: account }),
    })
    const ok = res['successful'] !== false
    if (!ok) return { ok, text: `Error: ${asText(res['error']) || 'the action failed'}` }
    return { ok, text: JSON.stringify(res['data'] ?? res).slice(0, 20_000) }
  }
}

// ---- Composio Connect: consumer keys over MCP ----------------------------------------------------

/**
 * A minimal MCP streamable-HTTP client for connect.composio.dev. It is stateless on their side, so
 * "initialised for this key" is what we track; a failed call starts a fresh session once.
 */
export class ConnectBackend implements ComposioBackend {
  readonly kind: ComposioKeyKind = 'consumer'
  private session: string | null = null
  private ready = false
  private nextId = 1
  private protocol = '2025-06-18'

  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly url: string = CONNECT_URL,
  ) {}

  private async send(method: string, params: JsonObject, notify = false): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const body = notify ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', id, method, params }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-consumer-api-key': this.key,
      'mcp-protocol-version': this.protocol,
    }
    if (this.session !== null) headers['mcp-session-id'] = this.session
    const res = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(body) })
    const session = res.headers.get('mcp-session-id')
    if (session !== null && session !== '') this.session = session
    const text = await res.text()
    if (res.status < 200 || res.status > 299) {
      throw new ComposioError(`Composio Connect ${res.status}: ${res.headers.get('x-mcp-auth-failure-reason') ?? errorMessage(res.status, text)}`, res.status)
    }
    if (notify) return {}
    // The reply is plain JSON, or a server-sent event stream carrying it.
    const json = text.trimStart().startsWith('{')
      ? text
      : (text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .reverse()
          .find((line) => asObject(parse(line))['id'] === id) ?? '{}')
    const reply = asObject(parse(json))
    const error = asObject(reply['error'])
    if (Object.keys(error).length > 0) throw new ComposioError(asText(error['message']) || 'MCP error', 0)
    return asObject(reply['result'])
  }

  private async ensure(): Promise<void> {
    if (this.ready) return
    this.session = null
    const init = (version: string): JsonObject => ({
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'Agent', version: '1' },
    })
    try {
      this.protocol = '2025-06-18'
      await this.send('initialize', init(this.protocol))
    } catch (cause) {
      if (cause instanceof ComposioError && (cause.status === 401 || cause.status === 403)) throw cause
      this.protocol = '2025-03-26'
      this.session = null
      await this.send('initialize', init(this.protocol))
    }
    await this.send('notifications/initialized', {}, true)
    this.ready = true
  }

  /** One Composio Connect tool call, as the text it returned. */
  async call(name: string, args: JsonObject): Promise<string> {
    const once = async (): Promise<string> => {
      await this.ensure()
      const r = await this.send('tools/call', { name, arguments: args })
      const text = asArray(r['content'])
        .map((block) => asText(asObject(block)['text']))
        .filter((t) => t !== '')
        .join('\n')
      return (r['isError'] === true ? 'Error: ' : '') + (text !== '' ? text : JSON.stringify(r).slice(0, 4000))
    }
    try {
      return await once()
    } catch (cause) {
      if (cause instanceof ComposioError && (cause.status === 401 || cause.status === 403)) throw cause
      this.ready = false
      return once()
    }
  }

  private async data(name: string, args: JsonObject): Promise<Record<string, unknown>> {
    const text = await this.call(name, args)
    const o = asObject(parse(text))
    if (Object.keys(o).length === 0) throw new ComposioError(text.replace(/^Error: /, '').slice(0, 300), 0)
    if (o['successful'] === false) throw new ComposioError(asText(o['error']) || 'Composio Connect failed', 0)
    return asObject(o['data'])
  }

  async verify(): Promise<string | null> {
    try {
      this.ready = false
      await this.ensure()
      return null
    } catch (cause) {
      return `Composio Connect did not accept that key (${cause instanceof Error ? cause.message : String(cause)}).`
    }
  }

  async accounts(apps?: string[]): Promise<AppAccount[]> {
    const slugs = [...new Set(apps ?? POPULAR_APPS.map((a) => a.slug))]
    const out: AppAccount[] = []
    // Composio caps how many toolkits one call may carry; ask in chunks.
    for (let i = 0; i < slugs.length; i += 50) {
      const chunk = slugs.slice(i, i + 50)
      const res = await this.data('COMPOSIO_MANAGE_CONNECTIONS', {
        toolkits: chunk.map((name) => ({ name, action: 'list' })),
      })
      const results = asObject(res['results'])
      for (const app of chunk) {
        for (const item of asArray(asObject(results[app])['accounts'])) {
          const a = asObject(item)
          const id = asText(a['id'])
          out.push({
            id,
            app,
            status: asText(a['status']).toLowerCase() === 'active' ? 'ACTIVE' : 'INITIATED',
            label: asText(a['alias']) || identity(a) || workspaceLabel(app, id) || appName(app),
          })
        }
      }
    }
    return out
  }

  async connectLink(app: string): Promise<string> {
    const res = await this.data('COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [{ name: app, action: 'add' }] })
    const link = asText(asObject(asObject(res['results'])[app])['redirect_url'])
    if (!/^https:\/\//.test(link)) throw new ComposioError(`Composio did not return a sign-in link for ${appName(app)}.`, 0)
    return link
  }

  async disconnect(account: AppAccount): Promise<void> {
    await this.data('COMPOSIO_MANAGE_CONNECTIONS', {
      toolkits: [{ name: account.app, action: 'remove', account_id: account.id }],
    })
  }

  async findTools(query: string, toolkit: string, _limit: number): Promise<string> {
    const useCase = toolkit === '' ? query : `${query} (in ${appName(toolkit)}, toolkit ${toolkit})`
    return (await this.call('COMPOSIO_SEARCH_TOOLS', { queries: [{ use_case: useCase }] })).slice(0, 16_000)
  }

  async execute(slug: string, args: JsonObject, account: string | null): Promise<{ ok: boolean; text: string }> {
    const text = await this.call('COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: slug, arguments: args }],
      ...(account === null ? {} : { account }),
    })
    return { ok: !text.startsWith('Error:'), text: text.slice(0, 20_000) }
  }
}
