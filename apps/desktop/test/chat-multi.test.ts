/**
 * Several chats at once, and messages sent while a chat is busy, on the real Runner, the real HelperManager,
 * the real Store and a real local fake AI server (no mocked fetch).
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  MAIN_CHAT,
  providerFor,
  type ChatEvent,
  type ChatItem,
  type JsonObject,
  type Settings,
  type Tool,
} from '@agent/core'

import { startFakeAi, type FakeAi, type FakeReply } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import type { Classifier } from '../src/main/runtime/chat-route'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner, type RunnerDeps } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const OTHER = 'cotherchat0001'

let store: Store | null = null
let fake: FakeAi | null = null
const runners: Runner[] = []
const managers: HelperManager[] = []
let gates: Array<() => void> = []

afterEach(async () => {
  for (const release of gates.splice(0)) release()
  for (const runner of runners.splice(0)) runner.dispose()
  for (const manager of managers.splice(0)) await manager.stopAll()
  await sleep(30)
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
  notifications: false,
}

/** A tool that holds the run until the test lets it go (or the run is stopped). */
const gateTool: Tool = {
  spec: { name: 'gate', description: 'Waits.', schema: { type: 'object', properties: {} } },
  run: (_input, ctx) =>
    new Promise<string>((resolve) => {
      const release = (): void => resolve('gate opened')
      gates.push(release)
      ctx.signal.addEventListener('abort', release, { once: true })
    }),
}

function messagesOf(body: JsonObject): Array<{ role: string; text: string }> {
  const list = Array.isArray(body['messages']) ? body['messages'] : []
  return list.map((raw) => {
    const message = raw as { role?: unknown; content?: unknown }
    const content = message.content
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '')
    return { role: String(message.role ?? ''), text }
  })
}

/**
 * The fake AI: classifier calls answer from `verdict`; a separate run's brief gets a summary; a main turn whose
 * last message asks for SLOW calls the gate tool; a tool result or any other message gets "Done: <last words>".
 */
function script(verdict: () => string = () => 'SAME') {
  return (body: JsonObject): FakeReply => {
    const all = JSON.stringify(body)
    const messages = messagesOf(body)
    const last = messages[messages.length - 1]
    if (all.includes('You sort one message')) return { text: verdict() }
    if (last !== undefined && last.text.includes('were already busy with another task')) return { text: 'Side done: Friday is sunny, 26 degrees.' }
    if (last !== undefined && last.role === 'tool') return { text: 'Finished the slow part.' }
    if (last !== undefined && last.text.includes('DELEGATE')) {
      return { toolCalls: [{ name: 'delegate', input: { tasks: [{ label: 'Lookup', brief: 'HELPER BRIEF find the price' }] } }] }
    }
    if (last !== undefined && last.text.includes('HELPER BRIEF')) return { text: 'The price is R 42.' }
    if (last !== undefined && last.text.includes('SLOW')) return { toolCalls: [{ name: 'gate', input: {} }] }
    return { text: `Done: ${(last?.text ?? '').slice(-60)}` }
  }
}

interface Harness {
  runner: Runner
  events: ChatEvent[]
  store: Store
  manager: HelperManager | null
}

function make(options: { helpers?: boolean; classifier?: Classifier | null; joinPickupMs?: number; settings?: Partial<Settings>; cli?: CliHost } = {}): Harness {
  store ??= new Store(':memory:')
  const db = store
  const events: ChatEvent[] = []
  let runner: Runner | null = null
  const settings = settingsView({ ...DEFAULT_SETTINGS, ...READY, ...options.settings })
  const factory = (): ReturnType<typeof providerFor> | null =>
    fake === null ? null : providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true })
  const manager =
    options.helpers === true
      ? new HelperManager({
          store: db,
          settings,
          secrets: secretsView('test-key'),
          providerFactory: factory,
          workerTools: buildWorkerToolset({ store: db }),
          deliver: async (note, chat) => {
            await runner?.deliver(note, chat)
          },
          alongsideDone: async (chat, id) => {
            await runner?.alongsideDone(chat, id)
          },
        })
      : null
  if (manager !== null) managers.push(manager)
  const deps: RunnerDeps = {
    store: db,
    settings,
    secrets: secretsView('test-key'),
    tools: [...buildToolset({ store: db, ...(manager === null ? {} : { helpers: manager }) }), gateTool],
    providerFactory: factory,
    emit: (event) => events.push(event),
    timeZone: 'UTC',
    ...(manager === null ? {} : { helpers: manager }),
    ...(options.classifier === undefined ? {} : { classifier: options.classifier }),
    ...(options.joinPickupMs === undefined ? {} : { joinPickupMs: options.joinPickupMs }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
  }
  runner = new Runner(deps)
  runners.push(runner)
  return { runner, events, store: db, manager }
}

function meta(row: ChatItem | undefined): Record<string, unknown> {
  return row === undefined ? {} : (JSON.parse(row.meta) as Record<string, unknown>)
}

function chatOf(row: ChatItem): string {
  const value = meta(row)['chat']
  return typeof value === 'string' ? value : MAIN_CHAT
}

async function rows(db: Store): Promise<ChatItem[]> {
  return db.list('chat_item')
}

function requestsWith(text: string): number {
  return (fake?.requests ?? []).filter((request) => JSON.stringify(request.body).includes(text)).length
}

describe('several chats at once', () => {
  it('runs two chats in parallel, each with its own rows, transcript and state', async () => {
    fake = await startFakeAi(script())
    const { runner, events, store: db } = make()

    const first = runner.send('SLOW job in the first chat')
    const second = runner.send('SLOW job in the other chat', [], OTHER)
    await waitFor(() => gates.length === 2)

    expect(runner.state(MAIN_CHAT).running).toBe(true)
    expect(runner.state(OTHER).running).toBe(true)
    expect(runner.state().running).toBe(true)
    expect(runner.states().map((info) => info.chat).sort()).toEqual([OTHER, MAIN_CHAT].sort())

    for (const release of gates.splice(0)) release()
    await Promise.all([first, second])

    const all = await rows(db)
    const mine = all.filter((row) => chatOf(row) === MAIN_CHAT)
    const other = all.filter((row) => chatOf(row) === OTHER)
    expect(mine.filter((row) => row.kind === 'user').map((row) => row.text)).toEqual(['SLOW job in the first chat'])
    expect(other.filter((row) => row.kind === 'user').map((row) => row.text)).toEqual(['SLOW job in the other chat'])
    expect(other.some((row) => row.kind === 'agent' && row.text === 'Finished the slow part.')).toBe(true)
    expect(mine.some((row) => row.kind === 'agent' && row.text === 'Finished the slow part.')).toBe(true)
    // Each chat keeps its own model transcript.
    const turns = await db.list('turn')
    expect(new Set(turns.map((turn) => turn.thread))).toEqual(new Set(['main', `chat:${OTHER}`]))
    expect(turns.filter((turn) => turn.thread === 'main').some((turn) => turn.json.includes('other chat'))).toBe(false)
    // Events name their chat; the first chat's look as they always did.
    expect(events).toContainEqual({ type: 'run_started' })
    expect(events).toContainEqual({ type: 'run_started', chat: OTHER })
    expect(events).toContainEqual({ type: 'run_finished', chat: OTHER })
    expect(runner.state(OTHER).running).toBe(false)
  })

  it('a helper started from a chat reports back to that chat', async () => {
    fake = await startFakeAi(script())
    const { runner, store: db } = make({ helpers: true })

    await runner.send('DELEGATE the price check', [], OTHER)
    await waitFor(async () => (await db.list('turn')).some((turn) => turn.thread === `chat:${OTHER}` && turn.json.includes('The price is R 42.')), 5000)
    await waitFor(async () => (await rows(db)).filter((row) => row.kind === 'agent' && chatOf(row) === OTHER).length === 2, 5000)

    const all = await rows(db)
    const helper = all.find((row) => row.kind === 'helper')
    expect(meta(helper)['chat']).toBe(OTHER)
    // The result came back as a turn in the same chat, never in the first one.
    expect(all.filter((row) => row.kind === 'agent' && chatOf(row) === MAIN_CHAT)).toHaveLength(0)
    expect(all.filter((row) => row.kind === 'agent' && chatOf(row) === OTHER).at(-1)?.text).toContain('R 42.')
  })

  it('branches a chat from a message: history up to there, transcript included, the old chat untouched', async () => {
    fake = await startFakeAi(script())
    const { runner, store: db } = make()

    await runner.send('first question about tax')
    await runner.send('second question about leave')
    const before = await rows(db)
    const firstReply = before.find((row) => row.kind === 'agent' && row.text.includes('first question about tax'))
    expect(firstReply).toBeDefined()

    const branch = await runner.branch(firstReply?.id ?? '')
    const after = await rows(db)
    const copied = after.filter((row) => chatOf(row) === branch)
    expect(copied.map((row) => row.kind)).toEqual(['user', 'agent', 'notice'])
    expect(copied[0]?.text).toBe('first question about tax')
    expect(meta(copied[2])['title']).toBe('Branch: first question about tax')
    expect(after.filter((row) => chatOf(row) === MAIN_CHAT)).toHaveLength(before.length)

    const branchTurns = (await db.list('turn')).filter((turn) => turn.thread === `chat:${branch}`)
    expect(branchTurns.length).toBe(2)

    await runner.send('a follow up in the branch', [], branch)
    const last = fake.requests[fake.requests.length - 1]
    const sent = JSON.stringify(last?.body)
    expect(sent).toContain('first question about tax')
    expect(sent).not.toContain('second question about leave')
    expect((await rows(db)).filter((row) => chatOf(row) === MAIN_CHAT)).toHaveLength(before.length)
  })
})

describe('New chat dividers, per chat', () => {
  it('a divider takes earlier turns out of its own chat only', async () => {
    fake = await startFakeAi(script())
    const { runner, store: db } = make()
    await runner.send('remember the colour teal', [], OTHER)
    await runner.send('remember the number 7')
    await db.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify({ divider: true }) })
    await sleep(5)
    await runner.send('what colour did I say?', [], OTHER)
    expect(JSON.stringify(fake.requests.at(-1)?.body)).toContain('remember the colour teal')
    await runner.send('what number did I say?')
    expect(JSON.stringify(fake.requests.at(-1)?.body)).not.toContain('remember the number 7')
  })
})

describe('a message sent while the chat is busy', () => {
  it('joins the running work when it is about the same task, and says so', async () => {
    fake = await startFakeAi(script())
    const { runner, store: db } = make({ helpers: true })

    const running = runner.send('SLOW tidy the invoices')
    await waitFor(() => gates.length === 1)
    await runner.send('Also flag anything over R 10,000')
    const user = (await rows(db)).find((row) => row.text === 'Also flag anything over R 10,000')
    expect(meta(user)['route']).toBe('join')

    for (const release of gates.splice(0)) release()
    await running
    // The words alone decided it: no classifier call, and the note reached the same run with its framing.
    expect(requestsWith('You sort one message')).toBe(0)
    expect(requestsWith('It is about the task you are on')).toBeGreaterThan(0)
    expect(requestsWith('Also flag anything over R 10,000')).toBeGreaterThan(0)
    expect((await rows(db)).filter((row) => row.kind === 'helper')).toHaveLength(0)
  })

  it('runs different work alongside, leaves a summary block, and tells the agent on its next turn', async () => {
    fake = await startFakeAi(script(() => 'DIFFERENT'))
    const { runner, store: db } = make({ helpers: true })

    const running = runner.send('SLOW reconcile the statements')
    await waitFor(() => gates.length === 1)
    await runner.send("What's the weather in Durban on Friday?")

    const user = (await rows(db)).find((row) => row.text === "What's the weather in Durban on Friday?")
    expect(meta(user)['route']).toBe('alongside')
    expect(requestsWith('You sort one message')).toBe(1)
    const side = await waitFor(async () => {
      const helper = (await rows(db)).find((row) => row.kind === 'helper')
      return helper !== undefined && meta(helper)['state'] === 'done' ? helper : null
    }, 5000)
    expect(meta(side)['side']).toBe(true)
    expect(meta(side)['ask']).toBe(user?.id)
    expect(String(meta(side)['result'])).toContain('Side done')
    // The first job is still going: the separate one did not wait for it, and did not start a new main turn.
    expect(runner.state(MAIN_CHAT).running).toBe(true)

    for (const release of gates.splice(0)) release()
    await running
    expect(requestsWith('Done alongside while you were busy')).toBe(0)

    await runner.send('thanks, what next?')
    expect(requestsWith('Done alongside while you were busy')).toBe(1)
    expect(meta((await rows(db)).find((row) => row.id === side.id))['told']).toBe(true)
  })

  it('joins when the classifier is unsure, and when there is no way to run work alongside', async () => {
    fake = await startFakeAi(script(() => 'UNSURE'))
    const unsure = make({ helpers: true })
    const running = unsure.runner.send('SLOW plan the trip')
    await waitFor(() => gates.length === 1)
    await unsure.runner.send('Book the hotel near the beach')
    expect(meta((await rows(unsure.store)).find((row) => row.text === 'Book the hotel near the beach'))['route']).toBe('join')
    for (const release of gates.splice(0)) release()
    await running
    expect(requestsWith('Book the hotel near the beach')).toBeGreaterThan(1)
  })

  it('never loses a joined message when the person presses Stop: it starts the next turn', async () => {
    fake = await startFakeAi(script())
    const { runner, store: db } = make()

    const running = runner.send('SLOW a long job')
    await waitFor(() => gates.length === 1)
    await runner.send('Actually, only do the first half')
    runner.stop()
    await running
    await waitFor(async () => (await rows(db)).some((row) => row.kind === 'agent' && row.text.includes('only do the first half')), 4000)

    const all = await rows(db)
    expect(all.some((row) => row.kind === 'notice' && row.text === 'Stopped')).toBe(true)
    expect(runner.state().running).toBe(false)
  })

  it('moves a joined message alongside when the run has not read it for too long', async () => {
    fake = await startFakeAi(script())
    const { runner, store: db } = make({ helpers: true, joinPickupMs: 150 })

    const running = runner.send('SLOW a step that hangs')
    await waitFor(() => gates.length === 1)
    await runner.send('also add the totals at the bottom')
    expect(meta((await rows(db)).find((row) => row.text === 'also add the totals at the bottom'))['route']).toBe('join')

    const moved = await waitFor(async () => {
      const row = (await rows(db)).find((item) => item.text === 'also add the totals at the bottom')
      return meta(row)['route'] === 'alongside' ? row : null
    }, 3000)
    expect(meta(moved)['routeWhy']).toBe('slow')
    expect((await rows(db)).some((row) => row.kind === 'helper' && meta(row)['ask'] === moved.id)).toBe(true)

    for (const release of gates.splice(0)) release()
    await running
    // The run never got it as well: it went one way only.
    const mainCalls = (fake?.requests ?? []).filter(
      (request) => !JSON.stringify(request.body).includes('were already busy') && JSON.stringify(request.body).includes('also add the totals'),
    )
    expect(mainCalls).toHaveLength(0)
  })

  it('answers a message whose run ended while it was being sorted, as the next turn', async () => {
    fake = await startFakeAi(script())
    let decide: (verdict: 'different') => void = () => undefined
    const classifier: Classifier = () => new Promise((resolve) => { decide = resolve })
    const { runner, store: db } = make({ helpers: true, classifier })

    const running = runner.send('SLOW short job')
    await waitFor(() => gates.length === 1)
    const sending = runner.send('Order more printer paper')
    await sleep(50)
    for (const release of gates.splice(0)) release()
    await running
    decide('different')
    await sending

    const user = (await rows(db)).find((row) => row.text === 'Order more printer paper')
    expect(meta(user)['route']).toBeUndefined()
    expect((await rows(db)).some((row) => row.kind === 'agent' && row.text.includes('Order more printer paper'))).toBe(true)
    expect((await rows(db)).filter((row) => row.kind === 'helper')).toHaveLength(0)
  })

  it('on a plan, pauses the turn and resumes the same session with the joined message', async () => {
    const prompts: string[] = []
    const cli = {
      turn: async (request: CliTurnRequest) => {
        prompts.push(request.prompt)
        if (prompts.length === 1) {
          await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
          return { text: '' }
        }
        await request.onEvent({ type: 'said', text: 'Carried on with the change.' })
        return { text: 'Carried on with the change.' }
      },
    } as unknown as CliHost
    const { runner, store: db } = make({ settings: { mode: 'subscription', cli: 'claude' }, cli, classifier: null })

    const running = runner.send('Write the quarterly summary')
    await waitFor(() => prompts.length === 1)
    await runner.send('Actually make it two pages, not one')
    await running

    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('You were paused mid-step')
    expect(prompts[1]).toContain('Actually make it two pages, not one')
    const all = await rows(db)
    expect(all.some((row) => row.kind === 'notice' && row.text === 'Stopped')).toBe(false)
    expect(all.some((row) => row.kind === 'agent' && row.text === 'Carried on with the change.')).toBe(true)
  })
})
