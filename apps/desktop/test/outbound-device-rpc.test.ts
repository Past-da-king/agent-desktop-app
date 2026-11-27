/**
 * The double send for real: a server node (DevicesService, kind server) on 127.0.0.1 with its pinned certificate, and
 * two brains that each reach it over their own Uplink (the device link: pinned TLS, their own pass, the real
 * outbound.claim and outbound.report RPC handlers). Both run the same Slack post for the same request at once; Slack
 * (a local fake) must see one post, and the second brain gets the first one's ts back.
 */
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { Tool, ToolContext } from '@agent/core'


import { Store } from '../src/main/db'
import { hashPass, newPass } from '../src/main/devices/passes'
import { HandlerRegistry } from '../src/main/devices/registry'
import { authorityValue, DevicesService } from '../src/main/devices/service'
import { Uplink } from '../src/main/devices/uplink'
import { withOutboundClaims } from '../src/main/runtime/outbound-dispatch'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

async function serverNode(brains: Set<string>): Promise<{ service: DevicesService; dir: string; base: string; fp: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-authority-'))
  const store = new Store(join(dir, 'agent.db'))
  const data = new Map<string, string>()
  const service = new DevicesService({
    userData: dir,
    store,
    secrets: { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) },
    registry: new HandlerRegistry(),
    appVersion: '1.0.0',
    nodeName: () => 'Authority',
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: join(dir, 'none'),
    emitWindow: () => undefined,
    kind: 'server',
    knownPeer: (id) => (brains.has(id) ? ['brain', 'hands'] : id.startsWith('dev_hands') ? ['hands'] : null),
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => service.stop())
  await service.start()
  let status = service.status()
  for (let attempt = 0; attempt < 5 && !status.running; attempt += 1) {
    await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    status = await service.setEnabled(true)
  }
  return { service, dir, base: `https://127.0.0.1:${status.port}`, fp: status.fp }
}

/** A brain's link to the server: its own pass in the server's table, a real Uplink, connected. */
async function link(server: { service: DevicesService; base: string; fp: string }, id: string): Promise<Uplink> {
  const pass = newPass()
  server.service.passTable().set(id, hashPass(pass))
  const serverId = server.service.identity.nodeId
  const uplink = new Uplink({
    target: () => ({ id: serverId, urls: [server.base], fp: server.fp }),
    pass: () => pass,
    facts: () => ({ name: id, kind: 'desktop', platform: 'windows', appVersion: '1.0.0', screen: { width: 0, height: 0 }, canOpenLinks: false, canReceiveFiles: false, fingerprint: '', urls: [] }) as never,
    runTool: async () => ({ ok: false, error: 'none' }) as never,
  })
  uplink.start()
  cleanups.push(() => uplink.stop())
  for (let i = 0; i < 100 && uplink.target === null; i++) await new Promise((resolve) => setTimeout(resolve, 30))
  expect(uplink.target).toBe(serverId)
  return uplink
}

/** What a desktop's DevicesService.outboundCall does: ask the connected brain, accept only the server's own answer. */
const authorityOf = (uplink: Uplink) => ({
  outboundCall: async (method: 'outbound.claim' | 'outbound.report', args: unknown[]) => authorityValue(await uplink.rpcCall(method, args, 5000), uplink.target),
})

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no address')
  return 'http://127.0.0.1:' + address.port
}

describe('outbound claims over the real device link', () => {
  it('two brains running the same send post once, and the second gets the first one\'s ts', async () => {
    const server = await serverNode(new Set(['dev_brain_pc', 'dev_brain_laptop']))
    const pc = await link(server, 'dev_brain_pc')
    const laptop = await link(server, 'dev_brain_laptop')
    let posts = 0
    const slack = createServer((_req, res) => {
      posts++
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, ts: '1764262000.000100' }))
      }, 150)
    })
    const slackUrl = await listen(slack)
    cleanups.push(() => new Promise<void>((resolve) => slack.close(() => resolve())))
    const fetchTool: Tool = {
      spec: { name: 'browser_fetch', description: '', schema: { type: 'object', properties: {} } },
      run: async () => 'POST https://slack.com/api/chat.postMessage\n200 OK\n\nBody (application/json):\n' + await (await fetch(slackUrl, { method: 'POST' })).text(),
    }
    const token = ['fixture', 'secret', 'value', '123'].join('-')
    const input = { url: 'https://slack.com/api/chat.postMessage', method: 'POST', body: JSON.stringify({ token, channel: 'C1', text: 'hello' }) }
    const ctx = { requestId: 'chat-item-1', agentLabel: 'main' } as ToolContext
    const [onPc] = withOutboundClaims([fetchTool], () => authorityOf(pc))
    const [onLaptop] = withOutboundClaims([fetchTool], () => authorityOf(laptop))

    const results = await Promise.all([onPc!.run(input, ctx), onLaptop!.run(input, ctx)])
    expect(posts).toBe(1)
    expect(results.filter((r) => r === 'already_sent: 1764262000.000100')).toHaveLength(1)
    // A retry later, from either brain, gets the receipt and posts nothing.
    expect(await onLaptop!.run(input, ctx)).toBe('already_sent: 1764262000.000100')
    expect(await onPc!.run(input, ctx)).toBe('already_sent: 1764262000.000100')
    expect(posts).toBe(1)
    // A different message in the same request is its own send.
    await onPc!.run({ ...input, body: JSON.stringify({ token, channel: 'C1', text: 'second' }) }, ctx)
    expect(posts).toBe(2)
    // No token in anything the authority keeps.
    const kept = join(server.dir, 'devices')
    const files = readdirSync(kept).filter((name) => name.startsWith('outbound-claims'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) expect(readFileSync(join(kept, file)).includes(token), file).toBe(false)
  })

  it('a hands-only device cannot claim, and an answer that is not the server\'s holds the send', async () => {
    const server = await serverNode(new Set())
    const hands = await link(server, 'dev_hands_only')
    await expect(hands.rpcCall('outbound.claim', ['a'.repeat(64)], 3000)).rejects.toThrow()
    expect(() => authorityValue({ role: 'desktop', nodeId: 'x', value: { state: 'granted' } }, 'x')).toThrow(/held/)
    expect(() => authorityValue({ role: 'headless', nodeId: 'someone-else', value: { state: 'granted' } }, 'x')).toThrow(/held/)
    let sends = 0
    const tool: Tool = { spec: { name: 'apps_run', description: '', schema: { type: 'object', properties: {} } }, run: async () => { sends++; return '{}' } }
    const [guarded] = withOutboundClaims([tool], () => authorityOf(hands))
    expect(await guarded!.run({ slug: 'GMAIL_SEND_EMAIL', arguments: { to: 'a' } }, { requestId: 'r', agentLabel: 'main' } as ToolContext)).toMatch(/^Send held/)
    expect(sends).toBe(0)
  })
})
