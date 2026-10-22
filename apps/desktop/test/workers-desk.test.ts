/**
 * The desk: one standing helper per event routine. Every batch carries on the same conversation, it can hand work
 * out (delegate) on the API path and on the plan path, and a QUIET result stays on its card instead of waking the
 * main agent.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type JsonObject, type Settings, type Tool } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { Store } from '../src/main/db'
import { toolsForTurn } from '../src/main/runtime/cli-host'
import { HelperManager } from '../src/main/runtime/helpers'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

let store: Store | null = null
let fake: FakeAi | null = null
const managers: HelperManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAll()
  store?.close()
  store = null
  await fake?.close()
  fake = null
})

const READY: Partial<Settings> = { ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

function harness(): { manager: HelperManager; delivered: string[] } {
  store = new Store(':memory:')
  const delivered: string[] = []
  const manager = new HelperManager({
    store,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake!.url, allowHttp: true }),
    workerTools: buildWorkerToolset({ store }),
    deliver: (note) => {
      delivered.push(note)
    },
    platform: 'linux',
    timeZone: 'UTC',
  })
  managers.push(manager)
  return { manager, delivered }
}

function toolNames(body: JsonObject): string[] {
  const tools = (body['tools'] as Array<{ function?: { name?: string } }> | undefined) ?? []
  return tools.map((t) => t.function?.name ?? '')
}

function conversation(body: JsonObject): string {
  return JSON.stringify(body['messages'] ?? [])
}

const SPEC = { routineId: 'r1', name: 'Team chat desk', brief: 'Sort messages by who owns them.', profile: '', deskId: '' }

describe('the desk', () => {
  it('is one helper that remembers: the second batch continues the first conversation, and it can delegate', async () => {
    fake = await startFakeAi((body) => {
      const text = conversation(body)
      if (text.includes('batch two')) return { text: 'Sam again: added to helper #h2.' }
      return { text: 'Sam asked for the invoice: gave it to a helper.' }
    })
    const { manager, delivered } = harness()
    const first = await manager.runDesk(SPEC, '[1 new event] batch one: Sam wants the invoice')
    expect(first.state).toBe('done')
    expect(first.deskId).not.toBe('')
    expect(toolNames(fake.requests[0]!.body)).toContain('delegate')

    const second = await manager.runDesk({ ...SPEC, deskId: first.deskId }, '[1 new event] batch two: Sam again')
    expect(second.deskId).toBe(first.deskId)
    const lastRequest = fake.requests[fake.requests.length - 1]!.body
    // The same conversation: the first batch and the desk's answer to it are still there.
    expect(conversation(lastRequest)).toContain('batch one')
    expect(conversation(lastRequest)).toContain('gave it to a helper')
    expect(toolNames(lastRequest)).toContain('delegate')
    // Both results reached the main agent, labelled as the desk.
    expect(delivered).toHaveLength(2)
    expect(delivered[0]).toContain('Desk: Team chat desk')
  })

  it('a QUIET result stays on its card and does not wake the main agent', async () => {
    fake = await startFakeAi(() => ({ text: 'QUIET: only a bot notice.' }))
    const { manager, delivered } = harness()
    const outcome = await manager.runDesk(SPEC, '[1 new event] a bot said hello')
    expect(outcome.state).toBe('done')
    expect(delivered).toHaveLength(0)
  })

  it('on a plan, a desk session keeps delegate and an ordinary helper does not', () => {
    const tools = ['delegate', 'helper_steer', 'memory_search'].map((name) => ({ spec: { name, description: '', schema: {} }, run: async () => '' }) as Tool)
    const desk = toolsForTurn({ tools, thread: 'helper:abc', cli: 'claude', delegates: true }).map((t) => t.spec.name)
    const helper = toolsForTurn({ tools, thread: 'helper:abc', cli: 'claude' }).map((t) => t.spec.name)
    expect(desk).toContain('delegate')
    expect(helper).not.toContain('delegate')
    expect(helper).toContain('memory_search')
  })
})
