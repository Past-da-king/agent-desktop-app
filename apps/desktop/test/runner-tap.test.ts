// A tap on a button the agent drew goes to the agent quietly (the phone's AgentRuntime.sendQuiet), and ask_user
// always offers a No.
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type ChatEvent } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { TURNED_DOWN } from '../src/shared/ask-options'
import { secretsView, settingsView, testContext, toolNamed } from './support'

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

function makeRunner(): { runner: Runner; db: Store; events: ChatEvent[] } {
  store = new Store(':memory:')
  const db = store
  const events: ChatEvent[] = []
  const runner = new Runner({
    store: db,
    settings: settingsView({ ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }),
    secrets: secretsView('test-key'),
    tools: buildToolset({ store: db }),
    providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
    emit: (event) => events.push(event),
    timeZone: 'UTC',
  })
  runners.push(runner)
  return { runner, db, events }
}

const CARD = 'Two mice.\n\n```openui-lang\nroot = Stack([p1])\np1 = Product(null, "Orbit M3", "R899", null, null, null, null, null, b1)\nb1 = Buttons([Button("Add to cart", @ToAssistant("Add to cart", {sku: "DM-1001"}))])\n```'

describe('Runner.tap', () => {
  it('sends the tap to the agent without a user bubble, tells the model it was a tap, and remembers it', async () => {
    fake = await startFakeAi(() => ({ text: 'Added the Orbit M3 to your cart.' }))
    const { runner, db, events } = makeRunner()
    const card = await db.upsert('chat_item', { kind: 'agent', text: CARD, meta: '{}' })

    await runner.tap(card.id, 'Add to cart', 'Add to cart\n↳ Orbit M3 · sku: DM-1001')

    const rows = await db.list('chat_item')
    expect(rows.filter((row) => row.kind === 'user')).toHaveLength(0)
    expect(rows.some((row) => row.kind === 'agent' && row.text === 'Added the Orbit M3 to your cart.')).toBe(true)
    const tapped = rows.find((row) => row.id === card.id)
    expect(JSON.parse(tapped?.meta ?? '{}')).toEqual({ taps: ['Add to cart\n↳ Orbit M3 · sku: DM-1001'] })

    const body = JSON.stringify(fake.requests[0]?.body ?? {})
    expect(body).toContain('[The user tapped \\"Add to cart\\" on a card you drew.')
    expect(body).toContain('sku: DM-1001')
    // The main agent is taught to draw cards in this mode.
    expect(body).toContain('GENERATIVE UI')
    expect(events.some((event) => event.type === 'run_started')).toBe(true)
  })

  it('ignores a tap on something that is not an agent message', async () => {
    fake = await startFakeAi(() => ({ text: 'should not run' }))
    const { runner, db } = makeRunner()
    const user = await db.upsert('chat_item', { kind: 'user', text: 'hi', meta: '{}' })
    await runner.tap(user.id, 'Go', 'Go')
    await runner.tap('missing', 'Go', 'Go')
    expect(fake.requests).toHaveLength(0)
  })
})

describe('ask_user always offers No', () => {
  it('adds No last and tells the agent plainly when the user picks it', async () => {
    const db = new Store(':memory:')
    store = db
    const tool = toolNamed(buildToolset({ store: db }), 'ask_user')
    let offered: string[] = []
    const ctx = testContext({
      ask: async (_question, options) => {
        offered = options
        return 'No'
      },
    })
    expect(await tool.run({ question: 'Which colour?', options: ['Blue', 'Green'] }, ctx)).toBe(TURNED_DOWN)
    expect(offered).toEqual(['Blue', 'Green', 'No'])

    const own = testContext({ ask: async () => 'Not now' })
    expect(await tool.run({ question: 'Open settings?', options: ['Open settings', 'Not now'] }, own)).toBe('The user answered: Not now')
  })
})
