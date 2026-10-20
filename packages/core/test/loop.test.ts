import { afterEach, describe, expect, it } from 'vitest'

import { AgentLoop } from '../src/loop'
import {
  msgText,
  msgToolCalls,
  schema,
  userMsg,
  type Msg,
  type Tool,
  type ToolContext,
  type ToolResultBlock,
} from '../src/model'
import { providerFor } from '../src/providers/factory'
import { startFakeAi, type FakeAi } from './fake-ai'

const servers: FakeAi[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function fakeAi(script: Parameters<typeof startFakeAi>[0]): Promise<FakeAi> {
  const server = await startFakeAi(script)
  servers.push(server)
  return server
}

function makeCtx(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    agentLabel: 'main',
    activity: async () => 1,
    updateActivity: async () => {},
    ask: async () => null,
    approve: async () => true,
    notify: async () => {},
    signal,
  }
}

function tool(name: string, run: Tool['run']): Tool {
  return { spec: { name, description: name, schema: schema([], {}) }, run }
}

function loopFor(fake: FakeAi, tools: Tool[] = [], maxSteps?: number): AgentLoop {
  return new AgentLoop({
    provider: providerFor({ provider: 'openai', key: 'k', baseUrl: fake.url }),
    model: 'test-model',
    tools,
    maxSteps,
  })
}

function results(history: Msg[]): ToolResultBlock[] {
  return history.flatMap((m) => m.blocks.filter((b): b is ToolResultBlock => b.t === 'result'))
}

describe('AgentLoop', () => {
  it('ends on a text-only answer', async () => {
    const fake = await fakeAi(() => ({ text: 'All done' }))
    const history: Msg[] = [userMsg('hi')]

    const out = await loopFor(fake).run('sys', history, makeCtx())

    expect(out).toBe('All done')
    expect(fake.requests).toHaveLength(1)
    expect(history).toEqual([
      userMsg('hi'),
      { role: 'ASSISTANT', blocks: [{ t: 'text', text: 'All done' }] },
    ])
  })

  it('runs a tool and feeds the result back', async () => {
    const fake = await fakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'now', input: { zone: 'UTC' } }] } : { text: 'It is noon' },
    )
    const seen: unknown[] = []
    const now = tool('now', async (input) => {
      seen.push(input)
      return 'noon'
    })
    const history: Msg[] = [userMsg('what time is it')]
    const appended: Msg[] = []

    const out = await loopFor(fake, [now]).run('sys', history, makeCtx(), {
      onAppend: (m) => {
        appended.push(m)
      },
    })

    expect(out).toBe('It is noon')
    expect(fake.requests).toHaveLength(2)
    expect(seen).toEqual([{ zone: 'UTC' }])
    expect(history).toHaveLength(4)
    expect(msgToolCalls(history[1]!)[0]!.name).toBe('now')
    expect(results(history)).toEqual([
      { t: 'result', id: 'call_0_0', content: 'noon', err: false },
    ])
    expect(msgText(history[3]!)).toBe('It is noon')
    expect(appended).toHaveLength(3)
  })

  it('turns an unknown tool into an error result', async () => {
    const fake = await fakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'nope', input: {} }] } : { text: 'carrying on' },
    )
    const history: Msg[] = [userMsg('try it')]

    await loopFor(fake).run('sys', history, makeCtx())

    expect(results(history)).toEqual([
      { t: 'result', id: 'call_0_0', content: 'Unknown tool nope', err: true },
    ])
  })

  it('turns a thrown tool error into an error result', async () => {
    const fake = await fakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'now', input: {} }] } : { text: 'sorry' },
    )
    const now = tool('now', async () => {
      throw new Error('boom')
    })
    const history: Msg[] = [userMsg('go')]

    await loopFor(fake, [now]).run('sys', history, makeCtx())

    expect(results(history)[0]).toEqual({
      t: 'result',
      id: 'call_0_0',
      content: 'Error: boom',
      err: true,
    })
  })

  it('flattens and retries once on a 400 mentioning tool', async () => {
    const fake = await fakeAi((_body, index) =>
      index === 0
        ? { status: 400, text: "Messages with role 'tool' must be a response to a preceding message" }
        : { text: 'fixed' },
    )
    const history: Msg[] = [
      userMsg('first'),
      { role: 'ASSISTANT', blocks: [{ t: 'call', id: 'c1', name: 'now', input: {} }] },
      { role: 'USER', blocks: [{ t: 'result', id: 'c1', content: 'noon', err: false }] },
      { role: 'ASSISTANT', blocks: [{ t: 'text', text: 'first answer' }] },
      userMsg('second'),
    ]

    const out = await loopFor(fake).run('sys', history, makeCtx())

    expect(out).toBe('fixed')
    expect(fake.requests).toHaveLength(2)
    const second = JSON.stringify(fake.requests[1]!.body.messages)
    expect(second).not.toContain('tool_calls')
    expect(second).not.toContain('"role":"tool"')
    expect(second).toContain('first answer')
    expect(second).toContain('second')
  })

  it('adds steering notes to the next request', async () => {
    const fake = await fakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'now', input: {} }] } : { text: 'done' },
    )
    const now = tool('now', async () => 'noon')
    const history: Msg[] = [userMsg('go')]
    let reads = 0

    const out = await loopFor(fake, [now]).run('sys', history, makeCtx(), {
      incoming: () => (reads++ === 0 ? ['focus on the budget'] : []),
    })

    expect(out).toBe('done')
    expect(fake.requests).toHaveLength(2)
    expect(JSON.stringify(fake.requests[1]!.body.messages)).toContain(
      '[The main agent, while you work] focus on the budget',
    )
  })

  it('stops before the next step when aborted', async () => {
    const fake = await fakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'abort', input: {} }] } : { text: 'should not happen' },
    )
    const controller = new AbortController()
    const abortTool = tool('abort', async () => {
      controller.abort()
      return 'stopping'
    })
    const history: Msg[] = [userMsg('go')]

    const out = await loopFor(fake, [abortTool]).run('sys', history, makeCtx(controller.signal), {
      signal: controller.signal,
    })

    expect(out).toBe('')
    expect(fake.requests).toHaveLength(1)
  })

  it('clips a tool result over 24000 chars', async () => {
    const big = 'y'.repeat(30_000)
    const fake = await fakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'big', input: {} }] } : { text: 'ok' },
    )
    const bigTool = tool('big', async () => big)
    const history: Msg[] = [userMsg('go')]

    await loopFor(fake, [bigTool]).run('sys', history, makeCtx())

    const result = results(history)[0]!
    expect(result.content.startsWith('y'.repeat(100))).toBe(true)
    expect(result.content).toContain('(cut, 30000 chars total)')
    expect(result.content.length).toBeGreaterThan(24_000)
    expect(result.content.length).toBeLessThan(24_100)
  })
})
