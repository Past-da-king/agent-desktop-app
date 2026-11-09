// A turn that finishes while the window is not in front of the person says so once, carrying the reply itself
// (issue #15: the working notification disappeared and nothing said the reply had arrived).
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
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

function makeRunner(options: { focused?: boolean } = {}): { runner: Runner; told: Array<{ chat: string; body: string }> } {
  store = new Store(':memory:')
  const db = store
  const told: Array<{ chat: string; body: string }> = []
  const runner = new Runner({
    store: db,
    settings: settingsView({
      ...DEFAULT_SETTINGS,
      hasKey: true,
      mode: 'api_key',
      provider: 'openai',
      model: 'fake-model',
      allowHttp: true,
      notifications: true,
    }),
    secrets: secretsView('test-key'),
    tools: buildToolset({ store: db }),
    providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
    notifyReply: (chat, body) => told.push({ chat, body }),
    isFocused: () => options.focused === true,
    timeZone: 'UTC',
  })
  runners.push(runner)
  return { runner, told }
}

const CARD = '```openui-lang\nroot = Stack([p1])\np1 = Product(null, "Orbit M3", "R899", null, null, null, null, null, null)\n```'

describe('a finished turn while the window is away', () => {
  it('says once that the reply arrived, carrying what the agent said', async () => {
    fake = await startFakeAi(() => ({ text: 'The three files are pushed and the branch is clean.' }))
    const { runner, told } = makeRunner()

    await runner.send('push the branch')

    expect(told).toEqual([{ chat: 'main', body: 'The three files are pushed and the branch is clean.' }])
  })

  it('stays quiet while the window has the person\'s attention', async () => {
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    const { runner, told } = makeRunner({ focused: true })

    await runner.send('do it')

    expect(told).toEqual([])
  })

  it('says nothing for a reply that is only a card, or only code', async () => {
    fake = await startFakeAi((_body, index) => ({ text: index === 0 ? CARD : '```js\nconst a = 1\nexport { a }\n```' }))
    const { runner, told } = makeRunner()

    await runner.send('draw me the product')
    await runner.send('write that file')

    expect(told).toEqual([])
  })

  it('keeps the words and drops the code when a reply has both', async () => {
    fake = await startFakeAi(() => ({ text: 'Fixed it.\n\n```js\nconst a = 1\n```\nThe test is green.' }))
    const { runner, told } = makeRunner()

    await runner.send('fix the test')

    expect(told).toEqual([{ chat: 'main', body: 'Fixed it. The test is green.' }])
  })

  it('names the chat the reply was in', async () => {
    fake = await startFakeAi(() => ({ text: 'The gallery is fixed.' }))
    const { runner, told } = makeRunner()

    await runner.send('fix the gallery', [], 'pc123abc')

    expect(told).toEqual([{ chat: 'pc123abc', body: 'The gallery is fixed.' }])
  })
})
