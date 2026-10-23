import { spawn, spawnSync } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer, type Server } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DatabaseSync } from 'node:sqlite'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { providerFor } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { CHANNELS } from '../src/shared/channels'
import { WORKER_CHANNELS } from '../src/shared/workers-channels'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { FileKeyCipher } from '../src/headless/file-cipher'
import { parseArgs } from '../src/headless/main'
import { derFromPem, fingerprintOf, makeSelfSignedCert } from '../src/main/devices/cert'
import { loadIdentity } from '../src/main/devices/identity'
import { SecretPassTable } from '../src/main/devices/passes'
import { canRunTurns, headlessFacts, JOIN_CHANNEL, startHeadlessDevices } from '../src/headless/devices'
import { readConfig } from '../src/headless/node-config'
import { pair, parsePairLink, shortCodeTarget, PASS_SECRET } from '../src/headless/pair'
import { connectRpc } from './devices-client'
import { pinnedJson, setNodeProxy } from '../src/headless/pinned'
import { parseSocksProxy } from '../src/main/devices/socks'
import { createServer as createTcpServer, connect as tcpConnect } from 'node:net'
import { startHeadlessRuntime, type HeadlessRuntime } from '../src/headless/runtime'
import { testContext } from './support'

// Each test boots a whole runtime (two SQLite files, the tool registry); on a busy machine that takes seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const temps: string[] = []
const closers: Array<() => Promise<void> | void> = []
let fake: FakeAi | null = null

/** A throwaway node certificate and its fingerprint. */
function cert(name: string): { cert: string; key: string; fp: string } {
  const made = makeSelfSignedCert(name)
  return { cert: made.certPem, key: made.keyPem, fp: fingerprintOf(derFromPem(made.certPem)) }
}

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-node-test-'))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await fake?.close()
  fake = null
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function bootRuntime(dataDir: string): Promise<HeadlessRuntime> {
  // What a paired node has after taking in the bundle: an API account with its key.
  const settings = new SettingsStore(join(dataDir, 'settings.json'))
  settings.save({ hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false })
  new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key'))).set('apiKey', 'test-key')
  const runtime = await startHeadlessRuntime({
    dataDir,
    appDir: root,
    version: '9.9.9',
    quiet: true,
    // As on a machine with no Chromium: the browser tools stay listed and say so (headless-browser.test.ts has one).
    chromium: null,
    providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
  })
  closers.push(() => runtime.stop(0))
  return runtime
}

describe('headless file-key cipher', () => {
  it('round-trips, keeps the key file private, and refuses another key', () => {
    const dir = temp()
    const cipher = new FileKeyCipher(join(dir, 'k', 'secrets.key'))
    const sealed = cipher.encryptString('sk-test-value')
    expect(sealed.toString('utf8')).not.toContain('sk-test-value')
    expect(cipher.decryptString(sealed)).toBe('sk-test-value')
    expect(statSync(join(dir, 'k', 'secrets.key')).mode & 0o777).toBe(0o600)
    expect(new FileKeyCipher(join(dir, 'k', 'secrets.key')).decryptString(sealed)).toBe('sk-test-value')
    expect(() => new FileKeyCipher(join(dir, 'other.key')).decryptString(sealed)).toThrow()
  })
})

describe('headless runtime', () => {
  it('runs a chat turn with a memory tool on a fake AI, and serves the app contract', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0
        ? { toolCalls: [{ name: 'memory_save', input: { title: 'Lerato', body: 'Lives in Durban.', topics: 'family' } }] }
        : { text: 'Saved it.' },
    )
    const runtime = await bootRuntime(temp())

    await runtime.runner.send('Remember that Lerato lives in Durban')

    const memories = await runtime.store.list('memory')
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({ title: 'Lerato', body: 'Lives in Durban.' })
    const items = await runtime.store.list('chat_item')
    expect(items.some((row) => row.kind === 'agent' && row.text === 'Saved it.')).toBe(true)
    expect(fake.requests[0]?.headers['authorization']).toBe('Bearer test-key')
    // The browser tools are present but say they are not here.
    const tools = (fake.requests[0]?.body['tools'] ?? []) as Array<{ function?: { name?: string; description?: string } }>
    const open = tools.find((tool) => tool.function?.name === 'browser_open')
    expect(open?.function?.description).toMatch(/^Not available on this device/)

    // The same handlers the window calls over IPC, ready for /v1/rpc.
    expect(runtime.ipc.handlers.size).toBeGreaterThan(40)
    // Background workers run here too: their tools are offered and their part of the contract answers.
    expect(tools.some((tool) => (tool.function?.name ?? '').startsWith('worker'))).toBe(true)
    expect(await runtime.ipc.invoke(WORKER_CHANNELS.list, [])).toEqual([])
    const settings = (await runtime.ipc.invoke(CHANNELS.settings.get, [])) as { model: string }
    expect(settings.model).toBe('fake-model')
    expect(runtime.busy()).toBe(false)
    // A linked phone with no Google key asks this node for a call: with no key here it is told where to add one.
    expect(runtime.registry.has(CHANNELS.voice.liveToken)).toBe(true)
    expect(await runtime.ipc.invoke(CHANNELS.voice.liveToken, [])).toMatchObject({ ok: false, needsKey: true })
  })
})

describe('headless node as a Devices node (A\'s server)', () => {
  it('pairs another headless node as a brain, and runs a chat turn for it over /v1/rpc', async () => {
    fake = await startFakeAi(() => ({ text: 'Answered by the server.' }))
    // Node one: the server that answers.
    const serverDir = temp()
    const server = await bootRuntime(serverDir)
    let node = await startHeadlessDevices(server, { name: 'server-one', version: '9.9.9', listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    closers.push(() => node.stop())
    let status = node.status()
    for (let attempt = 0; !status.running && attempt < 4; attempt++) {
      await node.stop()
      node = await startHeadlessDevices(server, { name: 'server-one', version: '9.9.9', listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
      status = node.status()
    }
    expect(status.running).toBe(true)
    const base = `https://127.0.0.1:${status.port}`
    await node.setExtraUrls([base])

    const health = await pinnedJson(`${base}/v1/health`, { fp: status.fp })
    expect(health.json).toMatchObject({ id: node.identity.nodeId, name: 'server-one', version: '9.9.9', ready: true, busy: false })
    expect(canRunTurns(server)).toBe(true)
    await expect(pinnedJson(`${base}/v1/health`, { fp: cert('other').fp })).rejects.toThrow(/different certificate/)

    // Node two pairs with it from the QR text, as `agent-node pair` does.
    const joinDir = temp()
    const config = readConfig(joinDir)
    const identity = loadIdentity(join(joinDir, 'devices'))
    const secrets = new Secrets(join(joinDir, 'secrets'), new FileKeyCipher(join(joinDir, 'secrets.key')))
    const offer = node.offer()
    const outcome = await pair(parsePairLink(offer.uri), headlessFacts('server-two', '9.9.9', [], identity.fp), config, joinDir, { dataDir: joinDir, secrets })
    expect(outcome.meshId).toBe(node.identity.meshId)
    expect(loadIdentity(join(joinDir, 'devices')).meshId).toBe(node.identity.meshId)
    const pass = secrets.get(PASS_SECRET) ?? ''
    expect(pass.length).toBeGreaterThan(20)
    const row = await server.store.get('device', outcome.deviceId)
    expect(row).toMatchObject({ name: 'server-two', kind: 'server', revoked: false })
    expect(row?.roles).toEqual(expect.arrayContaining(['brain', 'hands']))

    // The joined node drives the server's runtime over the wire: read settings, send a message, see the answer.
    const client = await connectRpc(base, status.fp, pass, headlessFacts('server-two', '9.9.9', [], identity.fp))
    closers.push(() => client.close())
    const remoteSettings = (await client.call('settings.get')) as { model: string }
    expect(remoteSettings.model).toBe('fake-model')
    await client.call('chat.send', 'hello over the wire', [], '')
    await waitUntil(async () => (await server.store.list('chat_item')).some((r) => r.kind === 'agent' && r.text === 'Answered by the server.'))
    const items = await server.store.list('chat_item')
    const asked = items.find((r) => r.kind === 'user' && r.text === 'hello over the wire')
    expect(JSON.parse(asked?.meta ?? '{}').origin).toMatchObject({ deviceId: outcome.deviceId, kind: 'server' })
  })
})

async function waitUntil(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('timed out')
}

interface FakeNode {
  url: string
  fp: string
  seen: string[]
  server: Server
}

async function fakePairingNode(): Promise<FakeNode> {
  const desk = cert('desk')
  const seen: string[] = []
  const pass = 'p'.repeat(43)
  const server = createServer({ cert: desk.cert, key: desk.key }, (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`)
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/pair' && body['code'] === 'ABCD-EFGH' && (body['wantRoles'] as string[]).includes('brain')) {
        res.end(JSON.stringify({ deviceId: 'dev_server', pass, meshId: 'mesh_1', node: { id: 'node_desk', name: 'Desk' }, brains: [] }))
      } else if (req.url === '/v1/bundle' && req.headers.authorization === `Bearer ${pass}`) {
        res.end(JSON.stringify({
          settings: { agentName: 'Desk agent', quickAskHotkey: 'Ctrl+Space' },
          accounts: [{ id: 'acc1', label: 'Work key', kind: 'api', provider: 'openai', model: 'from-desk', hasKey: true }],
          secrets: { 'apiKey-acc1': 'sk-from-desk', passHashes: { dev_phone: 'ab'.repeat(32) } },
        }))
      } else {
        res.statusCode = 401
        res.end(JSON.stringify({ error: 'no' }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  closers.push(() => new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  return { url: `https://127.0.0.1:${port}`, fp: desk.fp, seen, server }
}

describe('headless pairing', () => {
  it('pairs from a pairing link, stores the pass, and records the brain to join', async () => {
    const desk = await fakePairingNode()
    const dataDir = temp()
    const config = readConfig(dataDir)
    const secrets = new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key')))
    const link = `agent://pair?v=1&mesh=mesh_1&node=node_desk&name=Desk&u=${encodeURIComponent(desk.url)}&fp=${desk.fp}&c=ABCD-EFGH`
    const facts = headlessFacts('server-two', '9.9.9', [], '')

    const outcome = await pair(parsePairLink(link), facts, config, dataDir, { dataDir, secrets })

    expect(outcome).toMatchObject({ deviceId: 'dev_server', meshId: 'mesh_1' })
    expect(secrets.get(PASS_SECRET)).toBe('p'.repeat(43))
    const saved = readConfig(dataDir)
    expect(saved).toMatchObject({ meshId: 'mesh_1', deviceId: 'dev_server', join: { url: desk.url, fp: desk.fp } })
    expect(saved.brains[0]).toMatchObject({ id: 'node_desk', fp: desk.fp })
    // The pass is written nowhere but the secrets store.
    expect(readFileSync(join(dataDir, 'node.json'), 'utf8')).not.toContain('ppppp')
  })

  it('pairs by address and short code, trusting the certificate on first use', async () => {
    const desk = await fakePairingNode()
    const dataDir = temp()
    const config = readConfig(dataDir)
    const target = shortCodeTarget(desk.url, 'abcdefgh')
    expect(target.code).toBe('ABCD-EFGH')
    const outcome = await pair(target, headlessFacts('server-two', '9.9.9', [], ''), config, dataDir, {
      dataDir,
      secrets: new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key'))),
    })
    expect(outcome.fp).toBe(desk.fp)
  })

  it('sends nothing to a node whose certificate does not match the link', async () => {
    const desk = await fakePairingNode()
    const dataDir = temp()
    const config = readConfig(dataDir)
    const wrong = cert('imposter').fp
    const link = `agent://pair?v=1&u=${encodeURIComponent(desk.url)}&fp=${wrong}&c=ABCD-EFGH`
    await expect(
      pair(parsePairLink(link), headlessFacts('server-two', '9.9.9', [], ''), config, dataDir, {
        dataDir,
        secrets: new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key'))),
      }),
    ).rejects.toThrow(/Could not reach/)
    expect(desk.seen).toEqual([])
  })

  it('reads links, short codes and arguments strictly', () => {
    expect(() => parsePairLink('https://example.invalid')).toThrow(/pairing link/)
    expect(() => parsePairLink('agent://pair?v=1&c=x')).toThrow(/missing/)
    expect(() => shortCodeTarget('https://127.0.0.1:7787', 'O0O0-1111')).toThrow(/short code/)
    expect(shortCodeTarget('127.0.0.1', 'ABCDEFGH').urls).toEqual(['https://127.0.0.1:7787'])
    const args = parseArgs(['start', '--daemon', '--port', '7790', '--data-dir=/x'])
    expect(args.command).toBe('start')
    expect(args.flags.get('daemon')).toBe(true)
    expect(args.flags.get('port')).toBe('7790')
    expect(args.flags.get('data-dir')).toBe('/x')
  })
})

describe('headless bundle', () => {
  it('builds without Electron and its CLI runs under plain Node', () => {
    const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-headless.mjs'), '--bundle'], { cwd: root, encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    const dataDir = temp()
    // From a folder with no node_modules anywhere above it, so nothing can resolve a stray 'electron'.
    const ran = spawnSync(process.execPath, [join(root, 'dist-headless', 'agent-node.mjs'), 'status', '--data-dir', dataDir], {
      cwd: tmpdir(),
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: '' },
    })
    expect(ran.status, ran.stderr).toBe(0)
    expect(ran.stdout).toContain('agent-node 0.')
    const bundle = readFileSync(join(root, 'dist-headless', 'agent-node.mjs'), 'utf8')
    expect(bundle).not.toMatch(/from ["']electron["']/)
  }, 60_000)
})

function cli(args: string[], stdin = ''): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'dist-headless', 'agent-node.mjs'), ...args], { cwd: tmpdir() })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (err += d.toString()))
    child.on('close', (code) => resolve({ code: code ?? -1, out, err }))
    child.stdin.end(stdin)
  })
}

describe('headless CLI, end to end', () => {
  it('adds an API account from stdin and answers one turn through the built bundle', async () => {
    const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-headless.mjs'), '--bundle'], { cwd: root, encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    fake = await startFakeAi(() => ({ text: 'Hello from the server.' }))
    const dataDir = temp()
    const added = await cli(['account', 'add', 'api', '--provider', 'openai', '--base-url', fake.url, '--allow-http', '--model', 'fake-model', '--data-dir', dataDir], 'sk-cli-test' + String.fromCharCode(10))
    expect(added.code, added.err).toBe(0)
    // The key is in the encrypted store, nowhere in plain text.
    expect(readFileSync(join(dataDir, 'settings.json'), 'utf8')).not.toContain('sk-cli-test')
    const listed = await cli(['account', 'list', '--data-dir', dataDir])
    expect(listed.out).toMatch(/api\/openai {2}key saved {2}\(main\)/)

    const asked = await cli(['ask', 'Say hello', '--data-dir', dataDir])
    expect(asked.code, asked.err + asked.out).toBe(0)
    expect(asked.out).toContain('Hello from the server.')
    expect(fake.requests[0]?.headers['authorization']).toBe('Bearer sk-cli-test')
  }, 60_000)
})

describe('headless CLI pairing, end to end', () => {
  it('offers from a running node, pairs a second node with the printed link, lists and revokes it', async () => {
    const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-headless.mjs'), '--bundle'], { cwd: root, encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    const one = temp()
    const two = temp()
    const port = String(20000 + Math.floor(Math.random() * 30000))
    expect((await cli(['config', '--port', port, '--url', `https://127.0.0.1:${port}`, '--data-dir', one])).code).toBe(0)
    const started = await cli(['start', '--daemon', '--data-dir', one])
    closers.push(async () => {
      await cli(['stop', '--data-dir', one])
    })
    expect(started.code, started.err + started.out).toBe(0)

    const offered = await cli(['offer', '--data-dir', one])
    expect(offered.code, offered.err).toBe(0)
    // The QR is drawn in half blocks, then the link and code.
    expect(offered.out).toMatch(/[\u2580\u2584\u2588]{10}/)
    const link = /Pairing link: (agent:\/\/pair\?\S+)/.exec(offered.out)?.[1] ?? ''
    expect(link).toContain(`u=${encodeURIComponent(`https://127.0.0.1:${port}`)}`)

    const paired = await cli(['pair', link, '--data-dir', two])
    expect(paired.code, paired.err + paired.out).toBe(0)
    expect(paired.out).toMatch(/Paired with https:\/\/127\.0\.0\.1/)

    const listed = await cli(['devices', '--data-dir', one])
    const joined = /^(dev_\S+)\s+\S+\s+server\/linux\s+brain\+hands/m.exec(listed.out.split('\n').slice(1).join('\n'))
    expect(listed.out.split('\n').filter((l) => l.startsWith('dev_')).length).toBe(2)
    const id = joined?.[1] ?? listed.out.split('\n').filter((l) => l.startsWith('dev_'))[1]?.split(' ')[0] ?? ''
    expect((await cli(['revoke', id, '--data-dir', one])).code).toBe(0)
    expect((await cli(['devices', '--data-dir', one])).out).toContain('revoked')
    // Anyone without the folder's permissions cannot reach the control line.
    expect(statSync(join(one, 'control.sock')).mode & 0o777).toBe(0o600)
  }, 90_000)
})

describe('relay: fetching through a paired computer', () => {
  it('a paired node fetches a page through the other node; a screen may not', async () => {
    // A page only "the computer" fetches for the server (loopback is allowed for the test only).
    const page = createHttpServer((_req, res) => {
      res.setHeader('content-type', 'text/html')
      res.end('<html><body><h1>Only from home</h1><p>secret-relay-text</p></body></html>')
    })
    await new Promise<void>((resolve) => page.listen(0, '127.0.0.1', () => resolve()))
    closers.push(() => new Promise<void>((resolve) => page.close(() => resolve())))
    const pageAddress = page.address()
    const pageUrl = `http://127.0.0.1:${typeof pageAddress === 'object' && pageAddress !== null ? pageAddress.port : 0}/`

    fake = await startFakeAi((body, index) =>
      JSON.stringify(body).includes('Fetched through') || index > 3
        ? { text: 'Got it through the computer.' }
        : { toolCalls: [{ name: 'web_fetch_via_device', input: { url: pageUrl } }] },
    )
    const computer = await bootRuntime(temp())
    let node = await startHeadlessDevices(computer, { name: 'home-computer', version: '9.9.9', listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000), relayLoopback: true })
    for (let attempt = 0; !node.status().running && attempt < 4; attempt++) {
      await node.stop()
      node = await startHeadlessDevices(computer, { name: 'home-computer', version: '9.9.9', listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000), relayLoopback: true })
    }
    closers.push(() => node.stop())
    const status = node.status()
    const base = `https://127.0.0.1:${status.port}`
    await node.setExtraUrls([base])

    // The server pairs with the computer, then its agent fetches through it.
    const serverDir = temp()
    const identity = loadIdentity(join(serverDir, 'devices'))
    await pair(parsePairLink(node.offer().uri), headlessFacts('the-server', '9.9.9', [], identity.fp), readConfig(serverDir), serverDir, {
      dataDir: serverDir,
      secrets: new Secrets(join(serverDir, 'secrets'), new FileKeyCipher(join(serverDir, 'secrets.key'))),
    })
    const server = await bootRuntime(serverDir)
    await server.runner.send('Read that page from home')
    const toolResult = fake.requests.map((r) => JSON.stringify(r.body)).find((b) => b.includes('Fetched through')) ?? ''
    expect(toolResult).toContain('Fetched through home-computer')
    expect(toolResult).toContain('secret-relay-text')
    expect((await server.store.list('chat_item')).some((r) => r.kind === 'agent' && r.text === 'Got it through the computer.')).toBe(true)

    // A phone paired as a screen cannot use the computer's connection.
    const phone = await pinnedJson(`${base}/v1/pair`, {
      fp: status.fp,
      body: { code: node.offer().shortCode, device: headlessFacts('a-phone', '1.0', [], ''), wantRoles: ['screen'] },
    })
    const phonePass = (phone.json as { pass: string }).pass
    const client = await connectRpc(base, status.fp, phonePass, { ...headlessFacts('a-phone', '1.0', [], ''), kind: 'phone', platform: 'android' })
    closers.push(() => client.close())
    await expect(client.call('relay.fetch', { url: pageUrl })).rejects.toThrow(/Only your own computers/)
  }, 60_000)
})

describe('reaching other nodes through a SOCKS5 proxy', () => {
  it('pins the node certificate end to end through the proxy, and says when the proxy is down', async () => {
    const desk = await fakePairingNode()
    const seen: string[] = []
    const open = new Set<import('node:net').Socket>()
    // A minimal SOCKS5 proxy: no sign-in, CONNECT by IPv4 or name.
    const proxy = createTcpServer((client) => {
      open.add(client)
      client.once('data', () => {
        client.write(Buffer.from([0x05, 0x00]))
        client.once('data', (req: Buffer) => {
          const atyp = req[3]
          const host = atyp === 0x01 ? [...req.subarray(4, 8)].join('.') : req.subarray(5, 5 + (req[4] ?? 0)).toString()
          const at = atyp === 0x01 ? 8 : 5 + (req[4] ?? 0)
          const port = req.readUInt16BE(at)
          seen.push(`${host}:${port}`)
          // Every address is this test's node on loopback (the documentation address stands for a remote one).
          const upstream = tcpConnect({ host: '127.0.0.1', port }, () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            client.pipe(upstream)
            upstream.pipe(client)
          })
          open.add(upstream)
          upstream.on('error', () => client.destroy())
        })
      })
      client.on('error', () => undefined)
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve()))
    const proxyAddress = proxy.address()
    const proxyPort = typeof proxyAddress === 'object' && proxyAddress !== null ? proxyAddress.port : 0
    closers.push(() => {
      setNodeProxy(null)
      for (const socket of open) socket.destroy()
      return new Promise<void>((resolve) => proxy.close(() => resolve()))
    })

    setNodeProxy(parseSocksProxy(`socks5://127.0.0.1:${proxyPort}`))
    const remote = `https://192.0.2.10:${new URL(desk.url).port}`
    const reply = await pinnedJson(`${remote}/v1/bundle`, { fp: desk.fp, pass: 'x' })
    expect(reply.status).toBe(401)
    expect(seen).toEqual([`192.0.2.10:${new URL(desk.url).port}`])
    await expect(pinnedJson(`${remote}/v1/bundle`, { fp: cert('imposter').fp })).rejects.toThrow(/different certificate/)
    // This machine itself is never reached through the proxy.
    expect((await pinnedJson(`${desk.url}/v1/bundle`, { fp: desk.fp, pass: 'x' })).status).toBe(401)
    expect(seen).toHaveLength(2)

    setNodeProxy(parseSocksProxy('socks5://127.0.0.1:1'))
    // Refused or silent, depending on the network: either way a plain answer, not a hang.
    await expect(pinnedJson(`${remote}/v1/bundle`, { fp: desk.fp, timeoutMs: 3000 })).rejects.toThrow(/proxy (could not be reached|did not connect)/)
    expect(parseSocksProxy('http://127.0.0.1:8080')).toBeNull()
    expect(parseSocksProxy('socks5://[::1]:1055')).toEqual({ host: '::1', port: 1055 })
  })
})

describe('two running headless nodes, joined (A server + B sync), as two processes', () => {
  it('the second takes the first one\'s account and key, and the first one\'s memory replicates to it', async () => {
    const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-headless.mjs'), '--bundle'], { cwd: root, encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    fake = await startFakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'memory_save', input: { title: 'Lerato', body: 'Lives in Durban.', topics: 'family' } }] } : { text: 'Saved.' },
    )
    const port = (): string => String(20000 + Math.floor(Math.random() * 30000))
    const one = temp()
    const two = temp()
    const onePort = port()
    const twoPort = port()

    // Node one: an API account (key on stdin) and one memory, then it runs.
    expect((await cli(['account', 'add', 'api', '--provider', 'openai', '--base-url', fake.url, '--allow-http', '--model', 'fake-model', '--data-dir', one], 'sk-two-nodes')).code).toBe(0)
    expect((await cli(['ask', 'Remember Lerato lives in Durban', '--data-dir', one])).code).toBe(0)
    expect((await cli(['config', '--port', onePort, '--url', `https://127.0.0.1:${onePort}`, '--data-dir', one])).code).toBe(0)
    expect((await cli(['start', '--daemon', '--data-dir', one])).code).toBe(0)
    closers.push(async () => {
      await cli(['stop', '--data-dir', one])
    })

    // Node two: a fresh install, running, with nothing set up.
    expect((await cli(['config', '--port', twoPort, '--url', `https://127.0.0.1:${twoPort}`, '--data-dir', two])).code).toBe(0)
    expect((await cli(['start', '--daemon', '--data-dir', two])).code).toBe(0)
    closers.push(async () => {
      await cli(['stop', '--data-dir', two])
    })
    expect((await cli(['status', '--data-dir', two])).out).toContain('no AI account yet')

    // Pair two with one; it takes one's bundle at once.
    const offered = await cli(['offer', '--no-qr', '--data-dir', one])
    const link = /Pairing link: (agent:\/\/pair\?\S+)/.exec(offered.out)?.[1] ?? ''
    const paired = await cli(['pair', link, '--data-dir', two])
    expect(paired.code, paired.err + paired.out).toBe(0)
    expect(paired.out).toContain('Took in your settings, accounts and keys')
    expect((await cli(['status', '--data-dir', two])).out).toMatch(/state: running \(pid \d+\), ready/)

    // Replication: node one's memory arrives in node two's database.
    const memoryOnTwo = async (): Promise<boolean> => {
      const db = new DatabaseSync(join(two, 'agent.db'), { readOnly: true })
      try {
        const rows = db.prepare("SELECT payload FROM rows WHERE entity = 'memory' AND deleted = 0").all() as Array<{ payload: string }>
        return rows.some((row) => row.payload.includes('Lerato'))
      } finally {
        db.close()
      }
    }
    await waitUntil(memoryOnTwo, 45_000)
    const listed = await cli(['devices', '--data-dir', two])
    expect(listed.out.split('\n').filter((l) => l.startsWith('dev_')).length).toBe(2)
  }, 120_000)
})

describe('headless CLI: stop and status', () => {
  it('stop waits for the process to exit so start works at once, and status never sends loopback through the proxy', async () => {
    const built = spawnSync(process.execPath, [join(root, 'scripts', 'build-headless.mjs'), '--bundle'], { cwd: root, encoding: 'utf8' })
    expect(built.status, built.stderr).toBe(0)
    fake = await startFakeAi(() => ({ text: 'ok' }))
    const dir = temp()
    const port = String(20000 + Math.floor(Math.random() * 30000))
    expect((await cli(['account', 'add', 'api', '--provider', 'openai', '--base-url', fake.url, '--allow-http', '--data-dir', dir], 'sk-x')).code).toBe(0)
    // A proxy that is not there: other devices would go through it, this machine itself never does.
    expect((await cli(['config', '--port', port, '--proxy', 'socks5://127.0.0.1:1', '--data-dir', dir])).code).toBe(0)
    expect((await cli(['start', '--daemon', '--data-dir', dir])).code).toBe(0)
    closers.push(async () => {
      await cli(['stop', '--data-dir', dir])
    })
    expect((await cli(['status', '--data-dir', dir])).out).toMatch(/state: running \(pid \d+\), ready/)

    const stopped = await cli(['stop', '--data-dir', dir])
    expect(stopped.out).toContain('Stopped.')
    const again = await cli(['start', '--daemon', '--data-dir', dir])
    expect(again.code, again.out + again.err).toBe(0)
    expect(again.out).toMatch(/^Started/)
    expect((await cli(['status', '--data-dir', dir])).out).toMatch(/state: running \(pid \d+\), ready/)
  }, 90_000)
})

describe('the Vault on a headless node', () => {
  it('serves vault tools to its agents and to other devices, asks by default, and not with "Don\'t ask me"', async () => {
    const runtime = await bootRuntime(temp())
    const secret = 'node-secret-' + Math.random().toString(16).slice(2, 12)
    runtime.vault.save({ name: 'Server key', ref: 'server-key', kind: 'api_key', fields: { key: secret } })
    const lent = runtime.devicesHooks.localTools()
    for (const tools of [runtime.mainTools, lent]) {
      const names = tools.map((tool) => tool.spec.name)
      expect(names).toEqual(expect.arrayContaining(['vault_list', 'vault_reveal', 'vault_fill', 'vault_login', 'vault_save']))
    }
    const reveal = lent.find((tool) => tool.spec.name === 'vault_reveal')!
    const asked: string[] = []
    const ctx = testContext({ approve: async (summary) => (asked.push(summary), false) })
    expect(await reveal.run({ item: 'server-key', why: 'test' }, ctx)).not.toContain(secret)
    expect(asked).toHaveLength(1)
    runtime.vault.setPrefs({ dontAsk: true })
    expect(await reveal.run({ item: 'server-key', why: 'test' }, ctx)).toContain(secret)
    expect(asked).toHaveLength(1)
    const list = lent.find((tool) => tool.spec.name === 'vault_list')!
    expect(await list.run({}, ctx)).not.toContain(secret)
  }, 60_000)
})
