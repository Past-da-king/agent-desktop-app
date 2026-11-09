/**
 * A helper never ends silently (0.2.76): whatever ends a helper's run, the agent that started it gets exactly one
 * notice that wakes it, saying what happened. Each exit path is checked here: done, stopped, its AI failing (an
 * error, a rate limit, a timeout), out of steps, stopped before it started, the app restarting under it, the brain
 * it ran on going offline, a parent that is busy (it hears once its run is free), a parent chat that is gone (the
 * main thread hears), and the quiet watch (one heads-up per run).
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  MAIN_CHAT,
  ProviderException,
  providerFor,
  schema,
  type ChatItem,
  type JsonObject,
  type LlmProvider,
  type Settings,
  type Tool,
} from '@agent/core'

import { startFakeAi, type FakeAi, type FakeReply } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperManager, type OffloadLink } from '../src/main/runtime/helpers'
import { Runner } from '../src/main/runtime/runner'
import { TurnLeases, type LeaseHook } from '../src/main/runtime/turns'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = {
  hasKey: true,
  mode: 'api_key',
  provider: 'openai',
  model: 'fake-model',
  allowHttp: true,
  notifications: false,
}

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
})

interface Delivery {
  note: string
  chat: string
}

interface Harness {
  manager: HelperManager
  db: Store
  delivered: Delivery[]
  fake: FakeAi | null
}

function isHelperRequest(body: JsonObject): boolean {
  return JSON.stringify(body).includes('You are a HELPER')
}

/** A step that waits until it is released or the run is stopped. */
function gate(): { tool: Tool; started: () => number; release: () => void } {
  let count = 0
  const waiting: Array<() => void> = []
  return {
    started: () => count,
    release: () => {
      for (const go of waiting.splice(0)) go()
    },
    tool: {
      spec: { name: 'slow_step', description: 'A long step.', schema: schema([], {}) },
      run: (_input, ctx) =>
        new Promise<string>((resolve) => {
          count += 1
          waiting.push(() => resolve('step done'))
          ctx.signal.addEventListener('abort', () => resolve('cut off'), { once: true })
        }),
    },
  }
}

/** An AI that always fails the same way, without the HTTP retries (a rate limit, a timeout, an error). */
function failing(error: Error): LlmProvider {
  return {
    name: 'failing',
    complete: async () => {
      throw error
    },
  }
}

async function harness(options: {
  script?: (body: JsonObject, index: number) => FakeReply
  provider?: LlmProvider
  tools?: Tool[]
  now?: () => number
  maxConcurrent?: number
  maxSteps?: number
  quietMinutes?: number
  limitWaitMs?: (hit: number) => number
  db?: Store
  offload?: OffloadLink
  leases?: LeaseHook
}): Promise<Harness> {
  const db = options.db ?? new Store(':memory:')
  const fake = options.script === undefined ? null : await startFakeAi(options.script)
  const delivered: Delivery[] = []
  const manager = new HelperManager({
    store: db,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    providerFactory: () => options.provider ?? providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake?.url ?? 'http://127.0.0.1:9', allowHttp: true }),
    workerTools: [...buildWorkerToolset({ store: db }), ...(options.tools ?? [])],
    deliver: (note, chat) => {
      delivered.push({ note, chat: chat ?? MAIN_CHAT })
    },
    platform: 'linux',
    timeZone: 'UTC',
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.quietMinutes === undefined ? {} : { quietMinutes: options.quietMinutes }),
    ...(options.limitWaitMs === undefined ? {} : { limitWaitMs: options.limitWaitMs }),
    ...(options.offload === undefined ? {} : { offload: options.offload }),
    ...(options.leases === undefined ? {} : { leases: options.leases }),
  })
  cleanups.push(async () => {
    await manager.stopAll()
    await sleep(20)
    manager.shutdown()
    await fake?.close()
    if (options.db === undefined) db.close()
  })
  return { manager, db, delivered, fake }
}

function idOf(started: string): string {
  const match = /#([0-9a-f-]{36})/.exec(started)
  if (match?.[1] === undefined) throw new Error(`no helper id in: ${started}`)
  return match[1]
}

function meta(row: ChatItem | null): Record<string, unknown> {
  return row === null ? {} : (JSON.parse(row.meta) as Record<string, unknown>)
}

/** Waits for the first notice, then a little longer, so a second one would have shown up. */
async function settledNotices(delivered: Delivery[]): Promise<Delivery[]> {
  await waitFor(() => delivered.length > 0, 8_000)
  await sleep(150)
  return delivered
}

describe('a helper never ends silently', () => {
  it('done: its creator gets the result once', async () => {
    const { manager, delivered } = await harness({ script: () => ({ text: 'The answer is 42.' }) })
    await manager.delegate([{ label: 'Answer', brief: 'Work out the answer.' }])
    const notes = await settledNotices(delivered)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.note).toContain('finished]')
    expect(notes[0]?.note).toContain('The answer is 42.')
  })

  it('stopped with helper_stop: its creator is told who stopped it, once, and the card says so', async () => {
    const step = gate()
    const { manager, delivered, db } = await harness({
      script: (body) => (isHelperRequest(body) ? { text: 'Looking into the first part.', toolCalls: [{ name: 'slow_step', input: {} }] } : { text: 'ok' }),
      tools: [step.tool],
    })
    const id = idOf(await manager.delegate([{ label: 'Long job', brief: 'Do the long job.' }]))
    await waitFor(() => step.started() > 0, 8_000)
    expect(await manager.stop(id, 'the agent (helper_stop)')).toBe(true)
    const notes = await settledNotices(delivered)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.note).toMatch(/^\[Helper #[0-9a-f-]+ "Long job" stopped: stopped by the agent \(helper_stop\), after under a minute\./)
    expect(notes[0]?.note).toContain('Last step:')
    expect(notes[0]?.note).toContain('Looking into the first part.')
    const row = await db.get('chat_item', id)
    expect(meta(row)).toMatchObject({ state: 'stopped', endReason: 'stopped by the agent (helper_stop)' })
    expect(String(meta(row)['summary'])).toContain('Stopped: stopped by the agent')
    // Stopping it again, or the run settling late, never sends a second notice.
    await manager.stop(id, 'the person (Stop on its card)')
    await sleep(100)
    expect(delivered).toHaveLength(1)
  })

  it('stopped while still waiting its turn: its creator is told it never started', async () => {
    const step = gate()
    const { manager, delivered } = await harness({
      script: () => ({ toolCalls: [{ name: 'slow_step', input: {} }] }),
      tools: [step.tool],
      maxConcurrent: 1,
    })
    await manager.delegate([{ label: 'First', brief: 'Do the first job.' }])
    const second = idOf(await manager.delegate([{ label: 'Second', brief: 'Do the second job.' }]))
    await waitFor(() => step.started() > 0, 8_000)
    await manager.stop(second, 'the person (Stop on its card)')
    const notes = await settledNotices(delivered)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.note).toContain('"Second" stopped: stopped by the person (Stop on its card) before it started')
  })

  it('an error from its AI: its creator is told the reason', async () => {
    const { manager, delivered } = await harness({ script: () => ({ status: 400, text: 'model refused the request' }) })
    await manager.delegate([{ label: 'Broken', brief: 'Try the thing.' }])
    const notes = await settledNotices(delivered)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.note).toContain('"Broken" failed: Something went wrong: HTTP 400: model refused the request')
  })

  it('a rate limit: its creator is told, once', async () => {
    const { manager, delivered, db } = await harness({ provider: failing(new ProviderException('HTTP 429: Too many requests', 429, false)) })
    const id = idOf(await manager.delegate([{ label: 'Busy AI', brief: 'Try the thing.' }]))
    const notes = await settledNotices(delivered)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.note).toContain('failed: The AI provider says we are sending too much right now (rate limit or out of credit)')
    expect(meta(await db.get('chat_item', id))).toMatchObject({ state: 'failed' })
  })

  it('a rate limit: it is not pushed again and again; it waits, retries by itself a few times, and its creator hears twice at most', async () => {
    let calls = 0
    const limited: LlmProvider = {
      name: 'limited',
      complete: async () => {
        calls += 1
        throw new ProviderException('HTTP 429: Too many requests', 429, false)
      },
    }
    const { manager, delivered, db } = await harness({ provider: limited, limitWaitMs: () => 500 })
    const id = idOf(await manager.delegate([{ label: 'Busy AI', brief: 'Try the thing.' }]))
    await waitFor(() => delivered.length > 0, 8_000)
    expect(delivered[0]?.note).toContain('goes back to work by itself')
    expect(delivered[0]?.note).not.toContain('Push at least twice')
    // The agent that started it pushes it anyway, 30 times: none of them reaches the AI.
    const before = calls
    for (let i = 0; i < 30; i += 1) expect(await manager.push(id, 'You can do it, try again.')).toContain('Kept for it, not sent yet.')
    expect(calls).toBe(before)
    // It goes back by itself after each wait: three retries, then it is left failed and its creator hears once more.
    await waitFor(() => delivered.length > 1, 10_000)
    await sleep(700)
    expect(calls).toBe(4)
    expect(delivered).toHaveLength(2)
    expect(delivered[1]?.note).toContain('It went back to work by itself 3 times')
    expect(meta(await db.get('chat_item', id))).toMatchObject({ state: 'failed' })
  })

  it('a rate limit that resets: the helper carries on by itself and hands back its result', async () => {
    let calls = 0
    const { manager, delivered } = await harness({
      limitWaitMs: () => 150,
      provider: {
        name: 'limited-once',
        complete: async () => {
          calls += 1
          if (calls === 1) throw new ProviderException('HTTP 429: Too many requests', 429, false)
          return { message: { role: 'ASSISTANT', blocks: [{ t: 'text', text: 'All done after the wait.' }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      },
    })
    await manager.delegate([{ label: 'Busy AI', brief: 'Try the thing.' }])
    await waitFor(() => delivered.length > 1, 8_000)
    expect(delivered).toHaveLength(2)
    expect(delivered[1]?.note).toContain('All done after the wait.')
  })

  it('a message sent to a helper that waits for the limit is kept and read when it goes back to work', async () => {
    let calls = 0
    let second = ''
    const { manager, delivered, db } = await harness({
      limitWaitMs: () => 600,
      provider: {
        name: 'limited-once',
        complete: async (_system, messages) => {
          calls += 1
          if (calls === 1) throw new ProviderException('HTTP 429: Too many requests', 429, false)
          second = JSON.stringify(messages)
          return { message: { role: 'ASSISTANT', blocks: [{ t: 'text', text: 'Did both.' }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }
        },
      },
    })
    const id = idOf(await manager.delegate([{ label: 'Busy AI', brief: 'Try the thing.' }]))
    await waitFor(() => delivered.length > 0, 8_000)
    const said = await manager.steer(id, 'Also check the cart page.')
    expect(said).toContain('Kept for it, not sent yet.')
    expect(said).toContain('waiting for the AI limit to reset')
    expect(calls).toBe(1)
    expect(JSON.stringify(meta(await db.get('chat_item', id))['limitQueue'])).toContain('Also check the cart page.')
    await waitFor(() => delivered.length > 1, 8_000)
    expect(second).toContain('Also check the cart page.')
    expect(delivered[1]?.note).toContain('Did both.')
  })

  it('a restart while a helper waits for the limit: the wait carries on from its card and it retries', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const first = await harness({ db, limitWaitMs: () => 60_000, provider: failing(new ProviderException('HTTP 429: Too many requests', 429, false)) })
    const id = idOf(await first.manager.delegate([{ label: 'Busy AI', brief: 'Try the thing.' }]))
    await waitFor(() => first.delivered.length > 0, 8_000)
    expect(Number(meta(await db.get('chat_item', id))['limitRetryAt'])).toBeGreaterThan(Date.now())
    // The app closes: the timer dies with the process.
    first.manager.shutdown()
    // It starts again after the retry time has passed: the helper goes back to work at once.
    const second = await harness({
      db,
      now: () => Date.now() + 120_000,
      provider: { name: 'fine', complete: async () => ({ message: { role: 'ASSISTANT', blocks: [{ t: 'text', text: 'Done after the restart.' }] }, stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 } }) },
    })
    await second.manager.restore()
    await waitFor(() => second.delivered.length > 0, 8_000)
    expect(second.delivered[0]?.note).toContain('Done after the restart.')
    expect(meta(await db.get('chat_item', id))).toMatchObject({ state: 'done', limitRetryAt: 0 })
  })

  it('a timeout: its creator is told, once', async () => {
    const { manager, delivered } = await harness({ provider: failing(new ProviderException('The AI service did not answer within 120 seconds.', 0, true)) })
    await manager.delegate([{ label: 'Slow AI', brief: 'Try the thing.' }])
    const notes = await settledNotices(delivered)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.note).toContain('failed: The AI service did not answer within 120 seconds.')
  })

  it('out of steps: its creator is told it used every step it may take', async () => {
    const { manager, delivered } = await harness({ script: () => ({ toolCalls: [{ name: 'now', input: {} }] }), maxSteps: 1 })
    await manager.delegate([{ label: 'Many steps', brief: 'Keep going.' }])
    const notes = await settledNotices(delivered)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.note).toContain('"Many steps" ended: it used all 1 steps a helper may take')
  })

  it('the app restarted under it: ended once on the next start, with its lease closed so nothing resumes it silently', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const row = await db.upsert('chat_item', {
      kind: 'helper',
      text: 'Do the old job.',
      meta: JSON.stringify({ id: '', label: 'Old job', state: 'working', summary: 'Reading the second page', runToken: 'run-one', startedAt: Date.now() - 5 * 60_000 }),
    })
    await db.upsert('turn_lease', { id: `job-${row.id}`, kind: 'job', chatId: MAIN_CHAT, messageId: row.id, brainId: db.deviceId, status: 'running', attempt: 1, startedAt: Date.now(), heartbeatAt: Date.now(), prompt: 'Do the old job.' })
    const first = await harness({ db })
    await first.manager.restore()
    expect(first.delivered).toHaveLength(1)
    expect(first.delivered[0]?.note).toContain('"Old job" failed: the app restarted, after 5 min. Last step: Reading the second page.')
    expect(meta(await db.get('chat_item', row.id))).toMatchObject({ state: 'failed', endReason: 'the app restarted', noticed: 'run-one' })
    expect((await db.get('turn_lease', `job-${row.id}`))?.status).toBe('failed')

    // Another start (or a second restore) never tells it again.
    const second = await harness({ db })
    await second.manager.restore()
    await first.manager.restore()
    expect(first.delivered).toHaveLength(1)
    expect(second.delivered).toHaveLength(0)
  })

  it('the app restarted under it and its lease sends it back to work: its creator is told so, once', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const leases = new TurnLeases({ store: db, selfId: () => 'brain-x', resumeTurn: () => undefined, resumeJob: () => undefined })
    cleanups.push(() => leases.stop())
    const row = await db.upsert('chat_item', {
      kind: 'helper',
      text: 'Do the job.',
      meta: JSON.stringify({ id: '', label: 'Resumed job', state: 'working', summary: 'Thinking', runToken: 'run-two', startedAt: Date.now() }),
    })
    await db.upsert('turn_lease', { id: `job-${row.id}`, kind: 'job', chatId: MAIN_CHAT, messageId: row.id, brainId: 'brain-x', status: 'running', attempt: 1, startedAt: Date.now(), heartbeatAt: Date.now(), prompt: 'Do the job.' })
    const { manager, delivered } = await harness({ db, leases })
    await manager.restore()
    await manager.restore()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.note).toContain('"Resumed job" was cut off: the app restarted, after under a minute. It is going back to work by itself')
    // Its lease is left for crash recovery, which sends it back to work.
    expect((await db.get('turn_lease', `job-${row.id}`))?.status).toBe('running')
  })

  it('quitting leaves a helper still working for the next start to report, instead of telling a runner that is gone', async () => {
    const step = gate()
    const { manager, delivered, db } = await harness({ script: () => ({ toolCalls: [{ name: 'slow_step', input: {} }] }), tools: [step.tool] })
    const id = idOf(await manager.delegate([{ label: 'Cut by quit', brief: 'Wait on the slow step.' }]))
    await waitFor(() => step.started() > 0, 8_000)
    manager.shutdown()
    await manager.stopAll()
    await sleep(150)
    expect(delivered).toHaveLength(0)
    expect(meta(await db.get('chat_item', id))).toMatchObject({ state: 'working' })
    const next = await harness({ db })
    await next.manager.restore()
    expect(next.delivered).toHaveLength(1)
    expect(next.delivered[0]?.note).toContain('"Cut by quit" failed: the app restarted')
  })

  it('crash recovery never takes a turn this process started (a notice sent at start-up) for a crash leftover', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const leases = new TurnLeases({ store: db, selfId: () => 'brain-x', resumeTurn: () => undefined, resumeJob: () => undefined })
    cleanups.push(() => leases.stop())
    const fresh = leases.begin({ kind: 'turn', chatId: MAIN_CHAT, messageId: '', prompt: '[Helper #x "Job" failed: the app restarted]' })
    await db.upsert('turn_lease', { id: 'lease-left-over', kind: 'turn', chatId: MAIN_CHAT, messageId: '', brainId: 'brain-x', status: 'running', attempt: 1, startedAt: 1, heartbeatAt: 1, prompt: 'Older request' })
    expect(await leases.recover()).toBe(1)
    expect((await db.get('turn_lease', fresh))?.status).toBe('running')
    expect((await db.get('turn_lease', 'lease-left-over'))?.status).toBe('interrupted')
  })

  it('a failed helper: what it had is what it wrote, not the error a second time', async () => {
    const { manager, delivered } = await harness({ script: () => ({ status: 400, text: 'model refused the request' }) })
    await manager.delegate([{ label: 'Broken twice', brief: 'Try the thing.' }])
    const notes = await settledNotices(delivered)
    expect(notes[0]?.note).toContain('What it had: nothing yet.')
    expect(notes[0]?.note.split('model refused the request')).toHaveLength(2)
  })

  it('held notices from a restart go out only when flushed (after the runner repaired its rows)', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    await db.upsert('chat_item', { kind: 'helper', text: 'Job.', meta: JSON.stringify({ id: '', label: 'Held', state: 'working', runToken: 'held-run' }) })
    const { manager, delivered } = await harness({ db })
    await manager.restore({ defer: true })
    expect(delivered).toHaveLength(0)
    manager.flushNotices()
    await waitFor(() => delivered.length === 1)
    expect(delivered[0]?.note).toContain('the app restarted')
  })

  it('the brain it ran on went offline mid-job: its creator is told once', async () => {
    let clock = 1_000_000
    let up = true
    const sent: Array<{ to: string; op: string }> = []
    const link: OffloadLink = {
      selfId: () => 'node-a',
      isSelf: (id) => id === 'node-a',
      up: (id) => id === 'node-b' && up,
      place: async () => ({ device: 'node-b', name: 'Server One', why: 'heavy work' }),
      send: async (to, op) => {
        sent.push({ to, op })
      },
      leaseHolder: async () => ({ device: 'node-b', running: true }),
      deviceName: async (id) => (id === 'node-b' ? 'Server One' : ''),
    }
    const { manager, delivered, db } = await harness({ script: () => ({ text: 'never' }), now: () => clock, offload: link })
    const id = idOf(await manager.delegate([{ label: 'Far job', brief: 'Research the market and compare.' }]))
    expect(sent).toEqual([{ to: 'node-b', op: 'start' }])
    up = false
    clock += 60_000
    expect(await manager.takeBack(45_000)).toBe(0)
    expect(delivered).toHaveLength(0)
    clock += 60_000
    await manager.takeBack(45_000)
    await manager.takeBack(45_000)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.note).toContain('"Far job" failed: Server One went offline while it worked')
    expect(meta(await db.get('chat_item', id))).toMatchObject({ state: 'failed' })
    expect(manager.live()).toHaveLength(0)
  })

  it('a result from an older brain that sends nothing for a stopped helper still tells its creator', async () => {
    const link: OffloadLink = {
      selfId: () => 'node-a',
      isSelf: (id) => id === 'node-a',
      up: () => true,
      place: async () => ({ device: 'node-b', name: 'Server One', why: 'heavy work' }),
      send: async () => undefined,
      leaseHolder: async () => ({ device: 'node-b', running: true }),
      deviceName: async () => 'Server One',
    }
    const { manager, delivered } = await harness({ script: () => ({ text: 'never' }), offload: link })
    const id = idOf(await manager.delegate([{ label: 'Far job', brief: 'Research the market and compare.' }]))
    const msg = { id: 'm1', kind: 'msg', device: 'node-a', from: 'node-b', helper: id, op: 'result', text: '', item: '', info: JSON.stringify({ state: 'stopped' }), status: 'sent', at: 1, createdAt: 1 }
    await manager.onRemote(msg as never)
    await manager.onRemote(msg as never)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.note).toContain('"Far job" stopped: it was stopped')
  })

  it('a parent chat that no longer exists: the main thread hears instead; a project chat that exists hears itself', async () => {
    const { manager, delivered, db } = await harness({ script: () => ({ text: 'All done.' }) })
    await db.upsert('project', { name: 'Example', description: '', path: '', profile: '', hidden: false, chats: ['project-chat'] } as never)
    await manager.delegate([{ label: 'Orphan', brief: 'Do it.' }], false, { chat: 'gone-chat' })
    await manager.delegate([{ label: 'Kept', brief: 'Do it.' }], false, { chat: 'project-chat' })
    await waitFor(() => delivered.length === 2, 8_000)
    await sleep(100)
    const orphan = delivered.find((each) => each.note.includes('"Orphan"'))
    const kept = delivered.find((each) => each.note.includes('"Kept"'))
    expect(orphan?.chat).toBe(MAIN_CHAT)
    expect(orphan?.note).toContain('started from a chat that no longer exists')
    expect(kept?.chat).toBe('project-chat')
    expect(delivered).toHaveLength(2)
  })

  it('the quiet watch: one heads-up per run after the set minutes with no new step, measured on its steps', async () => {
    let clock = 5_000_000
    const step = gate()
    const { manager, delivered } = await harness({
      script: (body) => (isHelperRequest(body) ? { toolCalls: [{ name: 'slow_step', input: {} }] } : { text: 'ok' }),
      tools: [step.tool],
      now: () => clock,
      quietMinutes: 10,
    })
    await manager.delegate([{ label: 'Stuck job', brief: 'Wait on the slow step.' }])
    await waitFor(() => step.started() > 0, 8_000)
    clock += 9 * 60_000
    expect(await manager.checkQuiet()).toBe(0)
    clock += 2 * 60_000
    expect(await manager.checkQuiet()).toBe(1)
    clock += 30 * 60_000
    expect(await manager.checkQuiet()).toBe(0)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.note).toContain('"Stuck job" has taken no new step for 11 min')
  })
})

describe('the parent agent actually wakes', () => {
  it('a busy main agent gets the notice once its run is free, exactly once, and replies to it', async () => {
    const step = gate()
    const db = new Store(':memory:')
    let runner: Runner | null = null
    let heard = 0
    const fake = await startFakeAi((body) => {
      const all = JSON.stringify(body['messages'] ?? [])
      if (isHelperRequest(body)) return { toolCalls: [{ name: 'slow_step', input: {} }] }
      const messages = body['messages'] as Array<Record<string, unknown>>
      const last = JSON.stringify(messages[messages.length - 1] ?? {})
      if (last.includes('stopped: stopped by the person')) {
        heard += 1
        return { text: 'Heard the helper stopped.' }
      }
      if (last.includes('Red')) return { text: 'Red it is.' }
      if (all.includes('Started: #')) return { toolCalls: [{ name: 'ask_user', input: { question: 'Which colour?', options: ['Red', 'Blue'] } }] }
      return { toolCalls: [{ name: 'delegate', input: { tasks: [{ label: 'Side job', brief: 'Do the side job.' }] } }] }
    })
    const manager = new HelperManager({
      store: db,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true }),
      workerTools: [...buildWorkerToolset({ store: db }), step.tool],
      deliver: (note, chat) => runner?.deliver(note, chat),
      platform: 'linux',
      timeZone: 'UTC',
    })
    runner = new Runner({
      store: db,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      tools: buildToolset({ store: db, helpers: manager }),
      helpers: manager,
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true }),
      emit: () => undefined,
      isFocused: () => false,
      timeZone: 'UTC',
    })
    cleanups.push(async () => {
      runner?.dispose()
      await manager.stopAll()
      await sleep(20)
      manager.shutdown()
      await fake.close()
      db.close()
    })

    void runner.send('Start the side job, then ask me a colour.')
    const question = await waitFor(async () => (await db.list('chat_item')).find((row) => row.kind === 'question'), 8_000)
    await waitFor(() => step.started() > 0, 8_000)
    const helper = await waitFor(async () => (await db.list('chat_item')).find((row) => row.kind === 'helper'))
    // The main agent is busy (waiting on its question card) when the helper ends.
    await manager.stop(helper.id, 'the person (Stop on its card)')
    await sleep(150)
    expect((await db.list('chat_item')).some((row) => row.kind === 'agent' && row.text === 'Heard the helper stopped.')).toBe(false)
    await runner.answer(question.id, 'Red')
    await waitFor(async () => (await db.list('chat_item')).some((row) => row.kind === 'agent' && row.text === 'Heard the helper stopped.'), 8_000)
    await sleep(200)
    // The notice reached the main agent's model exactly once as the newest message, and woke it for a reply.
    expect(heard).toBe(1)
    expect(DEFAULT_SETTINGS.helperQuietMinutes).toBe(10)
  })
})
