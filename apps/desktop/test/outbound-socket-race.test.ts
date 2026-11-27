import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Tool, ToolContext } from '@agent/core'
import { OutboundClaims } from '../src/main/runtime/outbound-claims'

const mocks = vi.hoisted(() => ({ current: () => null as unknown }))
vi.mock('../src/main/devices/service', () => ({ getDevicesService: () => mocks.current() }))
import { withOutboundClaims } from '../src/main/runtime/outbound-dispatch'

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return 'http://127.0.0.1:' + address.port
}

describe('outbound socket race', () => {
  it('posts once across two clients, returns the receipt and permits different content', async () => {
    const claims = new OutboundClaims(':memory:')
    const owners = new AsyncLocalStorage<string>()
    let posts = 0
    const slack = createServer((_req, res) => {
      posts++
      res.writeHead(200, { 'content-type': 'application/json' })
      setTimeout(() => res.end(JSON.stringify({ ok: true, ts: '123.456' })), 80)
    })
    const authority = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const input = JSON.parse(Buffer.concat(chunks).toString()) as { method: string; args: [string, { state: 'sent'; result: string }]; owner: string }
      const answer = input.method === 'outbound.claim' ? claims.claim(input.args[0], input.owner) : claims.finish(input.args[0], input.owner, input.args[1])
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(answer))
    })
    const slackUrl = await listen(slack), authorityUrl = await listen(authority)
    mocks.current = () => ({
      outboundCall: async (method: string, args: unknown[]) => {
        const response = await fetch(authorityUrl, { method: 'POST', body: JSON.stringify({ method, args, owner: owners.getStore() }) })
        return response.json()
      },
    })
    const tool = withOutboundClaims([{
      spec: { name: 'browser_fetch', description: '', schema: { type: 'object', properties: {} } },
      run: async () => {
        const response = await fetch(slackUrl, { method: 'POST' })
        return 'POST https://slack.com/api/chat.postMessage\n200 OK\n\nBody (application/json):\n' + await response.text()
      },
    } as Tool])[0]!
    const ctx = { requestId: 'same-request' } as ToolContext
    const input = { url: 'https://slack.com/api/chat.postMessage', method: 'POST', body: '{\"text\":\"hello\"}' }
    const send = (owner: string, body = input.body) => owners.run(owner, () => tool.run({ ...input, body }, ctx))
    try {
      const results = await Promise.all([send('node-a'), send('node-b')])
      expect(posts).toBe(1)
      expect(results.some(value => value.includes('already_sent: 123.456'))).toBe(true)
      expect(await send('node-b')).toBe('already_sent: 123.456')
      await send('node-b', '{\"text\":\"different\"}')
      expect(posts).toBe(2)
    } finally {
      claims.close()
      await Promise.all([new Promise<void>(r => slack.close(() => r())), new Promise<void>(r => authority.close(() => r()))])
    }
  })
})
