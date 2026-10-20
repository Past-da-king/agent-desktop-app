import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  providerFor,
  type ChatEvent,
  type ChatItem,
  type Settings,
  type Tool,
} from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Runner, type RunnerDeps } from '../src/main/runtime/runner'
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

interface MakeOptions {
  settings?: Partial<Settings>
  key?: string | null
  extraTools?: Tool[]
  providerCalls?: { count: number }
  focused?: boolean
}

const READY: Partial<Settings> = {
  hasKey: true,
  mode: 'api_key',
  provider: 'openai',
  model: 'fake-model',
  allowHttp: true,
  notifications: false,
}

function makeRunner(options: MakeOptions = {}) {
  store ??= new Store(':memory:')
  const database = store
  const events: ChatEvent[] = []
  const notifications: Array<{ title: string; body: string }> = []

  const deps: RunnerDeps = {
    store: database,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...READY, ...options.settings }),
    secrets: secretsView(options.key === undefined ? 'test-key' : options.key),
    tools: [...buildToolset({ store: database }), ...(options.extraTools ?? [])],
    providerFactory: (current, key) => {
      if (options.providerCalls !== undefined) options.providerCalls.count++
      if (fake === null) return null
      return providerFor({
        provider: 'openai',
        key,
        baseUrl: fake.url,
        allowHttp: true,
      })
    },
    emit: (event) => events.push(event),
    notify: (title, body) => notifications.push({ title, body }),
    isFocused: () => options.focused ?? false,
    timeZone: 'UTC',
  }

  const runner = new Runner(deps)
  runners.push(runner)
  return { runner, events, notifications, store: database }
}

function items(database: Store): Promise<ChatItem[]> {
  return database.list('chat_item')
}

describe('Runner', () => {
  it('answers a simple message and keeps both turns', async () => {
    fake = await startFakeAi(() => ({ text: 'Hi Sam' }))
    const { runner, events, store: database } = makeRunner()

    await runner.send('Hello')

    const rows = await items(database)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'agent'])
    expect(rows[1]?.text).toBe('Hi Sam')
    expect(await database.list('turn')).toHaveLength(2)
    expect(events[0]).toEqual({ type: 'run_started' })
    expect(events.at(-1)).toEqual({ type: 'run_finished' })
    expect(runner.state()).toEqual({ running: false, waiting: [] })
  })

  it('runs a tool chain and leaves the memory behind', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? {
            toolCalls: [
              {
                name: 'memory_save',
                input: { title: 'Lerato', body: 'Lives in Durban.', topics: 'family' },
              },
            ],
          }
        : { text: 'Saved.' },
    )
    const { runner, store: database } = makeRunner()

    await runner.send('Remember that Lerato lives in Durban')

    const memories = await database.list('memory')
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({ title: 'Lerato', body: 'Lives in Durban.' })

    const rows = await items(database)
    const activity = rows.find((row) => row.kind === 'activity')
    expect(activity).toBeDefined()
    expect(JSON.parse(activity?.meta ?? '{}')).toMatchObject({
      tool: 'memory_save',
      status: 'done',
    })
    expect(rows.some((row) => row.kind === 'agent' && row.text === 'Saved.')).toBe(true)
  })

  it('suspends on a question and carries on with the answer', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? {
            toolCalls: [
              {
                name: 'ask_user',
                input: { question: 'Which colour?', options: ['Blue', 'Green'] },
              },
            ],
          }
        : { text: 'Blue it is.' },
    )
    const { runner, events, store: database } = makeRunner()

    const sending = runner.send('Pick a colour').catch(() => undefined)
    const card = await waitFor(async () =>
      (await items(database)).find((row) => row.kind === 'question'),
    )

    expect(runner.state().running).toBe(true)
    expect(runner.state().waiting).toContain(card.id)
    expect(events.some((event) => event.type === 'needs_you' && event.itemId === card.id)).toBe(true)

    await runner.answer(card.id, 'Blue')
    await sending

    const rows = await items(database)
    expect(rows.some((row) => row.kind === 'agent' && row.text === 'Blue it is.')).toBe(true)
    const answered = rows.find((row) => row.id === card.id)
    expect(JSON.parse(answered?.meta ?? '{}')).toMatchObject({ answer: 'Blue' })
    expect(runner.state()).toEqual({ running: false, waiting: [] })
  })

  it('passes a declined approval back to the model instead of doing the work', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? {
            toolCalls: [
              {
                name: 'request_approval',
                input: { summary: 'Send the email to Lerato', details: 'Hello Lerato...' },
              },
            ],
          }
        : { text: 'Understood, I did not send it.' },
    )
    const { runner, store: database } = makeRunner()

    const sending = runner.send('Email Lerato').catch(() => undefined)
    const card = await waitFor(async () =>
      (await items(database)).find((row) => row.kind === 'approval'),
    )
    await runner.decide(card.id, 'decline')
    await sending

    expect(JSON.stringify(fake.requests[1]?.body)).toContain('The user declined.')
    const rows = await items(database)
    const decided = rows.find((row) => row.id === card.id)
    expect(JSON.parse(decided?.meta ?? '{}')).toMatchObject({
      summary: 'Send the email to Lerato',
      decision: 'decline',
    })
    expect(rows.some((row) => row.kind === 'agent' && row.text.includes('did not send'))).toBe(true)
  })

  it('stops a run in flight and says so', async () => {
    const slow: Tool = {
      spec: { name: 'slow_tool', description: 'Waits a while.', schema: { type: 'object', properties: {} } },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 300))
        return 'finished'
      },
    }
    fake = await startFakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'slow_tool', input: {} }] } : { text: 'should not appear' },
    )
    const { runner, store: database } = makeRunner({ extraTools: [slow] })

    const sending = runner.send('Do the slow thing').catch(() => undefined)
    await waitFor(async () =>
      (await items(database)).some(
        (row) => row.kind === 'activity' && JSON.parse(row.meta).status === 'running',
      ),
    )
    runner.stop()
    await sending

    const rows = await items(database)
    expect(rows.some((row) => row.kind === 'notice' && row.text === 'Stopped')).toBe(true)
    expect(rows.some((row) => row.kind === 'agent' && row.text.includes('should not appear'))).toBe(false)
    expect(fake.requests).toHaveLength(1)
  })

  it('turns a provider failure into a notice and still finishes the run', async () => {
    fake = await startFakeAi(() => ({ status: 500, text: 'upstream fell over' }))
    const { runner, events, store: database } = makeRunner()

    await runner.send('Hello')

    const rows = await items(database)
    const notice = rows.find((row) => row.kind === 'notice')
    expect(notice?.text).toContain('Something went wrong')
    expect(events.at(-1)).toMatchObject({ type: 'run_finished' })
    const finished = events.at(-1)
    expect(finished?.type === 'run_finished' ? finished.error : undefined).toBeTruthy()
    expect(runner.state().running).toBe(false)
  }, 30_000)

  it('re-arms cards and repairs running activity after a restart', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? { toolCalls: [{ name: 'ask_user', input: { question: 'Which colour?', options: ['Blue'] } }] }
        : { text: 'Carried on after the restart.' },
    )

    const first = makeRunner()
    const sending = first.runner.send('Pick a colour').catch(() => undefined)
    const card = await waitFor(async () =>
      (await items(first.store)).find((row) => row.kind === 'question'),
    )
    first.runner.stop()
    await sending

    const interrupted = await first.store.upsert('chat_item', {
      kind: 'activity',
      text: 'Reading a page',
      meta: JSON.stringify({ tool: 'web_fetch', status: 'running', summary: 'Reading a page' }),
    })

    const second = makeRunner()
    await second.runner.restore()

    const repaired = await second.store.get('chat_item', interrupted.id)
    expect(JSON.parse(repaired?.meta ?? '{}')).toMatchObject({ status: 'error', summary: 'Interrupted' })
    expect(second.runner.state().waiting).toContain(card.id)

    await second.runner.answer(card.id, 'Blue')

    const rows = await items(second.store)
    expect(rows.some((row) => row.kind === 'agent' && row.text === 'Carried on after the restart.')).toBe(true)
    expect(JSON.parse(rows.find((row) => row.id === card.id)?.meta ?? '{}')).toMatchObject({ answer: 'Blue' })
  })

  it('merges a message sent while the agent is working into the same run', async () => {
    const slow: Tool = {
      spec: { name: 'slow_tool', description: 'Waits a while.', schema: { type: 'object', properties: {} } },
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return 'done'
      },
    }
    fake = await startFakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'slow_tool', input: {} }] } : { text: 'Seen.' },
    )
    const { runner, store: database } = makeRunner({ extraTools: [slow] })

    const sending = runner.send('Start the job').catch(() => undefined)
    await waitFor(() => fake !== null && fake.requests.length === 1)
    await runner.send('Also check the post')
    await sending

    expect(fake.requests.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(fake.requests[1]?.body)).toContain('Also check the post')
    expect((await items(database)).filter((row) => row.kind === 'user')).toHaveLength(2)
  })

  it('asks for a key instead of calling a provider when there is none', async () => {
    const calls = { count: 0 }
    fake = await startFakeAi(() => ({ text: 'never' }))
    const { runner, events, store: database } = makeRunner({
      settings: { hasKey: false, mode: 'none' },
      key: null,
      providerCalls: calls,
    })

    await runner.send('Hello')

    expect(calls.count).toBe(0)
    expect(fake.requests).toHaveLength(0)
    const rows = await items(database)
    expect(rows.some((row) => row.kind === 'notice' && row.text === 'Add an AI key in Settings to start')).toBe(
      true,
    )
    expect(events.at(-1)).toEqual({ type: 'run_finished' })
  })

  it('keeps the attachment details on the user row', async () => {
    fake = await startFakeAi(() => ({ text: 'Got it.' }))
    const { runner, store: database } = makeRunner()

    await runner.send('Look at this', [
      { path: '/tmp/photo-that-is-not-there.jpg', name: 'photo.jpg', mime: 'image/jpeg' },
    ])

    const [user] = await items(database)
    expect(JSON.parse(user?.meta ?? '{}')).toMatchObject({
      attachments: [{ name: 'photo.jpg', mime: 'image/jpeg' }],
    })
  })

  it('notifies when a card needs the person and the window is not focused', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? { toolCalls: [{ name: 'ask_user', input: { question: 'Which one?', options: ['A', 'B'] } }] }
        : { text: 'Done.' },
    )
    const { runner, notifications, store: database } = makeRunner({
      settings: { notifications: true },
      focused: false,
    })

    const sending = runner.send('Choose').catch(() => undefined)
    const card = await waitFor(async () =>
      (await items(database)).find((row) => row.kind === 'question'),
    )
    expect(notifications.some((note) => note.title === 'Your agent has a question')).toBe(true)

    await runner.answer(card.id, 'A')
    await sending
  })

  it('does nothing when stop is pressed with no run going', () => {
    const { runner, store: database } = makeRunner()
    runner.stop()
    expect(runner.state()).toEqual({ running: false, waiting: [] })
    return expect(items(database)).resolves.toEqual([])
  })
})
