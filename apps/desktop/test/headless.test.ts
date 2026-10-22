import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:https'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { providerFor } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { CHANNELS } from '../src/shared/channels'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { FileKeyCipher } from '../src/headless/file-cipher'
import { parseArgs } from '../src/headless/main'
import { ensureCert, readConfig } from '../src/headless/node-config'
import { selfFacts, startNodeServer } from '../src/headless/node-server'
import { pair, parsePairLink, shortCodeTarget, PASS_SECRET } from '../src/headless/pair'
import { pinnedJson } from '../src/headless/pinned'
import { startHeadlessRuntime, type HeadlessRuntime } from '../src/headless/runtime'

// Each test boots a whole runtime (two SQLite files, the tool registry); on a busy machine that takes seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const temps: string[] = []
const closers: Array<() => Promise<void> | void> = []
let fake: FakeAi | null = null

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
    const settings = (await runtime.ipc.invoke(CHANNELS.settings.get, [])) as { model: string }
    expect(settings.model).toBe('fake-model')
    expect(runtime.busy()).toBe(false)
  })
})

describe('headless node server', () => {
  it('answers /v1/health over TLS pinned by fingerprint, and refuses a wrong pin before sending', async () => {
    fake = await startFakeAi(() => ({ text: 'ok' }))
    const dataDir = temp()
    const runtime = await bootRuntime(dataDir)
    const config = { ...readConfig(dataDir), port: 0 }
    const cert = ensureCert(dataDir, config.name)
    const node = await startNodeServer({ runtime, config, cert, version: '9.9.9' })
    closers.push(() => node.close())

    const health = await pinnedJson(`https://127.0.0.1:${node.port}/v1/health`, { fp: cert.fp })
    expect(health.status).toBe(200)
    expect(health.json).toMatchObject({ id: config.id, version: '9.9.9', ready: true, busy: false, roles: ['brain', 'hands'] })
    expect(health.fp).toBe(cert.fp)
    const other = ensureCert(temp(), 'other')
    await expect(pinnedJson(`https://127.0.0.1:${node.port}/v1/health`, { fp: other.fp })).rejects.toThrow(/different certificate/)
    expect((await pinnedJson(`https://127.0.0.1:${node.port}/v1/devices`, { fp: cert.fp })).status).toBe(404)
  })
})

interface FakeNode {
  url: string
  fp: string
  seen: string[]
  server: Server
}

async function fakePairingNode(): Promise<FakeNode> {
  const cert = ensureCert(temp(), 'desk')
  const seen: string[] = []
  const pass = 'p'.repeat(43)
  const server = createServer({ cert: cert.cert, key: cert.key }, (req, res) => {
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
  return { url: `https://127.0.0.1:${port}`, fp: cert.fp, seen, server }
}

describe('headless pairing', () => {
  it('pairs from a pairing link, stores the pass, and takes in the bundle', async () => {
    const desk = await fakePairingNode()
    const dataDir = temp()
    const config = readConfig(dataDir)
    const settings = new SettingsStore(join(dataDir, 'settings.json'))
    const secrets = new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key')))
    const link = `agent://pair?v=1&mesh=mesh_1&node=node_desk&name=Desk&u=${encodeURIComponent(desk.url)}&fp=${desk.fp}&c=ABCD-EFGH`
    const facts = selfFacts(config, '9.9.9', [], '')

    const outcome = await pair(parsePairLink(link), facts, config, dataDir, { dataDir, settings, secrets })

    expect(outcome).toMatchObject({ deviceId: 'dev_server', meshId: 'mesh_1', bundleError: '' })
    expect(secrets.get(PASS_SECRET)).toBe('p'.repeat(43))
    expect(secrets.get('apiKey-acc1')).toBe('sk-from-desk')
    expect(JSON.parse(secrets.get('passHashes') ?? '{}')).toEqual({ dev_phone: 'ab'.repeat(32) })
    expect(settings.get().agentName).toBe('Desk agent')
    expect(settings.get().accounts[0]).toMatchObject({ id: 'acc1', model: 'from-desk', hasKey: true })
    // A shortcut belongs to the device it was set on.
    expect(settings.get().quickAskHotkey).not.toBe('Ctrl+Space')
    const saved = readConfig(dataDir)
    expect(saved).toMatchObject({ meshId: 'mesh_1', deviceId: 'dev_server' })
    expect(saved.brains[0]).toMatchObject({ id: 'node_desk', fp: desk.fp })
    // Neither the pass nor the key is written anywhere but the secrets store.
    expect(readFileSync(join(dataDir, 'node.json'), 'utf8')).not.toContain('ppppp')
    expect(readFileSync(join(dataDir, 'settings.json'), 'utf8')).not.toContain('sk-from-desk')
  })

  it('pairs by address and short code, trusting the certificate on first use', async () => {
    const desk = await fakePairingNode()
    const dataDir = temp()
    const config = readConfig(dataDir)
    const target = shortCodeTarget(desk.url, 'abcdefgh')
    expect(target.code).toBe('ABCD-EFGH')
    const outcome = await pair(target, selfFacts(config, '9.9.9', [], ''), config, dataDir, {
      dataDir,
      settings: new SettingsStore(join(dataDir, 'settings.json')),
      secrets: new Secrets(join(dataDir, 'secrets'), new FileKeyCipher(join(dataDir, 'secrets.key'))),
    })
    expect(outcome.fp).toBe(desk.fp)
  })

  it('sends nothing to a node whose certificate does not match the link', async () => {
    const desk = await fakePairingNode()
    const dataDir = temp()
    const config = readConfig(dataDir)
    const wrong = ensureCert(temp(), 'imposter').fp
    const link = `agent://pair?v=1&u=${encodeURIComponent(desk.url)}&fp=${wrong}&c=ABCD-EFGH`
    await expect(
      pair(parsePairLink(link), selfFacts(config, '9.9.9', [], ''), config, dataDir, {
        dataDir,
        settings: new SettingsStore(join(dataDir, 'settings.json')),
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
