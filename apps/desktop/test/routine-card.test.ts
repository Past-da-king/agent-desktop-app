/**
 * A routine run shows like a helper (28 Oct 2026: the 19:00 routine ran with nothing on screen). While it runs, a
 * working card with its name sits in the main chat, so the sidebar, the helpers view and a phone list it; its line
 * follows the step it is on; when it ends the card is done (or failed) with its result, and a stop on the card ends
 * the run.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type ChatItem, type Settings, type Tool, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Runner, routineCardId, toolStepLabel } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { helperCards } from '../src/shared/helper-cards'
import { secretsView, settingsView } from './support'

let store: Store | null = null
let fake: FakeAi | null = null
const runners: Runner[] = []
afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  store?.close()
  store = null
  await fake?.close()
  fake = null
})

const ROUTINE: TriggerRow = { id: 'reddit', name: 'Cosmiprint Reddit', kind: 'daily', spec: '19:00', prompt: 'Do the daily Reddit round.', enabled: true, lastRunAt: null, lastResult: '', createdAt: 0 }
const meta = (row: ChatItem | null): Record<string, unknown> => (row === null ? {} : (JSON.parse(row.meta) as Record<string, unknown>))

/** A tool that holds the run until the test lets it go (or the run is stopped). */
let hold: Promise<void> = Promise.resolve()
const waitTool: Tool = {
  spec: { name: 'wait_here', description: 'waits', input_schema: { type: 'object', properties: {} } },
  run: async (_input, ctx) => {
    await Promise.race([hold, new Promise<void>((resolve) => ctx.signal?.addEventListener('abort', () => resolve()))])
    return 'ok'
  },
}

function runnerFor(database: Store, url: () => string): Runner {
  const ready: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true }
  const runner = new Runner({
    store: database,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...ready }),
    secrets: secretsView('test-key'),
    tools: [...buildToolset({ store: database }), waitTool],
    providerFactory: (_current, apiKey) => providerFor({ provider: 'openai', key: apiKey, baseUrl: url(), allowHttp: true }),
    notifyCard: () => undefined,
    isFocused: () => false,
    timeZone: 'UTC',
  })
  runners.push(runner)
  return runner
}

async function workingCard(database: Store): Promise<ChatItem> {
  return waitFor(async () => {
    const row = await database.get('chat_item', routineCardId(ROUTINE.id))
    return row !== null && meta(row)['state'] === 'working' ? row : undefined
  })
}

describe('a running routine is on screen like a helper', () => {
  it('a working card with its name while it runs, its step as the line, done with its result after', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    hold = gate
    fake = await startFakeAi((_body, index) => (index === 0 ? { toolCalls: [{ name: 'wait_here', input: {} }] } : { text: 'Commented on 3 posts in r/astrology.' }))
    store = new Store(':memory:')
    const database = store
    const runner = runnerFor(database, () => fake?.url ?? '')
    await database.upsert('trigger', { ...ROUTINE })
    const done = runner.runRoutine(ROUTINE)

    const working = await workingCard(database)
    expect(working.kind).toBe('helper')
    expect(meta(working)['label']).toBe('Cosmiprint Reddit')
    // The sidebar's cards (shared/helper-cards.ts) list it as working.
    const card = helperCards(await database.list('chat_item'), []).find((each) => each.id === routineCardId(ROUTINE.id))
    expect(card?.state).toBe('working')
    expect(card?.label).toBe('Cosmiprint Reddit')
    // Its step becomes its line (written at most every 1.5 s).
    await waitFor(async () => (String(meta(await database.get('chat_item', routineCardId(ROUTINE.id)))['summary']) !== 'Starting' ? true : undefined), 5000)

    release()
    const result = await done
    expect(result.text).toBe('Commented on 3 posts in r/astrology.')
    const after = meta(await database.get('chat_item', routineCardId(ROUTINE.id)))
    expect(after['state']).toBe('done')
    expect(after['result']).toBe('Commented on 3 posts in r/astrology.')
    expect(typeof after['endedAt']).toBe('number')
    // No step rows are written for it: a phone pulls only the one card.
    expect((await database.list('chat_item')).filter((row) => row.kind === 'activity')).toHaveLength(0)
  }, 15_000)

  it('the next run opens the same card again; a run that fails reads failed', async () => {
    fake = await startFakeAi(() => ({ text: 'All quiet.' }))
    store = new Store(':memory:')
    const database = store
    let url = fake.url
    const runner = runnerFor(database, () => url)
    await runner.runRoutine(ROUTINE)
    expect(meta(await database.get('chat_item', routineCardId(ROUTINE.id)))['state']).toBe('done')
    url = 'http://127.0.0.1:9/'
    await runner.runRoutine(ROUTINE)
    const rows = (await database.list('chat_item')).filter((row) => row.kind === 'helper')
    expect(rows).toHaveLength(1)
    expect(meta(rows[0] ?? null)['state']).toBe('failed')
  })

  it('a stop on its card ends the run', async () => {
    hold = new Promise<void>((resolve) => setTimeout(resolve, 20_000))
    fake = await startFakeAi((_body, index) => (index === 0 ? { toolCalls: [{ name: 'wait_here', input: {} }] } : { text: 'late' }))
    store = new Store(':memory:')
    const database = store
    const runner = runnerFor(database, () => fake?.url ?? '')
    const done = runner.runRoutine(ROUTINE)
    const row = await workingCard(database)
    await new Promise((resolve) => setTimeout(resolve, 300))
    // What the helper service's stop does to a card it does not run.
    await database.upsert('chat_item', { id: row.id, kind: 'helper', text: row.text, meta: JSON.stringify({ ...meta(row), state: 'stopped' }) })
    const started = Date.now()
    await done
    expect(Date.now() - started).toBeLessThan(5000)
  }, 15_000)

  it('tool names read as plain steps', () => {
    expect(toolStepLabel('mcp__agent__web_fetch')).toBe('Using web fetch')
    expect(toolStepLabel('Bash')).toBe('Using bash')
  })
})
