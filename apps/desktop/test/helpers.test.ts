import { createServer, type Server } from 'node:http'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  providerFor,
  type ChatEvent,
  type ChatItem,
  type JsonObject,
  type Settings,
  type Tool,
} from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { StepBudget } from '../src/main/runtime/budget'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

let store: Store | null = null
let fake: FakeAi | null = null
let server: Server | null = null
const managers: HelperManager[] = []
const runners: Runner[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  for (const manager of managers.splice(0)) await manager.stopAll()
  store?.close()
  store = null
  await fake?.close()
  fake = null
  if (server !== null) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = null
  }
})

const READY: Partial<Settings> = {
  hasKey: true,
  mode: 'api_key',
  provider: 'openai',
  model: 'fake-model',
  allowHttp: true,
  notifications: false,
}

function database(): Store {
  store ??= new Store(':memory:')
  return store
}

function providerFactory() {
  if (fake === null) throw new Error('no fake AI server')
  return providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true })
}

interface ManagerHarness {
  manager: HelperManager
  delivered: string[]
  store: Store
}

function makeManager(options: { extraWorkerTools?: Tool[]; maxConcurrent?: number } = {}): ManagerHarness {
  const db = database()
  const delivered: string[] = []
  const manager = new HelperManager({
    store: db,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    providerFactory: () => providerFactory(),
    workerTools: [...buildWorkerToolset({ store: db }), ...(options.extraWorkerTools ?? [])],
    deliver: (note) => {
      delivered.push(note)
    },
    platform: 'linux',
    timeZone: 'UTC',
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
  })
  managers.push(manager)
  return { manager, delivered, store: db }
}

interface RunnerHarness {
  runner: Runner
  manager: HelperManager
  events: ChatEvent[]
  store: Store
}

function makeRunner(options: { extraWorkerTools?: Tool[] } = {}): RunnerHarness {
  const db = database()
  const budget = new StepBudget()
  const events: ChatEvent[] = []
  let runner: Runner | null = null
  const manager = new HelperManager({
    store: db,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    providerFactory: () => providerFactory(),
    workerTools: [...buildWorkerToolset({ store: db }), ...(options.extraWorkerTools ?? [])],
    deliver: (note) => {
      if (runner !== null) void runner.deliver(note)
    },
    platform: 'linux',
    timeZone: 'UTC',
  })
  managers.push(manager)
  runner = new Runner({
    store: db,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    tools: buildToolset({ store: db, helpers: manager, mainBudget: budget }),
    helpers: manager,
    budget,
    providerFactory: () => providerFactory(),
    emit: (event) => events.push(event),
    isFocused: () => false,
    timeZone: 'UTC',
  })
  runners.push(runner)
  return { runner, manager, events, store: db }
}

function lastMessage(body: JsonObject): Record<string, unknown> | undefined {
  const messages = body['messages']
  if (!Array.isArray(messages)) return undefined
  const last = messages[messages.length - 1]
  return typeof last === 'object' && last !== null && !Array.isArray(last)
    ? (last as Record<string, unknown>)
    : undefined
}

function hasToolResult(body: JsonObject): boolean {
  const messages = body['messages']
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      !Array.isArray(message) &&
      (message as Record<string, unknown>)['role'] === 'tool',
  )
}

function isHelperRequest(body: JsonObject): boolean {
  return JSON.stringify(body).includes('You are a HELPER')
}

function meta(row: ChatItem): Record<string, unknown> {
  return JSON.parse(row.meta) as Record<string, unknown>
}

async function helperRow(db: Store): Promise<ChatItem> {
  return waitFor(async () => {
    const rows = await db.list('chat_item')
    return rows.find((row) => row.kind === 'helper')
  })
}

describe('HelperManager', () => {
  it('runs a helper from delegate and hands its result back to the main agent as a new turn', async () => {
    const pauseTool: Tool = {
      spec: { name: 'pause_tool', description: 'Pauses for a moment.', schema: { type: 'object', properties: {} } },
      run: async () => {
        await sleep(80)
        return 'paused'
      },
    }
    fake = await startFakeAi((body) => {
      if (isHelperRequest(body)) {
        return hasToolResult(body)
          ? { text: 'The price is R120 at Shop A.' }
          : { toolCalls: [{ name: 'pause_tool', input: {} }] }
      }
      const last = lastMessage(body)
      if (last?.['role'] === 'tool') return { text: 'On it, I will check the price.' }
      if (JSON.stringify(last ?? {}).includes('[Helper #')) return { text: 'The widget costs R120.' }
      return {
        toolCalls: [
          {
            name: 'delegate',
            input: { tasks: [{ label: 'Price check', brief: 'Find the price of the widget.' }] },
          },
        ],
      }
    })
    const { runner, store: db } = makeRunner({ extraWorkerTools: [pauseTool] })

    await runner.send('Find the widget price')

    const rows = await waitFor(async () => {
      const items = await db.list('chat_item')
      return items.some((row) => row.kind === 'agent' && row.text === 'The widget costs R120.')
        ? items
        : null
    })
    const helper = rows.find((row) => row.kind === 'helper')
    expect(helper).toBeDefined()
    expect(meta(helper as ChatItem)).toMatchObject({ label: 'Price check', state: 'done' })
    expect(meta(helper as ChatItem)['summary']).toContain('R120')

    const turns = await db.list('turn')
    const main = turns.filter((row) => row.thread === 'main')
    const note = main.find((row) => row.json.includes('[Helper #'))
    expect(note).toBeDefined()
    expect(note?.json).toContain('finished]')
    expect(note?.json).toContain('The price is R120 at Shop A.')

    const helperTurns = turns.filter((row) => row.thread === helper?.id)
    expect(helperTurns.length).toBeGreaterThanOrEqual(2)
  })

  it('a helper tool call is a few writes, not a storm: the window hears each row once', async () => {
    const quick: Tool = {
      spec: { name: 'quick_tool', description: 'Answers at once.', schema: { type: 'object', properties: {} } },
      run: async () => 'done',
    }
    fake = await startFakeAi((body) => {
      if (isHelperRequest(body)) return hasToolResult(body) ? { text: 'Finished.' } : { toolCalls: [{ name: 'quick_tool', input: {} }] }
      const last = lastMessage(body)
      if (last?.['role'] === 'tool') return { text: 'On it.' }
      if (JSON.stringify(last ?? {}).includes('[Helper #')) return { text: 'All done.' }
      return { toolCalls: [{ name: 'delegate', input: { tasks: [{ label: 'Quick', brief: 'Do the quick thing.' }] } }] }
    })
    const { runner, store: db } = makeRunner({ extraWorkerTools: [quick] })
    const writes: string[] = []
    db.onChange((change) => {
      if (change.entity === 'chat_item' && change.row !== undefined) writes.push((change.row as ChatItem).kind)
    })
    await runner.send('Do the quick thing')
    await waitFor(async () => ((await db.list('chat_item')).some((row) => row.kind === 'agent' && row.text === 'All done.') ? true : null))
    await sleep(250)
    const helperWrites = writes.filter((kind) => kind === 'helper').length
    const activityWrites = writes.filter((kind) => kind === 'activity').length
    // The helper's row: made, working, then done (its passing summaries fold into those); its one step: started, finished.
    mkdirSync(join(process.cwd(), '.night'), { recursive: true })
    writeFileSync(join(process.cwd(), '.night', 'helper-writes.json'), JSON.stringify({ helper: helperWrites, activity: activityWrites, all: writes.length, kinds: writes }))
    expect(helperWrites).toBeLessThanOrEqual(5)
    expect(activityWrites).toBeLessThanOrEqual(5)
  })

  it("keeps each helper tool call's input and result on its step, so the row opens like the main agent's", async () => {
    const evalTool: Tool = {
      spec: {
        name: 'page_eval',
        description: 'Runs a script in the page.',
        schema: { type: 'object', properties: { js: { type: 'string' } } },
      },
      run: async () => 'Example Domain',
    }
    fake = await startFakeAi((body) => {
      if (isHelperRequest(body)) {
        return hasToolResult(body) ? { text: 'The title is Example Domain.' } : { toolCalls: [{ name: 'page_eval', input: { js: 'document.title' } }] }
      }
      const last = lastMessage(body)
      if (last?.['role'] === 'tool') return { text: 'Checking.' }
      if (JSON.stringify(last ?? {}).includes('[Helper #')) return { text: 'It is Example Domain.' }
      return { toolCalls: [{ name: 'delegate', input: { tasks: [{ label: 'Title', brief: 'Read the page title.' }] } }] }
    })
    const { runner, store: db } = makeRunner({ extraWorkerTools: [evalTool] })

    await runner.send('What is the page title?')

    const step = await waitFor(async () => {
      const items = await db.list('chat_item')
      return items.find((row) => row.kind === 'activity' && meta(row)['tool'] === 'page_eval' && meta(row)['status'] === 'done')
    })
    expect(meta(step)['helper']).toBeTruthy()
    expect(meta(step)['run']).toMatchObject({
      kind: 'tool',
      label: 'page eval',
      input: 'document.title',
      stdout: 'Example Domain',
      state: 'ok',
    })
  })

  it('runs two helpers at the same time', async () => {
    let arrived = 0
    let open: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      open = resolve
    })
    const waitTool: Tool = {
      spec: { name: 'wait_tool', description: 'Waits for the other helper.', schema: { type: 'object', properties: {} } },
      run: async () => {
        arrived++
        if (arrived >= 2) open?.()
        await gate
        return 'ok'
      },
    }
    fake = await startFakeAi((body) =>
      hasToolResult(body) ? { text: 'Done.' } : { toolCalls: [{ name: 'wait_tool', input: {} }] },
    )
    const { manager, delivered } = makeManager({ extraWorkerTools: [waitTool] })

    await manager.delegate([
      { label: 'One', brief: 'Do job one.' },
      { label: 'Two', brief: 'Do job two.' },
    ])

    await waitFor(() => delivered.length === 2, 5_000)
    expect(arrived).toBe(2)
    expect(manager.live()).toEqual([])
  })

  it('delivers a steer message before the helper takes its next step', async () => {
    let started = false
    let release: (() => void) | null = null
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const holdTool: Tool = {
      spec: { name: 'hold_tool', description: 'Holds until told.', schema: { type: 'object', properties: {} } },
      run: async () => {
        started = true
        await held
        return 'held'
      },
    }
    fake = await startFakeAi((body) =>
      hasToolResult(body) ? { text: 'Used the blue one.' } : { toolCalls: [{ name: 'hold_tool', input: {} }] },
    )
    const { manager, delivered, store: db } = makeManager({ extraWorkerTools: [holdTool] })

    await manager.delegate([{ label: 'Colour', brief: 'Pick a colour.' }])
    await waitFor(() => started)
    const row = await helperRow(db)
    const answer = await manager.steer(row.id, 'The user means the blue one.')

    expect(answer).toContain('before its next step')
    release?.()
    await waitFor(() => delivered.length === 1, 5_000)
    expect(fake.requests.some((request) => JSON.stringify(request.body).includes('The user means the blue one.'))).toBe(
      true,
    )
  })

  it('stops a helper without reporting a result', async () => {
    let started = false
    let release: (() => void) | null = null
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const slowTool: Tool = {
      spec: { name: 'slow_tool', description: 'Takes a while.', schema: { type: 'object', properties: {} } },
      run: async () => {
        started = true
        await held
        return 'done'
      },
    }
    fake = await startFakeAi(() => ({ toolCalls: [{ name: 'slow_tool', input: {} }] }))
    const { manager, delivered, store: db } = makeManager({ extraWorkerTools: [slowTool] })

    await manager.delegate([{ label: 'Slow', brief: 'Take your time.' }])
    await waitFor(() => started)
    const row = await helperRow(db)
    expect(await manager.stop(row.id)).toBe(true)
    release?.()

    const stopped = await waitFor(async () => {
      const latest = await db.get('chat_item', row.id)
      return latest !== null && meta(latest)['state'] === 'stopped' ? latest : null
    })
    expect(meta(stopped)['summary']).toBe('Stopped')
    await sleep(20)
    expect(delivered).toHaveLength(0)
  })

  it('runs at most four helpers and queues the rest', async () => {
    let current = 0
    let peak = 0
    const slowTool: Tool = {
      spec: { name: 'slow_tool', description: 'Takes a while.', schema: { type: 'object', properties: {} } },
      run: async () => {
        current++
        peak = Math.max(peak, current)
        await sleep(120)
        current--
        return 'done'
      },
    }
    fake = await startFakeAi((body) =>
      hasToolResult(body) ? { text: 'Finished.' } : { toolCalls: [{ name: 'slow_tool', input: {} }] },
    )
    const { manager, delivered } = makeManager({ extraWorkerTools: [slowTool] })

    const tasks = Array.from({ length: 5 }, (_, index) => ({
      label: `Job ${index + 1}`,
      brief: `Do job number ${index + 1}.`,
    }))
    await manager.delegate(tasks)

    expect(manager.live()).toHaveLength(5)
    await waitFor(() => delivered.length === 5, 8_000)
    expect(peak).toBe(4)
  })

  it('nudges the main agent to push a helper that gave up', async () => {
    fake = await startFakeAi(() => ({ text: "I couldn't find the price anywhere." }))
    const { manager, delivered } = makeManager()

    await manager.delegate([{ label: 'Prices', brief: 'Find the price.' }])
    await waitFor(() => delivered.length === 1, 5_000)

    expect(delivered[0]).toContain('[Helper #')
    expect(delivered[0]).toContain('finished]')
    expect(delivered[0]).toContain('helper_push')
    expect(delivered[0]).toContain("It says it couldn't do all of it")
  })

  it('sends a finished helper back to work with helper_push and keeps its conversation', async () => {
    fake = await startFakeAi((body) => {
      const raw = JSON.stringify(body)
      if (raw.includes('Try the second shop')) return { text: 'Found it at the second shop: R99.' }
      return { text: "I couldn't find the price." }
    })
    const { manager, delivered, store: db } = makeManager()

    await manager.delegate([{ label: 'Prices', brief: 'Find the price of the widget.' }])
    await waitFor(() => delivered.length === 1, 5_000)
    const row = await helperRow(db)

    const answer = await manager.push(row.id, 'Try the second shop. You can do this.')
    expect(answer).toContain('back on it')

    await waitFor(() => delivered.length === 2, 5_000)
    expect(delivered[1]).toContain('Found it at the second shop: R99.')
    expect(delivered[1]).toContain('(after 1 push)')

    const turns = (await db.list('turn')).filter((turn) => turn.thread === row.id)
    expect(turns.length).toBeGreaterThanOrEqual(3)
    expect(turns.some((turn) => turn.json.includes('Try the second shop'))).toBe(true)
  })

  it('holds together results until every helper in the batch is done', async () => {
    fake = await startFakeAi((body) => {
      const raw = JSON.stringify(body)
      if (raw.includes('Job A')) return { text: 'A is done.' }
      if (raw.includes('Job B')) return { text: 'B is done.' }
      return { text: 'Something is done.' }
    })
    const { manager, delivered } = makeManager()

    await manager.delegate(
      [
        { label: 'A', brief: 'Job A' },
        { label: 'B', brief: 'Job B' },
      ],
      true,
    )
    await waitFor(() => delivered.length === 1, 5_000)

    expect(delivered[0]).toContain('[Helpers finished: all 2')
    expect(delivered[0]).toContain('A is done.')
    expect(delivered[0]).toContain('B is done.')
  })

  it('reports what helpers are doing and what they returned', async () => {
    fake = await startFakeAi(() => ({ text: 'The answer is 42.' }))
    const { manager } = makeManager()

    await manager.delegate([{ label: 'Answer', brief: 'Work out the answer.' }])
    await waitFor(async () => (await manager.status()).includes('Result: The answer is 42.'))

    const report = await manager.status()
    expect(report).toContain('#')
    expect(report).toContain('Answer [done, 0m]')
    expect(report).toContain('Brief: Work out the answer.')
  })

  it('marks helpers left working by a closed app as failed on restore', async () => {
    const db = database()
    const row = await db.upsert('chat_item', {
      kind: 'helper',
      text: 'Do the old job.',
      meta: JSON.stringify({ id: '', label: 'Old', state: 'working', summary: 'Thinking' }),
    })
    const { manager } = makeManager()

    await manager.restore()

    const restored = await db.get('chat_item', row.id)
    expect(meta(restored as ChatItem)).toMatchObject({
      state: 'failed',
      summary: 'Interrupted when the app closed.',
    })
  })

  it('puts the helper tools on the main toolset only', async () => {
    const db = database()
    const { manager } = makeManager()
    const main = buildToolset({ store: db, helpers: manager }).map((tool) => tool.spec.name)
    const worker = buildWorkerToolset({ store: db }).map((tool) => tool.spec.name)

    expect(main).toEqual(
      expect.arrayContaining([
        'delegate',
        'helper_steer',
        'helper_push',
        'helpers_status',
        'helper_stop',
      ]),
    )
    for (const name of ['delegate', 'helper_steer', 'helper_push', 'helpers_status', 'helper_stop']) {
      expect(worker).not.toContain(name)
    }
  })
})

describe('the main agent action budget', () => {
  it('stops the main agent at five action steps and tells it to delegate', async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('A fetched page.')
    })
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test server did not bind')

    fake = await startFakeAi((body) => {
      if (hasToolResult(body)) return { text: 'Hit the limit.' }
      return {
        toolCalls: Array.from({ length: 6 }, () => ({
          name: 'web_fetch',
          input: { url: `http://127.0.0.1:${address.port}/page` },
        })),
      }
    })
    const { runner } = makeRunner()

    await runner.send('Fetch six pages')

    const second = JSON.stringify(fake.requests[1]?.body ?? {})
    expect(second).toContain('A fetched page.')
    expect(second).toContain('Step limit')
    expect(second).toContain('hand it to a helper with delegate')
  })
})
