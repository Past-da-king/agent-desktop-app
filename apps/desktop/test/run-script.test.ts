/**
 * Programmatic tool calling in the app (23 Oct 2026): run_script reaches every agent (the plan path through the
 * in-app tool server as well as the API loop), approvals and profile limits hold inside a script, every agent's
 * prompt says to batch, and project_update does the same change on many projects in one call.
 * These fail on 0.2.58, which had no run_script and a project_update for one project only.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, schema, str, withScriptTools, type JsonObject, type Settings, type Tool } from '@agent/core'

import { ProfileStore, GENERAL_ID } from '../src/main/apps/profiles'
import { AppsService } from '../src/main/apps/service'
import { ConnectedAppsFile, LearnedStore } from '../src/main/apps/store'
import { Store } from '../src/main/db'
import { scriptToolsForTurn, toolsForTurn } from '../src/main/runtime/cli-host'
import { startToolServer, type ToolServer } from '../src/main/runtime/mcp-server'
import { buildSystemPrompt } from '../src/main/runtime/prompt'
import { runFinished, runStarted } from '../src/main/runtime/run-detail'
import { describeCall } from '../src/main/runtime/runner'
import { appTools } from '../src/main/tools/apps'
import { coreTools } from '../src/main/tools/core'
import { gateTool } from '../src/main/tools/profile-gate'
import { projectTools } from '../src/main/tools/projects'
import { testContext, toolNamed } from './support'

let dir = ''
let server: ToolServer | null = null
let store: Store | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-run-script-'))
})

afterEach(async () => {
  await server?.close()
  server = null
  store?.close()
  store = null
  rmSync(dir, { recursive: true, force: true })
})

function runTool(tools: Tool[]): Tool {
  return toolNamed(withScriptTools(tools), 'run_script')
}

function plain(name: string, run: Tool['run']): Tool {
  return { spec: { name, description: name, schema: schema([], { id: str('id') }) }, run }
}

async function rpc(url: string, token: string, method: string, params: JsonObject = {}): Promise<JsonObject> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return ((await response.json()) as { result: JsonObject }).result
}

describe('run_script on the plan path (the in-app tool server)', () => {
  it('is listed, runs inner calls through the same tools, and shows each inner call in the trail', async () => {
    server = await startToolServer()
    const calls: string[] = []
    const results: string[] = []
    const memory = plain('memory_search', async (input) => `hits for ${String(input['id'])}: ${'LONG-PAGE '.repeat(500)}`)
    // Claude brings its own shell, so the model is not offered the app's; a script still reaches it.
    const shell = plain('shell_run', async () => 'ran')
    const token = server.open({
      tools: [memory],
      scriptTools: [memory, shell],
      context: testContext(),
      onCall: (call) => void calls.push(call.name),
      onResult: (call, text) => void results.push(`${call.name}:${text.length}`),
    })
    const listed = (await rpc(server.url, token, 'tools/list'))['tools'] as Array<{ name: string }>
    expect(listed.map((t) => t.name)).toEqual(['memory_search', 'run_script', 'run_script_result'])
    const out = await rpc(server.url, token, 'tools/call', {
      name: 'run_script',
      arguments: { code: `const a = await tools.memory_search({ id: 'x' }); const b = await tools.shell_run({}); return [a.length > 1000, b]` },
    })
    const text = (out['content'] as Array<{ text: string }>)[0]?.text ?? ''
    expect(text).toContain('Result: [true,"ran"]')
    expect(text).not.toContain('LONG-PAGE')
    expect(calls).toEqual(['run_script', 'memory_search', 'shell_run'])
    expect(results.map((r) => r.split(':')[0])).toEqual(['memory_search', 'shell_run', 'run_script'])
  })

  it('keeps the app shell and file tools for scripts in a Claude turn, and never the delegation tools', () => {
    const names = ['memory_search', 'shell_run', 'files_read', 'delegate', 'helper_steer']
    const tools = names.map((name) => plain(name, async () => ''))
    const request = { tools, thread: 'helper:1', cli: 'claude' as const }
    expect(toolsForTurn(request).map((t) => t.spec.name)).toEqual(['memory_search'])
    expect(scriptToolsForTurn(request).map((t) => t.spec.name)).toEqual(['memory_search', 'shell_run', 'files_read'])
  })
})

describe('the run_script row in the work trail', () => {
  it('shows the script, and lists every inner call with its arguments, ok or failed, and time; the model gets only the summary', async () => {
    const tools = [plain('project_update', async (input) => `${String(input['id'])}: done ${'DETAIL '.repeat(50)}`), plain('boom', async () => { throw new Error('kaput') })]
    const input: JsonObject = { code: `for (const id of ['a', 'b']) await tools.project_update({ id }); try { await tools.boom({}) } catch (e) {} return 'two set'` }
    const call = { t: 'call' as const, id: 'c1', name: 'run_script', input }
    expect(describeCall(call)).toBe('Ran a script')
    expect(runStarted(call)).toMatchObject({ kind: 'code', label: 'script', state: 'running', input: input['code'] })
    const result = await runTool(tools).run(input, testContext())
    expect(result).not.toContain('DETAIL')
    const record = runFinished(call, result, false, Date.now() - 50)
    expect(record?.state).toBe('ok')
    expect(record?.stdout).toContain('Result: two set')
    expect(record?.stdout).toContain('Tool calls inside the script (3):')
    expect(record?.stdout).toMatch(/ok {4} {2}project_update {2}\{"id":"a"\} {2}\d+ ms/)
    expect(record?.stdout).toMatch(/FAILED {2}boom {2}\{\} {2}\d+ ms/)
  })
})

describe('safety inside a script', () => {
  it('request_approval inside a script asks the person, waits, and a decline comes back as a decline', async () => {
    const asked: Array<{ summary: string; details?: string }> = []
    const ctx = testContext({
      approve: async (summary, details) => {
        asked.push({ summary, ...(details === undefined ? {} : { details }) })
        await new Promise((resolve) => setTimeout(resolve, 200))
        return false
      },
    })
    store = new Store(':memory:')
    const tools = coreTools({ store })
    const out = await runTool(tools).run({ code: `const a = await tools.request_approval({ summary: 'Delete 3 files', details: 'a, b, c' }); return a` }, ctx)
    expect(asked).toEqual([{ summary: 'Delete 3 files', details: 'a, b, c' }])
    expect(out).toContain('Result: The user declined.')
  })

  it('a helper script cannot use an app or a learned app outside its profile', async () => {
    const profiles = new ProfileStore(join(dir, 'profiles.json'), () => `p${Math.random().toString(36).slice(2, 6)}`)
    const learned = new LearnedStore(join(dir, 'learned.json'))
    learned.save({ id: 'shop', name: 'Shop', startUrl: 'https://shop.example', about: '', tools: [], trusted: false, updatedAt: 0 })
    const apps = new AppsService({
      secrets: { get: (name) => (name === 'composioKey' ? 'ak_test' : null), set: () => undefined, delete: () => undefined },
      file: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
      learned,
      profiles,
      openExternal: async () => undefined,
      fetchImpl: (async () => new Response(JSON.stringify({ items: [] }), { status: 200 })) as typeof fetch,
    })
    const work = apps.profiles.create('Work', [{ id: 'ca_work', app: 'gmail', label: 'me@work.example' }])
    if (!work.ok) throw new Error('not made')
    const webapp = gateTool(plain('webapp_run', async () => 'ran'), {
      profileOf: (c) => (c.profile === undefined ? null : profiles.find(c.profile)),
      partitionOf: (id) => profiles.partitionOf(id),
      learned,
    })
    const tools = [...appTools(apps), webapp]
    const code = `
      const slack = await tools.apps_find_tools({ query: 'post', toolkit: 'slack' });
      const shop = await tools.webapp_run({ app: 'Shop', tool: 'x' });
      return { slack, shop }`
    const helper = await runTool(tools).run({ code }, testContext({ profile: work.value.id }))
    expect(helper).toContain('has no Slack account')
    expect(helper).toContain('not in your profile (Work)')
    const general = await runTool(tools).run({ code }, testContext({ profile: GENERAL_ID }))
    expect(general).toContain('none of the person')
    // The main agent has no profile: the same script runs the learned app.
    const main = await runTool(tools).run({ code }, testContext())
    expect(main).toContain('"shop":"ran"')
  })
})

describe('project_update on many projects', () => {
  async function setup(): Promise<Tool> {
    store = new Store(':memory:')
    const icon = { glyph: 'folder', color: 'iris' as const }
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta']) {
      await store.upsert('project', { name, description: '', icon, path: '', profile: '', hidden: name === 'Delta', chats: [] })
    }
    const s = store
    return toolNamed(projectTools({ store: s, post: async () => undefined, state: () => ({ running: false, waiting: [] }), agentName: () => 'Nova' }), 'project_update')
  }

  it('"all" sets the same model on every project, hidden ones too, in one call with one short summary', async () => {
    const update = await setup()
    const out = await update.run({ project: 'all', main_model: 'big-model', helpers_model: 'fast-model' }, testContext())
    expect(out.split('\n')).toHaveLength(1)
    expect(out).toContain('Changed 4 projects')
    const rows = await store!.list('project')
    expect(rows.map((p) => p.ai?.main.model)).toEqual(['big-model', 'big-model', 'big-model', 'big-model'])
    expect(rows.map((p) => p.ai?.helpers.model)).toEqual(['fast-model', 'fast-model', 'fast-model', 'fast-model'])
  })

  it('a list changes only those, says which were not found, and refuses a rename for many', async () => {
    const update = await setup()
    const out = await update.run({ projects: ['alpha', 'Gamma', 'Nope'], description: 'Client work' }, testContext())
    expect(out).toContain('Changed 2 projects')
    expect(out).toContain('Not found: Nope')
    const rows = await store!.list('project')
    expect(rows.filter((p) => p.description === 'Client work').map((p) => p.name)).toEqual(['Alpha', 'Gamma'])
    expect(await update.run({ project: 'all', name: 'Same' }, testContext())).toContain('one project only')
    // One project still works as before.
    expect(await update.run({ project: 'Beta', main_model: 'm' }, testContext())).toBe('Beta: its agent on m.')
  })

  it('a bad argument for every project is said once', async () => {
    const update = await setup()
    expect(await update.run({ project: 'all', main_ai: 'No Such Account' }, testContext())).toMatch(/^No AI account called "No Such Account"/)
  })
})

describe('every agent is told to batch with run_script', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, grantedFolders: [] }
  const base = { settings, now: new Date('2026-10-23T08:00:00Z'), platform: 'win32', memories: [], goals: [], tasks: [], latestUserText: 'hi', timeZone: 'Africa/Johannesburg' }
  const project = { id: 'p1', name: 'Alpha', description: '', path: '', profile: 'General' }
  const generalProfile = { id: 'general', name: 'General', color: 'graphite' as const, accounts: [], learned: [], browser: '', general: true }
  it.each([
    ['main', {}],
    ['main without helpers', { canDelegate: false }],
    ['project chat', { project }],
    ['routine', { role: 'routine' as const, routineName: 'Morning' }],
    ['helper', { role: 'helper' as const, helper: { label: 'x', brief: 'y' }, profile: generalProfile }],
    ['project helper', { role: 'helper' as const, helper: { label: 'x', brief: 'y' }, profile: generalProfile, project }],
  ])('%s', (_name, patch) => {
    const prompt = buildSystemPrompt({ ...base, ...patch } as Parameters<typeof buildSystemPrompt>[0])
    expect(prompt).toContain('For any job with more than two similar calls, or any call whose result only feeds a decision, write one run_script instead of calling tools one by one.')
    expect(prompt).toContain('tools.$list() and tools.$describe(name)')
  })
})
