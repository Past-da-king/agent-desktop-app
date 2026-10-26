/**
 * The phone / another computer path: a message sent over the devices link (/v1/rpc chat.send) to a node whose chat
 * is busy in a slow read-only command reaches the running agent at once, the same as one typed on that computer.
 * A real headless node (the server runtime), a real paired client over HTTPS, a fake AI over HTTP, a real shell.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CUT_SHORT_RESULT, providerFor } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { FileKeyCipher } from '../src/headless/file-cipher'
import { loadIdentity } from '../src/main/devices/identity'
import { headlessFacts, startHeadlessDevices } from '../src/headless/devices'
import { readConfig } from '../src/headless/node-config'
import { pair, parsePairLink, PASS_SECRET } from '../src/headless/pair'
import { startHeadlessRuntime } from '../src/headless/runtime'
import { connectRpc } from './devices-client'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 })

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const temps: string[] = []
const closers: Array<() => Promise<void> | void> = []
let fake: FakeAi | null = null

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await fake?.close()
  fake = null
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'never-queued-remote-'))
  temps.push(dir)
  return dir
}

async function until<T>(check: () => Promise<T | null | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const got = await check()
    if (got !== null && got !== undefined && got !== false) return got
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out')
}

describe.skipIf(process.platform === 'win32')('a message over the devices link is never queued', () => {
  it('cuts off a slow read-only command on the node and the model reads the message within seconds', async () => {
    const seen: Array<{ at: number; body: string }> = []
    fake = await startFakeAi((body) => {
      const text = JSON.stringify(body)
      seen.push({ at: Date.now(), body: text })
      if (text.includes('STOP-RPC')) return { text: 'Stopped over the wire.' }
      if (text.includes('"role":"tool"')) return { text: 'Slept.' }
      return { toolCalls: [{ name: 'shell_run', input: { command: 'sleep 30' } }] }
    })
    const dataDir = temp()
    const settings = new SettingsStore(join(dataDir, 'settings.json'))
    settings.save({ hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false, shell: 'always' })
    new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key'))).set('apiKey', 'test-key')
    const server = await startHeadlessRuntime({
      dataDir,
      appDir: root,
      version: '9.9.9',
      quiet: true,
      chromium: null,
      providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
    })
    closers.push(() => server.stop(0))
    const node = await startHeadlessDevices(server, { name: 'server-one', version: '9.9.9', listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    closers.push(() => node.stop())
    const status = node.status()
    expect(status.running).toBe(true)
    const base = `https://127.0.0.1:${status.port}`
    await node.setExtraUrls([base])

    const joinDir = temp()
    const identity = loadIdentity(join(joinDir, 'devices'))
    const secrets = new Secrets(join(joinDir, 'secrets'), new FileKeyCipher(join(joinDir, 'secrets.key')))
    await pair(parsePairLink(node.offer().uri), headlessFacts('phone-like', '9.9.9', [], identity.fp), readConfig(joinDir), joinDir, { dataDir: joinDir, secrets })
    const client = await connectRpc(base, status.fp, secrets.get(PASS_SECRET) ?? '', headlessFacts('phone-like', '9.9.9', [], identity.fp))
    closers.push(() => client.close())

    // The first message starts a turn that runs `sleep 30` (chat.send answers when that turn ends: not awaited).
    const first = client.call('chat.send', 'Wait for the build to finish', [], '')
    await until(async () => (await server.store.list('chat_item')).some((row) => row.kind === 'activity' && row.text.includes('sleep')))
    await new Promise((resolve) => setTimeout(resolve, 300))
    const sentAt = Date.now()
    await client.call('chat.send', 'whoa STOP-RPC, not that build', [], '')

    const reached = await until(async () => seen.find((request) => request.body.includes('STOP-RPC')))
    expect(reached.at - sentAt).toBeLessThan(3000)
    expect(reached.body).toContain(CUT_SHORT_RESULT.slice(0, 40))
    await until(async () => (await server.store.list('chat_item')).some((row) => row.kind === 'agent' && row.text === 'Stopped over the wire.'))
    await first
    // The read was cut short: the first turn ended long before the 30 s sleep would have.
    expect(Date.now() - sentAt).toBeLessThan(15_000)
    const row = (await server.store.list('chat_item')).find((item) => item.kind === 'user' && item.text === 'whoa STOP-RPC, not that build')
    expect(JSON.parse(row?.meta ?? '{}')).toMatchObject({ route: 'join', delivered: true })
  })
})
