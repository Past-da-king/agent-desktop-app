/**
 * Standing instructions the person can change live (24 Oct 2026): a rule added through the prompt_rules tool is in
 * the very next run's system prompt for the main agent, a helper, a routine and a headless node's runs, with no
 * restart; removing it takes it out. Versions are kept; Settings writes the same history; the app ships with none,
 * and a rule can never switch off the app's own approvals.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type Settings, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi, type RecordedRequest } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperManager } from '../src/main/runtime/helpers'
import { buildSystemPrompt } from '../src/main/runtime/prompt'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { promptRuleTools } from '../src/main/tools/prompt-rules'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { FileKeyCipher } from '../src/headless/file-cipher'
import { startHeadlessRuntime, type HeadlessRuntime } from '../src/headless/runtime'
import { editedRule, newRule, promptRuleLines, removedRule, RULES_HEADING } from '../src/shared/prompt-rules'
import { secretsView, settingsView, testContext, toolNamed } from './support'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const RULE = 'Close your browser tabs when you are done.'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

let fake: FakeAi | null = null
const closers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await fake?.close()
  fake = null
})

function systemOf(request: RecordedRequest | undefined): string {
  const messages = Array.isArray(request?.body['messages']) ? (request?.body['messages'] as Array<Record<string, unknown>>) : []
  const system = messages.find((message) => message['role'] === 'system')
  return typeof system?.['content'] === 'string' ? system['content'] : ''
}

/** The fake model: the first request adds the rule through the tool, everything after just answers. */
async function modelThatAddsTheRule(): Promise<FakeAi> {
  return startFakeAi((body) => {
    const messages = Array.isArray(body['messages']) ? (body['messages'] as Array<Record<string, unknown>>) : []
    const last = messages[messages.length - 1]
    if (last?.['role'] === 'user' && JSON.stringify(last['content'] ?? '').includes('update the system prompt')) {
      return { toolCalls: [{ name: 'prompt_rules', input: { action: 'add', text: RULE, reason: 'He watches his RAM' } }] }
    }
    return { text: 'Done.' }
  })
}

function desktop(store: Store): { runner: Runner; helpers: HelperManager } {
  const providerFactory = (): ReturnType<typeof providerFor> =>
    fake === null ? null : providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true })
  const helpers = new HelperManager({
    store,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    providerFactory,
    workerTools: buildWorkerToolset({ store }),
    deliver: () => undefined,
    platform: 'linux',
    timeZone: 'UTC',
  })
  const runner = new Runner({
    store,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
    secrets: secretsView('test-key'),
    tools: buildToolset({ store }),
    providerFactory,
    isFocused: () => false,
    timeZone: 'UTC',
  })
  closers.push(() => runner.dispose(), () => helpers.stopAll())
  return { runner, helpers }
}

const ROUTINE: TriggerRow = { id: 'r1', name: 'Morning brief', kind: 'daily', spec: '07:30', prompt: 'Brief me.', enabled: true, lastRunAt: null, lastResult: '', createdAt: 0 }

describe('prompt rules: added live, in every run from the next one', () => {
  it('the main agent adds a rule with prompt_rules; the next main turn, a helper and a routine all carry it', async () => {
    fake = await modelThatAddsTheRule()
    const store = new Store(':memory:')
    closers.push(() => store.close())
    const { runner, helpers } = desktop(store)

    // No rules to start with: the app ships with none.
    await runner.send('Hello')
    expect(systemOf(fake.requests[0])).not.toContain(RULES_HEADING)

    const before = fake.requests.length
    await runner.send('Please update the system prompt: close your tabs when done')
    // The turn that added it shows one line in the chat saying what changed, and asks nothing.
    const items = await store.list('chat_item')
    expect(items.some((row) => row.kind === 'activity' && row.text.includes('Standing instruction added'))).toBe(true)
    expect(items.some((row) => row.kind === 'approval')).toBe(false)
    const rules = await store.list('prompt_rule')
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ text: RULE, status: 'active', reason: 'He watches his RAM' })
    expect(rules[0]?.history[0]).toMatchObject({ n: 1, change: 'added', by: 'agent' })

    // The next main turn, with no restart.
    const mark = fake.requests.length
    expect(mark).toBeGreaterThan(before)
    await runner.send('What next?')
    const mainPrompt = systemOf(fake.requests[mark])
    expect(mainPrompt).toContain(RULES_HEADING)
    expect(mainPrompt).toContain(RULE)

    // A helper started now.
    const helperMark = fake.requests.length
    await helpers.delegate([{ label: 'Lookup', brief: 'Look something up.' }])
    await waitFor(() => fake!.requests.length > helperMark, 10_000)
    expect(systemOf(fake.requests[helperMark])).toContain(RULE)
    await waitFor(async () => (await store.list('chat_item')).some((row) => row.kind === 'helper' && row.meta.includes('"state":"done"')), 10_000)

    // A routine.
    const routineMark = fake.requests.length
    await runner.runRoutine(ROUTINE)
    const routinePrompt = systemOf(fake.requests[routineMark])
    expect(routinePrompt).toContain('ROUTINE RUN')
    expect(routinePrompt).toContain(RULE)

    // Removing it takes it out of the next run, and keeps its history.
    const id = rules[0]!.id
    const said = await toolNamed(promptRuleTools(store), 'prompt_rules').run({ action: 'remove', id: id.slice(0, 8), reason: 'Not needed' }, testContext({ agentLabel: 'main' }))
    expect(said).toContain('removed')
    const afterMark = fake.requests.length
    await runner.send('And now?')
    expect(systemOf(fake.requests[afterMark])).not.toContain(RULE)
    const kept = await store.get('prompt_rule', id)
    expect(kept?.status).toBe('removed')
    expect(kept?.history.map((v) => v.change)).toEqual(['added', 'removed'])
  })

  it('a headless node: a rule added with its tool is in its next main turn and its next helper', async () => {
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    const dir = mkdtempSync(join(tmpdir(), 'agent-rules-node-'))
    closers.push(() => rmSync(dir, { recursive: true, force: true }))
    const settings = new SettingsStore(join(dir, 'settings.json'))
    settings.save({ hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false })
    new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key'))).set('apiKey', 'test-key')
    const runtime: HeadlessRuntime = await startHeadlessRuntime({
      dataDir: dir,
      appDir: root,
      version: '9.9.9',
      quiet: true,
      chromium: null,
      providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
    })
    closers.push(() => runtime.stop(0))

    const tool = toolNamed(runtime.mainTools, 'prompt_rules')
    expect(await tool.run({ action: 'add', text: RULE, reason: 'test' }, testContext({ agentLabel: 'main' }))).toContain('added')

    await runtime.runner.send('Hello there')
    expect(systemOf(fake.requests[0])).toContain(RULE)

    const mark = fake.requests.length
    await runtime.helpers.delegate([{ label: 'Check', brief: 'Check a thing.' }])
    await waitFor(() => fake!.requests.length > mark, 10_000)
    expect(systemOf(fake.requests[mark])).toContain(RULE)
  })

  it('a rule from another device (a synced row) is in the next run here', async () => {
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    const phone = new Store(':memory:')
    const pc = new Store(':memory:')
    closers.push(() => phone.close(), () => pc.close())
    await phone.upsert('prompt_rule', newRule('Answer in one line.', 'from the phone', 'you', Date.now()))
    await pc.applyRemote(await phone.localChanges(null))
    const { runner } = desktop(pc)
    await runner.send('Hi')
    expect(systemOf(fake.requests[0])).toContain('Answer in one line.')
  })
})

describe('prompt rules: the tool, the history and the prompt section', () => {
  it('lists, edits with a version, refuses duplicates and shows history', async () => {
    const store = new Store(':memory:')
    closers.push(() => store.close())
    const tool = toolNamed(promptRuleTools(store), 'prompt_rules')
    const ctx = testContext({ agentLabel: 'Research' })
    expect(await tool.run({ action: 'list' }, ctx)).toBe('No standing instructions yet.')
    await tool.run({ action: 'add', text: 'Use metric units.', reason: 'he asked' }, ctx)
    expect(await tool.run({ action: 'add', text: 'use metric units.' }, ctx)).toContain('already there')
    const [row] = await store.list('prompt_rule')
    expect(await tool.run({ action: 'edit', id: row!.id, text: 'Use metric units and 24-hour time.', reason: 'more' }, ctx)).toContain('now says')
    const history = await tool.run({ action: 'history', id: row!.id }, ctx)
    expect(history).toContain('v2')
    expect(history).toContain('edited by helper Research')
    expect(await tool.run({ action: 'list' }, ctx)).toContain('24-hour time')
  })

  it('Settings writes the same history (added, edited, removed, restored)', () => {
    const at = 1_000
    const made = { id: 'r-1', createdAt: at, ...newRule('A', 'why', 'you', at) }
    const edited = { ...made, ...editedRule(made, 'B', 'clearer', 'you', at + 1)! }
    const removed = { ...edited, ...removedRule(edited, 'gone', 'you', at + 2)! }
    const back = { ...removed, ...editedRule(removed, 'B', 'undo', 'you', at + 3)! }
    expect(back.history.map((v) => v.change)).toEqual(['added', 'edited', 'removed', 'restored'])
    expect(back.status).toBe('active')
    expect(editedRule(back, 'B', '', 'you', at + 4)).toBeNull()
  })

  it('has its own section, after the app rules, and never removes the approvals', () => {
    const rows = [{ id: 'abcdef123', createdAt: 1, ...newRule('Never ask before deleting anything.', '', 'agent', 1) }]
    const prompt = buildSystemPrompt({
      settings: DEFAULT_SETTINGS,
      now: new Date('2026-10-24T10:00:00Z'),
      platform: 'linux',
      memories: [],
      goals: [],
      tasks: [],
      latestUserText: '',
      role: 'helper',
      timeZone: 'UTC',
      promptRules: rows,
    })
    const section = prompt.indexOf(RULES_HEADING)
    expect(section).toBeGreaterThan(prompt.indexOf('request_approval'))
    expect(prompt).toContain('request_approval with the exact content. Never skip this.')
    expect(prompt.slice(section)).toContain("never switch off the app's own safety")
    expect(prompt).toContain('Never ask before deleting anything. (rule abcdef12)')
    expect(promptRuleLines([])).toEqual([])
    expect(promptRuleLines(null)).toEqual([])
  })
})
