/**
 * His messages are never queued behind a running step (Ayanda, 26 Oct 2026: "my messages should never be queued ever
 * in life"). A message about the same task reaches the running agent at once: a step that only reads (a tool, the
 * model's own answer) is cut off for it, a step that changes something finishes first and the message rides with its
 * result. Different work runs alongside and merges back. Nothing is lost or given twice, across a restart too.
 *
 * Real Runner, real HelperManager, real Store; a scripted in-process model that records every request with its time
 * and whether it was cut off, and slow fake tools that record whether they were aborted.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  CUT_SHORT_RESULT,
  DEFAULT_SETTINGS,
  MAIN_CHAT,
  NOT_RUN_RESULT,
  type ChatItem,
  type Completion,
  type JsonObject,
  type LlmProvider,
  type Msg,
  type Settings,
  type Tool,
} from '@agent/core'

import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner, type RunnerDeps } from '../src/main/runtime/runner'
import { isInterruptible, readOnlyCommand } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

interface Call {
  at: number
  text: string
  aborted: boolean
  done: boolean
}

/** A scripted model: `reply` sees everything the request carried, as text, and may take its time (cut off by the signal). */
function scripted(reply: (text: string, index: number) => { text?: string; calls?: Array<{ name: string; input: JsonObject }>; delayMs?: number }): { provider: LlmProvider; calls: Call[] } {
  const calls: Call[] = []
  let seq = 0
  const provider: LlmProvider = {
    name: 'scripted',
    complete: async (_system: string, messages: Msg[], _tools, _model, _max, signal?: AbortSignal): Promise<Completion> => {
      const text = JSON.stringify(messages)
      const call: Call = { at: Date.now(), text, aborted: false, done: false }
      calls.push(call)
      const out = reply(text, calls.length - 1)
      if ((out.delayMs ?? 0) > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, out.delayMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            call.aborted = true
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          }, { once: true })
        })
      }
      call.done = true
      const blocks = (out.calls ?? []).map((each) => ({ t: 'call' as const, id: `c${++seq}`, name: each.name, input: each.input }))
      return {
        message: { role: 'ASSISTANT', blocks: [...(out.text === undefined ? [] : [{ t: 'text' as const, text: out.text }]), ...blocks] },
        stopReason: blocks.length > 0 ? 'tool_calls' : 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      }
    },
  }
  return { provider, calls }
}

interface Probe {
  started: number
  ended: number
  aborted: boolean
  runs: number
}

/** A slow tool under a given name: waits `ms` (or until its signal aborts), and says what happened to it. */
function slowTool(name: string, ms: number, result: string): { tool: Tool; probe: Probe } {
  const probe: Probe = { started: 0, ended: 0, aborted: false, runs: 0 }
  const tool: Tool = {
    spec: { name, description: `Slow ${name}.`, schema: { type: 'object', properties: {} } },
    run: (_input, ctx) =>
      new Promise<string>((resolve) => {
        probe.runs += 1
        probe.started = Date.now()
        const timer = setTimeout(() => {
          probe.ended = Date.now()
          resolve(result)
        }, ms)
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          probe.aborted = true
          probe.ended = Date.now()
          resolve('aborted')
        }, { once: true })
      }),
  }
  return { tool, probe }
}

const stores: Store[] = []
const runners: Runner[] = []
const managers: HelperManager[] = []
const temps: string[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  for (const manager of managers.splice(0)) await manager.stopAll()
  await sleep(30)
  for (const store of stores.splice(0)) store.close()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeRunner(options: {
  provider: LlmProvider
  tools: Tool[]
  store?: Store
  helpers?: boolean
  now?: () => number
  settings?: Partial<Settings>
  cli?: CliHost
}): { runner: Runner; store: Store; manager: HelperManager | null } {
  const store = options.store ?? new Store(':memory:')
  if (options.store === undefined) stores.push(store)
  const settings = settingsView({ ...DEFAULT_SETTINGS, ...READY, ...options.settings })
  let runner: Runner | null = null
  const manager = options.helpers === true
    ? new HelperManager({
        store,
        settings,
        secrets: secretsView('test-key'),
        providerFactory: () => options.provider,
        workerTools: options.tools,
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
    store,
    settings,
    secrets: secretsView('test-key'),
    tools: options.tools,
    providerFactory: () => options.provider,
    timeZone: 'UTC',
    classifier: null,
    ...(manager === null ? {} : { helpers: manager }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cli === undefined ? {} : { cli: options.cli }),
  }
  runner = new Runner(deps)
  runners.push(runner)
  return { runner, store, manager }
}

function meta(row: ChatItem | undefined): Record<string, unknown> {
  return row === undefined ? {} : (JSON.parse(row.meta) as Record<string, unknown>)
}

async function userRow(store: Store, text: string): Promise<ChatItem | undefined> {
  return (await store.list('chat_item')).find((row) => row.kind === 'user' && row.text === text)
}

describe('a message about the running task is read at once', () => {
  it('cuts off a slow read-only tool and the model reads the message within seconds', async () => {
    const read = slowTool('web_fetch', 30_000, 'the page')
    const { provider, calls } = scripted((text) => {
      if (text.includes('STOP-NOW')) return { text: 'Stopped, as you asked.' }
      if (text.includes('"t":"result"')) return { text: 'Read the page.' }
      return { calls: [{ name: 'web_fetch', input: { url: 'https://example.com' } }] }
    })
    const { runner, store } = makeRunner({ provider, tools: [read.tool] })

    const running = runner.send('Read the long report page')
    await waitFor(() => read.probe.started > 0, 3000)
    const sentAt = Date.now()
    await runner.send("whoa, STOP-NOW, that wasn't clear")
    await running

    const reached = calls.find((call) => call.text.includes('STOP-NOW'))
    expect(reached).toBeDefined()
    expect((reached?.at ?? Infinity) - sentAt).toBeLessThan(2000)
    // The read was aborted, not waited out, and the model was told why.
    expect(read.probe.aborted).toBe(true)
    expect(read.probe.ended - sentAt).toBeLessThan(1000)
    expect(reached?.text).toContain(CUT_SHORT_RESULT.slice(0, 40))
    const row = await userRow(store, "whoa, STOP-NOW, that wasn't clear")
    expect(meta(row)['route']).toBe('join')
    expect(meta(row)['delivered']).toBe(true)
    // Read once: exactly one request carried it as new, and the answer to it is in the chat.
    expect((await store.list('chat_item')).some((item) => item.kind === 'agent' && item.text === 'Stopped, as you asked.')).toBe(true)
    // The note is in the stored transcript with the tool's result (so a resumed run still has it).
    expect((await store.list('turn')).some((turn) => turn.json.includes('STOP-NOW'))).toBe(true)
  })

  it('cuts off a slow model step (its request aborted) and asks again with the message', async () => {
    const { provider, calls } = scripted((text, index) => {
      if (text.includes('STOP-MODEL')) return { text: 'Changed course.' }
      return index === 0 ? { text: 'A long answer', delayMs: 30_000 } : { text: 'Done.' }
    })
    const { runner, store } = makeRunner({ provider, tools: [] })

    const running = runner.send('Plan the whole quarter')
    await waitFor(() => calls.length === 1, 3000)
    await sleep(100)
    const sentAt = Date.now()
    await runner.send('wait, STOP-MODEL, only plan November')
    await running

    expect(calls[0]?.aborted).toBe(true)
    const reached = calls.find((call) => call.text.includes('STOP-MODEL'))
    expect((reached?.at ?? Infinity) - sentAt).toBeLessThan(2000)
    const agent = (await store.list('chat_item')).filter((item) => item.kind === 'agent').map((item) => item.text)
    expect(agent).toEqual(['Changed course.'])
    expect((await store.list('chat_item')).some((item) => item.kind === 'activity' && item.text.includes('read your new message'))).toBe(true)
  })

  it('lets a step that changes something finish, then the message rides with its result; later calls are not run', async () => {
    const write = slowTool('files_write', 1500, 'wrote report.txt')
    const search = slowTool('memory_search', 10, 'nothing')
    const { provider, calls } = scripted((text) => {
      if (text.includes('WRITE-NOTE')) return { text: 'Noted, using the other folder.' }
      return { calls: [{ name: 'files_write', input: { path: 'report.txt' } }, { name: 'memory_search', input: { query: 'x' } }] }
    })
    const { runner } = makeRunner({ provider, tools: [write.tool, search.tool] })

    const running = runner.send('Write the report file')
    await waitFor(() => write.probe.started > 0, 3000)
    await sleep(200)
    await runner.send('Actually WRITE-NOTE use the other folder')
    await running

    // Never cut halfway.
    expect(write.probe.aborted).toBe(false)
    expect(write.probe.ended - write.probe.started).toBeGreaterThanOrEqual(1400)
    const reached = calls.find((call) => call.text.includes('WRITE-NOTE'))
    expect(reached).toBeDefined()
    // It merged right after the write, in the same request as the write's real result.
    expect((reached?.at ?? 0) >= write.probe.ended).toBe(true)
    expect((reached?.at ?? Infinity) - write.probe.ended).toBeLessThan(1000)
    expect(reached?.text).toContain('wrote report.txt')
    // The call the model planned before it read the message was not run.
    expect(search.probe.runs).toBe(0)
    expect(reached?.text).toContain(NOT_RUN_RESULT.slice(0, 30))
  })
})

describe('different work branches and merges back', () => {
  it('runs an unrelated message alongside at once, in parallel, and merges its result into the running conversation', async () => {
    let clock = Date.now()
    let release: () => void = () => undefined
    const gate: Tool = {
      spec: { name: 'files_write', description: 'Slow write.', schema: { type: 'object', properties: {} } },
      run: (_input, ctx) => new Promise<string>((resolve) => {
        release = () => resolve('reconciled')
        ctx.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      }),
    }
    const { provider, calls } = scripted((text) => {
      if (text.includes('were already busy')) return { text: 'Side done: table booked for 19:00.' }
      if (text.includes('"t":"result"')) return { text: 'Statements reconciled.' }
      return { calls: [{ name: 'files_write', input: {} }] }
    })
    const { runner, store } = makeRunner({ provider, tools: [gate], helpers: true, now: () => clock })

    const running = runner.send('Reconcile the bank statements')
    await waitFor(() => calls.length === 1, 3000)
    await sleep(50)
    clock += 5 * 60_000
    const sentAt = Date.now()
    await runner.send('Book a table for two at Ocean Basket tonight')

    const asked = await userRow(store, 'Book a table for two at Ocean Basket tonight')
    expect(meta(asked)['route']).toBe('alongside')
    const side = await waitFor(async () => {
      const helper = (await store.list('chat_item')).find((row) => row.kind === 'helper')
      return helper !== undefined && meta(helper)['state'] === 'done' ? helper : null
    }, 5000)
    // It ran while the first job was still going: nothing waited for something unrelated.
    expect(runner.state(MAIN_CHAT).running).toBe(true)
    expect(Date.now() - sentAt).toBeLessThan(5000)
    expect(String(meta(side)['result'])).toContain('table booked')

    release()
    await running
    // Merged back: the running conversation read the side result once.
    const merged = calls.filter((call) => call.text.includes('Done alongside while you were busy'))
    expect(merged.length).toBeGreaterThan(0)
    expect(merged[0]?.text).toContain('table booked')
    expect(meta((await store.list('chat_item')).find((row) => row.id === side.id))['told']).toBe(true)
  })
})

describe('nothing lost, nothing twice, across a restart', () => {
  it('a joined message the run never read is delivered once after a restart, and never again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'never-queued-'))
    temps.push(dir)
    const file = join(dir, 'agent.db')
    const gate: Tool = {
      spec: { name: 'files_write', description: 'Slow write.', schema: { type: 'object', properties: {} } },
      run: (_input, ctx) => new Promise<string>((resolve) => ctx.signal.addEventListener('abort', () => resolve('aborted'), { once: true })),
    }
    const first = scripted((text) => (text.includes('"t":"result"') ? { text: 'ok' } : { calls: [{ name: 'files_write', input: {} }] }))
    const storeA = new Store(file)
    const a = makeRunner({ provider: first.provider, tools: [gate], store: storeA })
    const running = a.runner.send('Deploy the docs site')
    await waitFor(() => first.calls.length === 1, 3000)
    await sleep(50)
    await a.runner.send('also RESTART-NOTE add the changelog page')
    expect(meta(await userRow(storeA, 'also RESTART-NOTE add the changelog page'))['delivered']).toBe(false)
    // The app quits mid-turn (an install, a crash): the message was never read.
    a.runner.dispose()
    runners.splice(runners.indexOf(a.runner), 1)
    await running
    await sleep(50)
    expect(first.calls.some((call) => call.text.includes('RESTART-NOTE'))).toBe(false)
    expect(meta(await userRow(storeA, 'also RESTART-NOTE add the changelog page'))['delivered']).toBe(false)
    storeA.close()

    // Next start: delivered once.
    const second = scripted(() => ({ text: 'Added the changelog page too.' }))
    const storeB = new Store(file)
    const b = makeRunner({ provider: second.provider, tools: [gate], store: storeB })
    await b.runner.restore()
    await waitFor(async () => (await storeB.list('chat_item')).some((row) => row.kind === 'agent' && row.text === 'Added the changelog page too.'), 5000)
    await waitFor(async () => meta(await userRow(storeB, 'also RESTART-NOTE add the changelog page'))['delivered'] === true, 3000)
    expect(second.calls.filter((call) => call.text.includes('RESTART-NOTE'))).toHaveLength(1)
    b.runner.dispose()
    runners.splice(runners.indexOf(b.runner), 1)
    await sleep(50)
    storeB.close()

    // And the start after that: nothing again.
    const third = scripted(() => ({ text: 'should not run' }))
    const storeC = new Store(file)
    stores.push(storeC)
    const c = makeRunner({ provider: third.provider, tools: [gate], store: storeC })
    await c.runner.restore()
    await sleep(300)
    expect(third.calls).toHaveLength(0)
  })

  it('a message already in the transcript (handed over just before the restart) is only marked, never sent again', async () => {
    const { provider, calls } = scripted(() => ({ text: 'should not run' }))
    const { runner, store } = makeRunner({ provider, tools: [] })
    const row = await store.upsert('chat_item', { kind: 'user', text: 'DEDUPE-NOTE use blue', meta: JSON.stringify({ route: 'join', delivered: false }) })
    await sleep(5)
    await store.upsert('turn', { thread: 'main', json: JSON.stringify({ role: 'USER', blocks: [{ t: 'text', text: '[The user sent this...]\nDEDUPE-NOTE use blue' }] }) })
    await runner.restore()
    await sleep(300)
    expect(calls).toHaveLength(0)
    expect(meta((await store.list('chat_item')).find((item) => item.id === row.id))['delivered']).toBe(true)
  })
})

describe('helpers: a steer cuts off a slow read the same way', () => {
  it('helper_steer during a slow read-only tool reaches the helper within seconds and aborts the read', async () => {
    const read = slowTool('browser_wait_for', 30_000, 'never came')
    const { provider, calls } = scripted((text) => {
      if (text.includes('STEER-NOW')) return { text: 'Switched to the PDF.' }
      if (text.includes('HELPER-BRIEF')) return text.includes('"t":"result"') ? { text: 'done' } : { calls: [{ name: 'browser_wait_for', input: { text: 'Loaded' } }] }
      return { text: 'main' }
    })
    const store = new Store(':memory:')
    stores.push(store)
    const manager = new HelperManager({
      store,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
      secrets: secretsView('test-key'),
      providerFactory: () => provider,
      workerTools: [read.tool],
      deliver: async () => undefined,
    })
    managers.push(manager)
    await manager.delegate([{ label: 'Reader', brief: 'HELPER-BRIEF wait for the page' }])
    await waitFor(() => read.probe.started > 0, 3000)
    const helper = (await store.list('chat_item')).find((row) => row.kind === 'helper')
    const sentAt = Date.now()
    await manager.steer(helper?.id ?? '', 'STEER-NOW read the PDF instead')
    const reached = await waitFor(() => calls.find((call) => call.text.includes('STEER-NOW')) ?? null, 3000)
    expect(reached.at - sentAt).toBeLessThan(2000)
    expect(read.probe.aborted).toBe(true)
    expect(reached.text).toContain(CUT_SHORT_RESULT.slice(0, 40))
  })
})

describe('plan engines (Claude / Codex on his plan)', () => {
  it('an app tool that only reads is cut off and his message rides with its result, with no pause', async () => {
    const read = slowTool('web_fetch', 30_000, 'the page')
    const results: string[] = []
    const prompts: string[] = []
    let aborted = false
    const cli = {
      turn: async (request: CliTurnRequest) => {
        prompts.push(request.prompt)
        request.signal.addEventListener('abort', () => (aborted = true), { once: true })
        const tool = request.tools.find((each) => each.spec.name === 'web_fetch')
        const call = { id: 'mcp-1', name: 'web_fetch', input: { url: 'https://example.com' } }
        await request.onCall(call)
        const out = await (tool as Tool).run(call.input, request.context)
        await request.onResult(call, out, false)
        results.push(out)
        await request.onEvent({ type: 'said', text: 'Read your note with the result.' })
        return { text: 'Read your note with the result.' }
      },
    } as unknown as CliHost
    const { provider } = scripted(() => ({ text: 'x' }))
    const { runner } = makeRunner({ provider, tools: [read.tool], cli, settings: { mode: 'subscription', cli: 'claude' } })

    const running = runner.send('Read the long page')
    await waitFor(() => read.probe.started > 0, 3000)
    const sentAt = Date.now()
    await runner.send('hold on, PLAN-NOTE only the summary')
    await running

    expect(read.probe.aborted).toBe(true)
    expect(read.probe.ended - sentAt).toBeLessThan(1000)
    expect(results[0]).toContain(CUT_SHORT_RESULT.slice(0, 40))
    expect(results[0]).toContain('PLAN-NOTE only the summary')
    expect(aborted).toBe(false)
    expect(prompts).toHaveLength(1)
  })

  it("the engine's own changing step (a git push) finishes, then the turn pauses and resumes with the message", async () => {
    const prompts: string[] = []
    let finishPush: () => void = () => undefined
    let pausedAt = 0
    let pushEndedAt = 0
    let abortedMidPush = true
    const cli = {
      turn: async (request: CliTurnRequest) => {
        prompts.push(request.prompt)
        if (prompts.length > 1) {
          await request.onEvent({ type: 'said', text: 'Pushed, then read your note.' })
          return { text: 'Pushed, then read your note.' }
        }
        const call = { t: 'call' as const, id: 'b1', name: 'Bash', input: { command: 'git push origin main' } }
        await request.onEvent({ type: 'tool_started', call })
        await new Promise<void>((resolve) => {
          finishPush = resolve
        })
        pushEndedAt = Date.now()
        // Was the engine stopped while its push was still running? It must not be.
        abortedMidPush = request.signal.aborted
        await request.onEvent({ type: 'tool_finished', call, result: 'pushed', isError: false })
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) resolve()
          request.signal.addEventListener('abort', () => resolve(), { once: true })
        })
        pausedAt = Date.now()
        return { text: '' }
      },
    } as unknown as CliHost
    const { provider } = scripted(() => ({ text: 'x' }))
    const { runner } = makeRunner({ provider, tools: [], cli, settings: { mode: 'subscription', cli: 'claude' } })

    const running = runner.send('Push the release')
    await waitFor(() => prompts.length === 1, 3000)
    await sleep(50)
    await runner.send('wait, PUSH-NOTE tag it first next time')
    await sleep(400)
    // Not cut halfway: the push is still running and the turn still going.
    expect(pausedAt).toBe(0)
    finishPush()
    await running
    expect(abortedMidPush).toBe(false)
    expect(pausedAt).toBeGreaterThan(0)
    expect(pausedAt - pushEndedAt).toBeLessThan(500)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('You were paused mid-step')
    expect(prompts[1]).toContain('PUSH-NOTE')
  })

  it('a model step on a plan is paused at once for his message', async () => {
    const prompts: string[] = []
    let pausedAt = 0
    const cli = {
      turn: async (request: CliTurnRequest) => {
        prompts.push(request.prompt)
        if (prompts.length > 1) return { text: 'ok' }
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
        pausedAt = Date.now()
        return { text: '' }
      },
    } as unknown as CliHost
    const { provider } = scripted(() => ({ text: 'x' }))
    const { runner } = makeRunner({ provider, tools: [], cli, settings: { mode: 'subscription', cli: 'claude' } })
    const running = runner.send('Draft the board letter')
    await waitFor(() => prompts.length === 1, 3000)
    const sentAt = Date.now()
    await runner.send('stop, MODEL-PLAN-NOTE make it shorter')
    await running
    expect(pausedAt - sentAt).toBeLessThan(500)
    expect(prompts[1]).toContain('MODEL-PLAN-NOTE')
  })
})

describe('which calls may be cut off', () => {
  it('reads and waits yes; writes, sends, deploys and unknown tools no', () => {
    for (const name of ['memory_search', 'web_fetch', 'browser_wait_for', 'browser_read', 'files_read', 'mcp__agent__memory_get', 'Read', 'Grep']) expect(isInterruptible(name)).toBe(true)
    for (const name of ['files_write', 'memory_save', 'apps_run', 'webapp_run', 'browser_click', 'request_approval', 'notify_user', 'Edit', 'Write', 'some_new_tool']) expect(isInterruptible(name)).toBe(false)
    expect(isInterruptible('shell_run', { command: 'sleep 30' })).toBe(true)
    expect(isInterruptible('Bash', { command: 'git status && git log --oneline -5 | head' })).toBe(true)
    expect(isInterruptible('shell_run', { command: 'git push origin devices' })).toBe(false)
    expect(isInterruptible('shell_run', { command: 'echo hi > out.txt' })).toBe(false)
    expect(isInterruptible('shell_run', { command: 'ls $(rm -rf x)' })).toBe(false)
    expect(isInterruptible('shell_run', { command: 'curl -X POST https://x' })).toBe(false)
    expect(isInterruptible('browser_fetch', { url: '/api' })).toBe(true)
    expect(isInterruptible('browser_fetch', { url: '/api', method: 'POST', body: '{}' })).toBe(false)
    expect(isInterruptible('device_tool', { tool: 'browser_read', args: {} })).toBe(true)
    expect(isInterruptible('device_tool', { tool: 'shell_run', args: { command: 'npm publish' } })).toBe(false)
    expect(readOnlyCommand('find . -name x -delete')).toBe(false)
    expect(readOnlyCommand("sed -i 's/a/b/' f")).toBe(false)
    expect(readOnlyCommand('Start-Sleep -Seconds 20')).toBe(true)
  })
})
