import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { userMsg, type JsonObject, type Msg } from '../src/model'
import { AnthropicProvider } from '../src/providers/anthropic'
import { providerFor } from '../src/providers/factory'
import { OpenAiCompatProvider } from '../src/providers/openai-compat'
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

describe('AnthropicProvider', () => {
  it('sends the right path, headers and body', async () => {
    const fake = await fakeAi(() => ({ text: 'hi' }))
    const provider = new AnthropicProvider({ apiKey: 'test-key', baseUrl: fake.url })
    await provider.complete('You are a test', [userMsg('hello')], [], 'claude-test', 128)

    expect(fake.requests).toHaveLength(1)
    const req = fake.requests[0]!
    expect(req.path).toBe('/v1/messages')
    expect(req.headers['x-api-key']).toBe('test-key')
    expect(req.headers['anthropic-version']).toBe('2023-06-01')
    expect(req.headers['user-agent']).toBe('agent-desktop/1')
    expect(req.body.model).toBe('claude-test')
    expect(req.body.max_tokens).toBe(128)
    expect(req.body.system).toBe('You are a test')
    expect(req.body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('parses text, stop reason and usage', async () => {
    const fake = await fakeAi(() => ({ text: 'Hello there' }))
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: fake.url })
    const completion = await provider.complete('sys', [userMsg('hi')], [], 'm')

    expect(completion.message.role).toBe('ASSISTANT')
    expect(completion.message.blocks).toEqual([{ t: 'text', text: 'Hello there' }])
    expect(completion.stopReason).toBe('end_turn')
    expect(completion.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
  })

  it('parses tool calls', async () => {
    const fake = await fakeAi(() => ({
      text: 'Checking.',
      toolCalls: [{ name: 'now', input: { zone: 'UTC' } }],
    }))
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: fake.url })
    const completion = await provider.complete('sys', [userMsg('what time')], [], 'm')

    expect(completion.stopReason).toBe('tool_use')
    expect(completion.message.blocks).toEqual([
      { t: 'call', id: 'tool_0_0', name: 'now', input: { zone: 'UTC' } },
      { t: 'text', text: 'Checking.' },
    ])
  })

  it('sends images as base64 read when building the request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-image-'))
    const file = join(dir, 'photo.jpg')
    writeFileSync(file, 'abc')
    try {
      const fake = await fakeAi(() => ({ text: 'nice' }))
      const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: fake.url })
      await provider.complete('sys', [userMsg('look', [file])], [], 'm')

      const messages = fake.requests[0]!.body.messages as JsonObject[]
      expect(messages[0]!.content).toEqual([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJj' },
        },
        { type: 'text', text: 'look' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses plain http to a non-loopback host', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://example.com/v1' })
    await expect(provider.complete('sys', [userMsg('hi')], [], 'm')).rejects.toThrow(
      /Allow unencrypted HTTP/,
    )
  })
})

describe('OpenAiCompatProvider', () => {
  it('sends the right path, auth, system message and tools', async () => {
    const fake = await fakeAi(() => ({ text: 'ok' }))
    const provider = new OpenAiCompatProvider({
      name: 'openai',
      apiKey: 'test-key',
      baseUrl: fake.url,
    })
    await provider.complete(
      'You are a test',
      [userMsg('hello')],
      [{ name: 'now', description: 'Current time', schema: { type: 'object' } }],
      'gpt-test',
      256,
    )

    const req = fake.requests[0]!
    expect(req.path).toBe('/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer test-key')
    expect(req.headers['user-agent']).toBe('agent-desktop/1')
    expect(req.body.model).toBe('gpt-test')
    expect(req.body.max_tokens).toBe(256)
    expect(req.body.messages).toEqual([
      { role: 'system', content: 'You are a test' },
      { role: 'user', content: 'hello' },
    ])
    expect(req.body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'now', description: 'Current time', parameters: { type: 'object' } },
      },
    ])
  })

  it('parses reasoning, text, tool calls and usage', async () => {
    const fake = await fakeAi(() => ({
      reasoning: 'weighing it up',
      text: 'done',
      toolCalls: [{ name: 'now', input: { zone: 'UTC' } }],
    }))
    const provider = new OpenAiCompatProvider({ name: 'openai', apiKey: 'k', baseUrl: fake.url })
    const completion = await provider.complete('sys', [userMsg('hi')], [], 'm')

    expect(completion.message.blocks).toEqual([
      { t: 'reasoning', text: 'weighing it up' },
      { t: 'text', text: 'done' },
      { t: 'call', id: 'call_0_0', name: 'now', input: { zone: 'UTC' } },
    ])
    expect(completion.stopReason).toBe('tool_calls')
    expect(completion.usage).toEqual({ inputTokens: 12, outputTokens: 5 })
  })

  it('echoes Gemini thought signatures, real or placeholder', async () => {
    const fake = await fakeAi(() => ({ text: 'ok' }))
    const history: Msg[] = [
      userMsg('hello'),
      {
        role: 'ASSISTANT',
        blocks: [
          { t: 'call', id: 'c1', name: 'now', input: {} },
          {
            t: 'call',
            id: 'c2',
            name: 'now',
            input: {},
            extra: { google: { thought_signature: 'real-sig' } },
          },
        ],
      },
      {
        role: 'USER',
        blocks: [
          { t: 'result', id: 'c1', content: 'one', err: false },
          { t: 'result', id: 'c2', content: 'two', err: false },
        ],
      },
    ]
    await providerFor({ provider: 'gemini', key: 'k', baseUrl: fake.url }).complete(
      'sys',
      history,
      [],
      'm',
    )

    const messages = fake.requests[0]!.body.messages as JsonObject[]
    const calls = messages[2]!.tool_calls as JsonObject[]
    expect(calls[0]!.extra_content).toEqual({
      google: { thought_signature: 'skip_thought_signature_validator' },
    })
    expect(calls[1]!.extra_content).toEqual({ google: { thought_signature: 'real-sig' } })
  })

  it('does not add a thought signature for other providers', async () => {
    const fake = await fakeAi(() => ({ text: 'ok' }))
    const history: Msg[] = [
      userMsg('hello'),
      { role: 'ASSISTANT', blocks: [{ t: 'call', id: 'c1', name: 'now', input: {} }] },
      { role: 'USER', blocks: [{ t: 'result', id: 'c1', content: 'one', err: false }] },
    ]
    await providerFor({ provider: 'openai', key: 'k', baseUrl: fake.url }).complete(
      'sys',
      history,
      [],
      'm',
    )
    const messages = fake.requests[0]!.body.messages as JsonObject[]
    const calls = messages[2]!.tool_calls as JsonObject[]
    expect(calls[0]!.extra_content).toBeUndefined()
  })

  it('adds DeepSeek extra body fields', async () => {
    const fake = await fakeAi(() => ({ text: 'ok' }))
    await providerFor({ provider: 'deepseek', key: 'k', baseUrl: fake.url }).complete(
      'sys',
      [userMsg('hi')],
      [],
      'm',
    )
    expect(fake.requests[0]!.body.thinking).toEqual({ type: 'disabled' })
  })

  it('adds the OpenCode session header', async () => {
    const fake = await fakeAi(() => ({ text: 'ok' }))
    await providerFor({
      provider: 'opencode_go',
      key: 'k',
      baseUrl: fake.url,
      sessionId: 'session-123',
    }).complete('sys', [userMsg('hi')], [], 'm')
    expect(fake.requests[0]!.headers['x-opencode-session']).toBe('session-123')
  })

  it('retries on 500 and then succeeds', async () => {
    const fake = await fakeAi((_body, index) =>
      index === 0 ? { status: 500, text: 'server broke' } : { text: 'recovered' },
    )
    const completion = await providerFor({
      provider: 'openai',
      key: 'k',
      baseUrl: fake.url,
    }).complete('sys', [userMsg('hi')], [], 'm')
    expect(completion.message.blocks).toEqual([{ t: 'text', text: 'recovered' }])
    expect(fake.requests).toHaveLength(2)
  })

  it('does not retry on 400', async () => {
    const fake = await fakeAi(() => ({ status: 400, text: 'bad request' }))
    await expect(
      providerFor({ provider: 'openai', key: 'k', baseUrl: fake.url }).complete(
        'sys',
        [userMsg('hi')],
        [],
        'm',
      ),
    ).rejects.toThrow('HTTP 400: bad request')
    expect(fake.requests).toHaveLength(1)
  })
})
