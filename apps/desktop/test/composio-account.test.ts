/** The chosen account reaches Composio Connect wherever its multi-execute schema takes it. */
import { describe, expect, it } from 'vitest'

import { ConnectBackend as ComposioConnect } from '../src/main/apps/composio'

function fakeConnect(schemaProps: Record<string, unknown>, itemProps: Record<string, unknown>) {
  const calls: Array<Record<string, unknown>> = []
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { id?: number; method: string; params?: Record<string, unknown> }
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (body.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {} })
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 })
    if (body.method === 'tools/list') {
      return reply({ tools: [{ name: 'COMPOSIO_MULTI_EXECUTE_TOOL', inputSchema: { type: 'object', properties: { ...schemaProps, tools: { type: 'array', items: { type: 'object', properties: { tool_slug: {}, arguments: {}, ...itemProps } } } } } }] })
    }
    calls.push((body.params?.['arguments'] ?? {}) as Record<string, unknown>)
    return reply({ content: [{ type: 'text', text: '{"successful":true,"data":{}}' }] })
  }) as unknown as typeof fetch
  return { client: new ComposioConnect('ck_test', fetchImpl, 'https://connect.example.test/mcp'), calls }
}

describe('Composio Connect account placement', () => {
  it('puts the account on each tool entry when the schema has it there', async () => {
    const { client, calls } = fakeConnect({}, { account: { type: 'string' } })
    await client.execute('GMAIL_FETCH_EMAILS', { max_results: 5 }, 'ca_work')
    const tools = calls[0]?.['tools'] as Array<Record<string, unknown>>
    expect(tools[0]?.['account']).toBe('ca_work')
    expect(calls[0]?.['account']).toBeUndefined()
  })

  it('puts it on the call when the schema has it there', async () => {
    const { client, calls } = fakeConnect({ account: { type: 'string' } }, {})
    await client.execute('GMAIL_FETCH_EMAILS', {}, 'ca_home')
    expect(calls[0]?.['account']).toBe('ca_home')
  })

  it('sends it in both places when the schema names neither', async () => {
    const { client, calls } = fakeConnect({}, {})
    await client.execute('SLACK_LIST_CHANNELS', {}, 'ca_x')
    const tools = calls[0]?.['tools'] as Array<Record<string, unknown>>
    expect(calls[0]?.['account']).toBe('ca_x')
    expect(tools[0]?.['account']).toBe('ca_x')
  })

  it('sends no account when none was chosen', async () => {
    const { client, calls } = fakeConnect({ account: {} }, { account: {} })
    await client.execute('GOOGLECALENDAR_EVENTS_LIST', {}, null)
    const tools = calls[0]?.['tools'] as Array<Record<string, unknown>>
    expect(calls[0]?.['account']).toBeUndefined()
    expect(tools[0]?.['account']).toBeUndefined()
  })
})
