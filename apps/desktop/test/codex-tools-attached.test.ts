/**
 * The app's tools reach the model on every Codex (ChatGPT plan) run: the main chat, a project chat, a helper and a
 * routine. Runs the real Codex engine the app ships against a stand-in model server and reads the tools Codex
 * actually sends to the model.
 *
 * Bug of 23 Oct 2026: the tool server was attached, but Codex 0.163 deferred its tools behind a search inside its own
 * exec tool, so the model never saw delegate (or memory, tasks, browser...) and started Codex's own sub-agents, which
 * die with the turn. Helpers never appeared in the app.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type JsonObject, type Tool } from '@agent/core'

import { codexSettings } from '../src/main/runtime/cli-agent'
import { CliHost, type CliTurnRequest } from '../src/main/runtime/cli-host'
import { startToolServer } from '../src/main/runtime/mcp-server'

const MODEL = 'test-model'

/** Is the Codex engine for this computer installed (it ships with the app)? */
function engineInstalled(): boolean {
  try {
    createRequire(join(process.cwd(), 'package.json')).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)
    return true
  } catch {
    return false
  }
}

/** A model entry like the ChatGPT plan's current ones: code mode only, with tool search (the case that hid the tools). */
const CATALOG = {
  models: [
    {
      slug: MODEL,
      display_name: 'Test',
      description: 'Test model.',
      base_instructions: 'You are a test agent.',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low', description: 'low' }],
      shell_type: 'unified_exec',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      availability_nux: null,
      upgrade: null,
      model_messages: null,
      include_skills_usage_instructions: false,
      include_plugin_usage_instructions: false,
      include_apps_usage_instructions: false,
      default_reasoning_summary: 'none',
      support_verbosity: false,
      default_verbosity: null,
      apply_patch_tool_type: 'freeform',
      web_search_tool_type: 'text',
      truncation_policy: { mode: 'tokens', limit: 10000 },
      supports_image_detail_original: false,
      context_window: 272000,
      experimental_supported_tools: [],
      input_modalities: ['text'],
      supports_search_tool: true,
      tool_mode: 'code_mode_only',
      multi_agent_version: 'v2',
    },
  ],
}

function tool(name: string): Tool {
  return { spec: { name, description: `The ${name} tool.`, schema: { type: 'object', properties: { text: { type: 'string' } } } }, run: async () => 'ok' }
}

const APP_TOOLS = [tool('delegate'), tool('memory_search'), tool('task_add')]

/** Stands in for the model: answers every turn with "done" and keeps each request Codex sent. */
let model: Server
const requests: string[] = []
let home = ''
let project = ''
const saved: Record<string, string | undefined> = {}

beforeAll(async () => {
  model = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    req.on('end', () => {
      if (!(req.url ?? '').includes('/responses')) {
        res.writeHead(404)
        res.end('{}')
        return
      }
      requests.push(body)
      const event = (type: string, data: JsonObject) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
      const usage = { input_tokens: 1, input_tokens_details: null, output_tokens: 1, output_tokens_details: null, total_tokens: 2 }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(
        event('response.created', { response: { id: 'resp_1' } }) +
          event('response.output_item.done', { item: { type: 'message', role: 'assistant', id: 'msg_1', content: [{ type: 'output_text', text: 'done' }] } }) +
          event('response.completed', { response: { id: 'resp_1', usage } }),
      )
    })
  })
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve))
  const port = (model.address() as { port: number }).port
  home = mkdtempSync(join(tmpdir(), 'agent-codex-home-'))
  project = mkdtempSync(join(tmpdir(), 'agent-codex-project-'))
  const catalog = join(home, 'catalog.json')
  writeFileSync(catalog, JSON.stringify(CATALOG))
  // The person's own Codex home is never touched: this one points the engine at the stand-in model.
  writeFileSync(
    join(home, 'config.toml'),
    [
      'model_provider = "fake"',
      `model_catalog_json = ${JSON.stringify(catalog)}`,
      '[model_providers.fake]',
      'name = "fake"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      'env_key = "AGENT_TEST_MODEL_KEY"',
      '',
    ].join('\n'),
  )
  for (const key of ['CODEX_HOME', 'AGENT_TEST_MODEL_KEY']) saved[key] = process.env[key]
  process.env['CODEX_HOME'] = home
  process.env['AGENT_TEST_MODEL_KEY'] = 'test'
})

afterAll(async () => {
  await new Promise<void>((resolve) => model.close(() => resolve()))
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const dir of [home, project]) if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

function request(thread: string, folder?: string): CliTurnRequest {
  const signal = new AbortController().signal
  return {
    cli: 'codex',
    thread,
    tools: APP_TOOLS,
    system: 'You are the agent.',
    prompt: 'hi',
    model: MODEL,
    ...(folder === undefined ? {} : { folder }),
    context: { agentLabel: 'main', activity: async () => 0, updateActivity: async () => undefined, ask: async () => null, approve: async () => true, notify: async () => undefined, signal },
    signal,
    onEvent: async () => undefined,
    onCall: async () => undefined,
    onResult: async () => undefined,
  }
}

/** The app tools the model was told about in a request (Codex names them mcp__agent__<name>). */
function declared(body: string): string[] {
  return [...new Set([...body.matchAll(/mcp__agent__([a-z_]+)\(/g)].map((match) => match[1] ?? ''))].sort()
}

describe.skipIf(!engineInstalled())('Codex runs get the app tools, declared to the model', () => {
  const cases: Array<{ kind: string; thread: string; folder: boolean; expected: string[] }> = [
    { kind: 'the main chat', thread: 'main', folder: false, expected: ['delegate', 'memory_search', 'run_script', 'run_script_result', 'task_add'] },
    { kind: 'a project chat', thread: 'p1', folder: true, expected: ['delegate', 'memory_search', 'run_script', 'run_script_result', 'task_add'] },
    // A helper does not delegate further, and a routine has nobody to report to.
    { kind: 'a helper', thread: 'helper:h1', folder: true, expected: ['memory_search', 'run_script', 'run_script_result', 'task_add'] },
    { kind: 'a routine', thread: 'routine', folder: false, expected: ['memory_search', 'run_script', 'run_script_result', 'task_add'] },
  ]

  for (const each of cases) {
    it(`${each.kind}: every app tool it is given reaches the model, and Codex's own sub-agents do not`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agent-codex-work-'))
      const cli = new CliHost(dir, () => ({ ...DEFAULT_SETTINGS, shell: 'always' }), process.cwd())
      try {
        requests.length = 0
        const result = await cli.turn(request(each.thread, each.folder ? project : undefined))
        expect(result.error).toBeUndefined()
        expect(result.text).toBe('done')
        expect(requests.length).toBeGreaterThan(0)
        const body = requests[0] ?? ''
        expect(declared(body)).toEqual(each.expected)
        expect(body).not.toContain('spawn_agent')
      } finally {
        await cli.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 90_000)
  }

  it('without declaring them up front, Codex hides the app tools from the model (the bug this guards)', async () => {
    const { Codex } = await import('@openai/codex-sdk')
    const server = await startToolServer()
    const token = server.open({ tools: APP_TOOLS, context: request('main').context })
    const dir = join(home, 'raw')
    mkdirSync(dir, { recursive: true })
    try {
      const settings = codexSettings({ workDir: dir, access: 'free', model: MODEL, mcp: { url: server.url, token } })
      const servers = settings.config['mcp_servers'] as Record<string, Record<string, unknown>>
      const run = async (config: typeof settings.config): Promise<string> => {
        requests.length = 0
        const codex = new Codex({ env: { ...(process.env as Record<string, string>), AGENT_MCP_TOKEN: token }, config })
        await codex.startThread(settings.thread).run('hi')
        return requests[0] ?? ''
      }
      const { omit_tools_from: _left, ...deferred } = servers['agent'] ?? {}
      expect(declared(await run({ ...settings.config, mcp_servers: { agent: deferred } }))).toEqual([])
      expect(declared(await run(settings.config))).toContain('delegate')
    } finally {
      server.release(token)
      await server.close()
    }
  }, 120_000)
})
