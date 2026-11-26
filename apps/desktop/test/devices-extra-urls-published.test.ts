/**
 * 26 Nov 2026: an address added to the PC's devices/config.json (extraUrls, a WSL relay) never reached its own device
 * row, so no other device learned it: the settings were read once at start and never again, and the next save from
 * the app would even have written the old list back over the edit. Extra addresses now reach the row (and the hello
 * the answering brain keeps) without a restart, however they were added.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { get as httpsGet } from 'node:https'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { DevicesConfigFile } from '../src/main/devices/config'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

function makeService(dir: string, store: Store, extra: Partial<ConstructorParameters<typeof DevicesService>[0]> = {}): DevicesService {
  const data = new Map<string, string>()
  return new DevicesService({
    userData: dir,
    store,
    secrets: { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) },
    registry: new HandlerRegistry(),
    appVersion: '1.0.0',
    nodeName: () => 'Test PC',
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: join(dir, 'none'),
    emitWindow: () => undefined,
    ...extra,
  })
}

async function started(extra: Partial<ConstructorParameters<typeof DevicesService>[0]> = {}): Promise<{ dir: string; store: Store; service: DevicesService; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-extra-urls-'))
  const store = new Store(join(dir, 'agent.db'))
  const service = makeService(dir, store, extra)
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => service.stop())
  await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
  await service.start()
  await service.setEnabled(true)
  return { dir, store, service, file: join(dir, 'devices', 'config.json') }
}

async function ownRowUrls(store: Store, service: DevicesService): Promise<string[]> {
  const id = service.status().nodeId
  const row = await store.get('device', id)
  return row?.urls ?? []
}

describe('extra addresses reach this node’s own device row', () => {
  it('an address added to config.json by hand while the app runs is published in the row, without a restart', async () => {
    const { store, service, file } = await started()
    expect(await ownRowUrls(store, service)).not.toContain('https://100.100.10.20:7788')
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { extraUrls: string[] }
    writeFileSync(file, JSON.stringify({ ...onDisk, extraUrls: [...onDisk.extraUrls, 'https://100.100.10.20:7788'] }, null, 2))
    expect(await service.checkConfig()).toBe(true)
    expect(await ownRowUrls(store, service)).toContain('https://100.100.10.20:7788')
    expect(service.status().urls).toContain('https://100.100.10.20:7788')
    // Nothing changed since: the next check is a no-op.
    expect(await service.checkConfig()).toBe(false)
  })

  it('the app saving its own settings keeps an address added by hand meanwhile', async () => {
    const { service, file } = await started()
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...onDisk, extraUrls: ['https://100.100.10.20:7788'] }, null, 2))
    // A Settings switch flipped before the periodic check took the edit.
    await service.setShareGroup('files', false)
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { extraUrls: string[]; shareGroups: Record<string, boolean> }
    expect(saved.extraUrls).toEqual(['https://100.100.10.20:7788'])
    expect(saved.shareGroups['files']).toBe(false)
  })

  it('a half-written or broken config.json is not taken (the last good settings stay)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-config-broken-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify({ enabled: true, extraUrls: ['https://a.example:7787'] }))
    const config = new DevicesConfigFile(file)
    writeFileSync(file, '{"enabled": tr')
    expect(config.reload()).toBe(false)
    expect(config.get().extraUrls).toEqual(['https://a.example:7787'])
  })

  it('new addresses say hello again to the answering brain, so its copy of this row is not written back stale', async () => {
    const { service } = await started()
    const uplink = (service as unknown as { uplink: { refresh(): void } }).uplink
    let hellos = 0
    const original = uplink.refresh.bind(uplink)
    uplink.refresh = () => {
      hellos += 1
      original()
    }
    await service.setExtraUrls(['https://100.100.10.20:7788'])
    expect(hellos).toBeGreaterThan(0)
  })

  it('the headless node keeps node.json and the Devices settings as one list of extra addresses', async () => {
    const seen: string[][] = []
    const { service } = await started({ onExtraUrls: (urls) => seen.push(urls) })
    await service.setExtraUrls(['https://127.0.0.1:7789', '100.100.10.30'])
    expect(seen.at(-1)).toEqual(['https://127.0.0.1:7789', `https://100.100.10.30:${service.status().port}`])
  })
})

describe('GET /v1/health?deep=1 (the freeze supervisor’s question)', () => {
  const ask = (port: number, path: string): Promise<{ status: number; body: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const req = httpsGet({ host: '127.0.0.1', port, path, rejectUnauthorized: false }, (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) as Record<string, unknown> }))
      })
      req.on('error', reject)
    })

  it('answers deep ok after one read through the database read queue, and 503 stuck when that read does not come back', async () => {
    let hang = false
    let reads = 0
    const { service, store } = await started({
      deepCheck: async () => {
        reads += 1
        if (hang) await new Promise(() => undefined)
        await store.probe()
      },
      deepCheckMs: 300,
    })
    const port = service.status().port
    const fine = await ask(port, '/v1/health?deep=1')
    expect(fine.status).toBe(200)
    expect(fine.body['deep']).toBe('ok')
    // The plain check other devices use is unchanged and never waits on the database.
    const plain = await ask(port, '/v1/health')
    expect(plain.status).toBe(200)
    expect(plain.body['deep']).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 2_100))
    hang = true
    const stuck = await ask(port, '/v1/health?deep=1')
    expect(stuck.status).toBe(503)
    expect(stuck.body['deep']).toBe('stuck')
    expect(reads).toBe(2)
    expect(service.probeTarget()).toEqual({ host: '127.0.0.1', port })
  })
})
