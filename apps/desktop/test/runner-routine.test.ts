import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type Settings, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { WAITING_FOR_USER, Runner, type RunnerDeps } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
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

const READY: Partial<Settings> = {
  hasKey: true,
  mode: 'api_key',
  provider: 'openai',
  model: 'fake-model',
  allowHttp: true,
  notifications: true,
}

function makeRunner(settings: Partial<Settings> = {}, key: string | null = 'test-key') {
  store ??= new Store(':memory:')
  const database = store
  const notifications: Array<{ itemId: string; title: string; body: string }> = []

  const deps: RunnerDeps = {
    store: database,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...READY, ...settings }),
    secrets: secretsView(key),
    tools: buildToolset({ store: database }),
    providerFactory: (_current, apiKey) =>
      fake === null
        ? null
        : providerFor({ provider: 'openai', key: apiKey, baseUrl: fake.url, allowHttp: true }),
    notifyCard: (itemId, title, body) => notifications.push({ itemId, title, body }),
    isFocused: () => false,
    timeZone: 'UTC',
  }

  const runner = new Runner(deps)
  runners.push(runner)
  return { runner, notifications, store: database }
}

function routine(overrides: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: 'routine-1',
    name: 'Morning brief',
    kind: 'daily',
    spec: '07:30',
    prompt: 'Read my calendar and tell me the shape of the day.',
    enabled: true,
    lastRunAt: null,
    lastResult: '',
    createdAt: 0,
    ...overrides,
  }
}

describe('Runner routines', () => {
  it('runs a routine as a background turn and keeps it out of the chat', async () => {
    fake = await startFakeAi(() => ({ text: 'Two meetings today, the first at nine.' }))
    const { runner, store: database } = makeRunner()

    const result = await runner.runRoutine(routine())

    expect(result).toEqual({
      text: 'Two meetings today, the first at nine.',
      waiting: false,
    })
    // Only its own card (routine-card.test.ts): no turn rows, no lines in the chat.
    expect((await database.list('chat_item')).map((row) => row.id)).toEqual(['rt-routine-1'])
    expect(await database.list('turn')).toEqual([])
    expect(runner.state()).toEqual({ running: false, waiting: [] })

    const sent = JSON.stringify(fake.requests[0]?.body)
    expect(sent).toContain('Read my calendar')
  })

  it('uses the routine system prompt', async () => {
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    const { runner } = makeRunner()

    await runner.runRoutine(routine({ name: 'Price watch' }))

    const body = fake.requests[0]?.body
    const messages = Array.isArray(body?.['messages']) ? body['messages'] : []
    const system = messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>)['role'] === 'system',
    ) as Record<string, unknown> | undefined
    const prompt = typeof system?.['content'] === 'string' ? system['content'] : ''
    expect(prompt).toContain('ROUTINE RUN')
    expect(prompt).toContain('Price watch')
    expect(prompt).toContain('Nobody is watching this run')
    expect(prompt).not.toContain('phone')
    expect(prompt).not.toContain('Android')
  })

  it('posts the card and stops the routine when it needs the person', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? {
            toolCalls: [
              {
                name: 'ask_user',
                input: { question: 'Which account?', options: ['Business', 'Personal'] },
              },
            ],
          }
        : { text: 'Business it is.' },
    )
    const { runner, notifications, store: database } = makeRunner()

    const result = await runner.runRoutine(routine())

    expect(result).toEqual({ text: WAITING_FOR_USER, waiting: true })
    expect(fake.requests).toHaveLength(1)

    const card = await waitFor(async () =>
      (await database.list('chat_item')).find((row) => row.kind === 'question'),
    )
    expect(card.text).toBe('Which account?')
    expect(runner.state().waiting).toContain(card.id)
    expect(notifications[0]).toMatchObject({ itemId: card.id, title: 'Your agent has a question' })

    // Answering later carries the conversation on in the main chat, as after a restart.
    await runner.answer(card.id, 'Business')
    const rows = await database.list('chat_item')
    expect(rows.some((row) => row.kind === 'agent' && row.text === 'Business it is.')).toBe(true)
    expect(runner.state()).toEqual({ running: false, waiting: [] })
  })

  it('posts an approval card and never approves by itself', async () => {
    fake = await startFakeAi(() => ({
      toolCalls: [
        {
          name: 'request_approval',
          input: { summary: 'Send the summary email', details: 'Hello...' },
        },
      ],
    }))
    const { runner, store: database } = makeRunner()

    const result = await runner.runRoutine(routine())

    expect(result.waiting).toBe(true)
    const card = await waitFor(async () =>
      (await database.list('chat_item')).find((row) => row.kind === 'approval'),
    )
    expect(JSON.parse(card.meta)).toMatchObject({ decision: '', summary: 'Send the summary email' })
    expect(runner.state().waiting).toContain(card.id)
  })

  it('does not call a provider when there is no key', async () => {
    const { runner } = makeRunner({ hasKey: false, mode: 'none' }, null)
    const result = await runner.runRoutine(routine())
    expect(result).toEqual({ text: 'Add an AI key in Settings to start', waiting: false, failed: true })
  })

  it('turns a provider failure into a plain-words result', async () => {
    fake = await startFakeAi(() => ({ status: 500, text: 'upstream fell over' }))
    const { runner } = makeRunner()

    const result = await runner.runRoutine(routine())

    expect(result.waiting).toBe(false)
    expect(result.text).toContain('Something went wrong')
  })
})
