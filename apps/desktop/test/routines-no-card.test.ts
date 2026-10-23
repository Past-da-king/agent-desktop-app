/**
 * Routines that make routines (rule of 23 Oct 2026): a scheduler routine that creates one `at` routine per calendar
 * meeting raised one approval card per meeting. Creating, changing and deleting a routine raise no card, on every
 * path a tool reaches the model (the agent loop, the MCP tool server for plan runs, a script's inner calls), while a
 * call that sends something in the same run still asks.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, withScriptTools, type JsonObject, type Settings, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { startToolServer, type ToolServer } from '../src/main/runtime/mcp-server'
import { Runner, type RunnerDeps } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { APP_ACTION_CHANNELS, appActionTools } from '../src/main/tools/app-actions'
import { routineTools } from '../src/main/tools/routines'
import { secretsView, settingsView, testContext, toolNamed } from './support'

const NOW = new Date(2026, 9, 20, 10, 0, 0, 0)
let store: Store | null = null
let fake: FakeAi | null = null
let server: ToolServer | null = null
const runners: Runner[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  await server?.close()
  server = null
  store?.close()
  store = null
  await fake?.close()
  fake = null
})

function meeting(n: number): JsonObject {
  return { name: `Meeting: CRM INDUCTION SESSION ${n}`, kind: 'at', spec: `2026-10-2${n}T09:00`, prompt: 'Brief me on this meeting.' }
}

function counting(): { approvals: string[]; ctx: ReturnType<typeof testContext> } {
  const approvals: string[] = []
  return { approvals, ctx: testContext({ approve: async (summary) => (approvals.push(summary), true) }) }
}

describe('routines that make routines raise no card', () => {
  it('routine_create, routine_update and routine_delete ask nothing', async () => {
    store = new Store(':memory:')
    const tools = routineTools(store, () => NOW)
    const { approvals, ctx } = counting()
    for (const n of [1, 2, 3]) expect(await toolNamed(tools, 'routine_create').run(meeting(n), ctx)).toContain('created')
    const rows = await store.list('trigger')
    expect(rows).toHaveLength(3)
    expect(await toolNamed(tools, 'routine_update').run({ id: rows[0]?.id ?? '', spec: '2026-10-21T10:00' }, ctx)).toContain('now runs once at 2026-10-21 10:00')
    expect(await toolNamed(tools, 'routine_update').run({ id: rows[1]?.id ?? '', enabled: false }, ctx)).toContain('switched off')
    expect(await toolNamed(tools, 'routine_delete').run({ id: rows[2]?.id ?? '' }, ctx)).toBe('Deleted.')
    expect(approvals).toEqual([])
    const left = await store.list('trigger')
    expect(left.map((row) => row.spec).sort()).toEqual(['2026-10-21T10:00', '2026-10-22T09:00'])
    expect(left.find((row) => row.spec === '2026-10-22T09:00')?.enabled).toBe(false)
  })

  it('inside run_script: three routine_create calls, no card', async () => {
    store = new Store(':memory:')
    const run = toolNamed(withScriptTools(routineTools(store, () => NOW)), 'run_script')
    const { approvals, ctx } = counting()
    const code = `const out = []; for (const n of [1, 2, 3]) out.push(await tools.routine_create({ name: 'Meeting ' + n, kind: 'at', spec: '2026-10-2' + n + 'T09:00', prompt: 'Brief me.' })); return out.every((t) => t.includes('created'))`
    expect(await run.run({ code }, ctx)).toContain('Result: true')
    expect(approvals).toEqual([])
    expect(await store.list('trigger')).toHaveLength(3)
  })

  it('over the MCP tool server (plan runs): no card', async () => {
    store = new Store(':memory:')
    server = await startToolServer()
    const { approvals, ctx } = counting()
    const token = server.open({ tools: routineTools(store, () => NOW), context: ctx })
    const call = async (name: string, args: JsonObject): Promise<string> => {
      const response = await fetch(server?.url ?? '', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      })
      const result = ((await response.json()) as { result: { content: Array<{ text: string }> } }).result
      return result.content[0]?.text ?? ''
    }
    expect(await call('routine_create', meeting(1))).toContain('created')
    expect(await call('run_script', { code: `return await tools.routine_create(${JSON.stringify(meeting(2))})` })).toContain('created')
    expect(approvals).toEqual([])
    expect(await store.list('trigger')).toHaveLength(2)
  })

  it('a routine run makes its routines with no card, and a send in the same run still asks', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? {
            toolCalls: [
              { name: 'routine_create', input: meeting(1) },
              { name: 'routine_create', input: meeting(2) },
              { name: 'routine_create', input: meeting(3) },
              { name: 'request_approval', input: { summary: 'Send the meeting list to the team', details: 'Three meetings.' } },
            ],
          }
        : { text: 'Done.' },
    )
    store = new Store(':memory:')
    const database = store
    const ready: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true }
    const deps: RunnerDeps = {
      store: database,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...ready }),
      secrets: secretsView('test-key'),
      tools: buildToolset({ store: database, now: () => NOW }),
      providerFactory: (_current, apiKey) => (fake === null ? null : providerFor({ provider: 'openai', key: apiKey, baseUrl: fake.url, allowHttp: true })),
      notifyCard: () => undefined,
      isFocused: () => false,
      timeZone: 'UTC',
    }
    const runner = new Runner(deps)
    runners.push(runner)
    const routine: TriggerRow = {
      id: 'scheduler',
      name: 'Meetings scheduler',
      kind: 'daily',
      spec: '06:00',
      prompt: 'Make one routine per meeting on my calendar.',
      enabled: true,
      lastRunAt: null,
      lastResult: '',
      createdAt: 0,
    }
    await database.upsert('trigger', { ...routine })
    const result = await runner.runRoutine(routine)
    expect(result.waiting).toBe(true)
    await waitFor(async () => (await database.list('chat_item')).find((row) => row.kind === 'approval'))
    const cards = (await database.list('chat_item')).filter((row) => row.kind === 'approval')
    expect(cards.map((row) => row.text)).toEqual(['Send the meeting list to the team'])
    const made = (await database.list('trigger')).filter((row) => row.id !== 'scheduler')
    expect(made.map((row) => row.name).sort()).toEqual([1, 2, 3].map((n) => `Meeting: CRM INDUCTION SESSION ${n}`))
  })

  it('app_action data.remove of a routine asks nothing; of a task it still asks', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const tool = toolNamed(appActionTools({ invoker: () => ({ has: () => true, invoke: async (channel, args) => (calls.push({ channel, args }), null) }) }), 'app_action')
    const { approvals, ctx } = counting()
    await tool.run({ method: 'data.remove', args: ['trigger', 'r1'] }, ctx)
    expect(approvals).toEqual([])
    await tool.run({ method: 'data.remove', args: ['task', 't1'] }, ctx)
    expect(approvals).toHaveLength(1)
    expect(calls).toEqual([
      { channel: APP_ACTION_CHANNELS['data.remove'], args: ['trigger', 'r1'] },
      { channel: APP_ACTION_CHANNELS['data.remove'], args: ['task', 't1'] },
    ])
  })
})
