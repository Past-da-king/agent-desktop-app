/**
 * apps_connected lists every working account (23 Oct 2026). With a Composio Connect key (ck_) the listing asked only
 * about the built-in popular apps, so three Fathom accounts that worked through apps_run never showed. The reply
 * shapes below are the ones Composio Connect sends (COMPOSIO_MANAGE_CONNECTIONS per toolkit, COMPOSIO_SEARCH_TOOLS
 * with toolkit_connection_statuses, COMPOSIO_MULTI_EXECUTE_TOOL), cut down to what matters.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ProfileStore } from '../src/main/apps/profiles'
import { AppsService } from '../src/main/apps/service'
import { ConnectedAppsFile, LearnedStore } from '../src/main/apps/store'
import { appTools } from '../src/main/tools/apps'
import { testContext, toolNamed } from './support'

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-apps-every-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The person's accounts on the Composio side: gmail is a popular app, fathom is not. */
const SERVER: Record<string, Array<{ id: string; status: string; alias?: string }>> = {
  gmail: [{ id: 'gmail_lamb-coigue', status: 'active', alias: 'me@example.com' }],
  fathom: [
    { id: 'fathom_spink-fany', status: 'active', alias: 'work notes' },
    { id: 'fathom_avower-retina', status: 'active', alias: 'team notes' },
    { id: 'fathom_third-one', status: 'active', alias: 'personal notes' },
  ],
}

function connect(): { fetchImpl: typeof fetch; asked: string[][] } {
  const asked: string[][] = []
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    if (body.id === undefined) return new Response('', { status: 202 })
    let result: unknown = { protocolVersion: '2025-06-18' }
    if (body.method === 'tools/list') result = { tools: [{ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', inputSchema: { properties: { tools: { items: { properties: { account: {} } } } } } }] }
    if (body.method === 'tools/call') {
      const name = body.params?.name
      const args = body.params?.arguments ?? {}
      let data: unknown = {}
      if (name === 'COMPOSIO_MANAGE_CONNECTIONS') {
        const names = (args['toolkits'] as Array<{ name: string }>).map((t) => t.name)
        asked.push(names)
        data = { results: Object.fromEntries(names.map((n) => [n, { toolkit: n, accounts: SERVER[n] ?? [] }])) }
      } else if (name === 'COMPOSIO_SEARCH_TOOLS') {
        data = {
          results: [{ index: 1, use_case: 'fathom list meetings', primary_tool_slugs: ['FATHOM_LIST_MEETINGS'], toolkits: ['fathom'] }],
          toolkit_connection_statuses: [
            { toolkit: 'fathom', description: 'AI meeting assistant', has_active_connection: true, accounts: [{ id: 'fathom_avower-retina', user_info: { items: [] } }] },
            { toolkit: 'fireflies', description: 'Another notetaker', has_active_connection: false, accounts: [] },
          ],
        }
      } else if (name === 'COMPOSIO_MULTI_EXECUTE_TOOL') {
        data = { results: [{ response: { successful: true, data: { items: [{ title: 'Wins of the Week' }] } } }] }
      }
      result = { content: [{ type: 'text', text: JSON.stringify({ successful: true, data }) }] }
    }
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`, { status: 200 })
  }) as typeof fetch
  return { fetchImpl, asked }
}

function service(fetchImpl: typeof fetch, profiles?: ProfileStore): AppsService {
  return new AppsService({
    secrets: { get: (name) => (name === 'composioKey' ? 'ck_test' : null), set: () => undefined, delete: () => undefined },
    file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
    learned: new LearnedStore(join(dir, 'learned.json')),
    ...(profiles === undefined ? {} : { profiles }),
    openExternal: async () => undefined,
    fetchImpl,
  })
}

async function listed(apps: AppsService): Promise<string> {
  return toolNamed(appTools(apps), 'apps_connected').run({}, testContext())
}

describe('apps_connected lists every working account (Composio Connect key)', () => {
  it('after an action ran in Fathom, its three accounts are listed, and still are after a restart', async () => {
    const { fetchImpl } = connect()
    const apps = service(fetchImpl)
    const run = await toolNamed(appTools(apps), 'apps_run').run({ slug: 'FATHOM_LIST_MEETINGS', arguments: {}, account: 'fathom_spink-fany' }, testContext())
    expect(run).toContain('Wins of the Week')
    const out = await listed(apps)
    for (const id of ['fathom_spink-fany', 'fathom_avower-retina', 'fathom_third-one', 'gmail_lamb-coigue']) expect(out).toContain(`account ${id}`)
    // A new start reads the same file: Fathom is asked about again without being used first.
    const again = await listed(service(connect().fetchImpl))
    expect(again).toContain('account fathom_third-one')
  })

  it('a tool search that reports a working Fathom connection makes it listed', async () => {
    const { fetchImpl } = connect()
    const apps = service(fetchImpl)
    await toolNamed(appTools(apps), 'apps_find_tools').run({ query: 'fathom list meetings' }, testContext())
    const out = await listed(apps)
    expect(out).toContain('account fathom_spink-fany')
    expect(out).not.toContain('fireflies')
  })

  it('an app a profile holds an account of is asked about', async () => {
    const { fetchImpl, asked } = connect()
    const profiles = new ProfileStore(join(dir, 'profiles.json'), () => `p${Math.random().toString(36).slice(2, 6)}`)
    profiles.create('Work', [{ id: 'fathom_spink-fany', app: 'fathom', label: 'work notes' }])
    const out = await listed(service(fetchImpl, profiles))
    expect(out).toContain('account fathom_avower-retina')
    expect(asked.flat()).toContain('fathom')
  })

  it('says a Connect listing covers the apps it was asked about, never that an app is not connected', async () => {
    const out = await listed(service(connect().fetchImpl))
    expect(out).toContain('account gmail_lamb-coigue')
    expect(out).toContain('apps_find_tools with its name shows it')
  })
})
