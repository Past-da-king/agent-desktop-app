/**
 * A joining node that cannot open connections out (a firewall, a userspace VPN) only ever hears from the brain it
 * paired with. The brain's first replication push must be let in although its device row has not arrived yet; the
 * row, once here, wins (revoked stays revoked). Found in the live cross-machine test, 22 Oct 2026.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { hashPass, newPass } from '../src/main/devices/passes'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import type { DeviceRole } from '../src/main/devices/types'
import { pinnedRequest } from './devices-client'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

async function node(knownPeer?: (id: string) => DeviceRole[] | null): Promise<{ service: DevicesService; store: Store; base: string; fp: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-peer-'))
  const store = new Store(join(dir, 'agent.db'))
  const data = new Map<string, string>()
  const service = new DevicesService({
    userData: dir,
    store,
    secrets: { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) },
    registry: new HandlerRegistry(),
    appVersion: '1.0.0',
    nodeName: () => 'Joining server',
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: join(dir, 'none'),
    emitWindow: () => undefined,
    kind: 'server',
    ...(knownPeer === undefined ? {} : { knownPeer }),
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => service.stop())
  await service.start()
  let status = service.status()
  for (let attempt = 0; attempt < 5 && !status.running; attempt += 1) {
    await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    status = await service.setEnabled(true)
  }
  return { service, store, base: `https://127.0.0.1:${status.port}`, fp: status.fp }
}

describe('a joining node lets in the brain it paired with before that brain\'s row arrives', () => {
  it('accepts the brain\'s pass with no row through knownPeer, and a revoked row still refuses it', async () => {
    const brainId = 'dev_brain_desk'
    const pass = newPass()
    const joined = await node((id) => (id === brainId ? ['brain', 'hands'] : null))
    // The bundle brought the brain's pass hash; its device row has not come yet.
    joined.service.passTable().set(brainId, hashPass(pass))
    const devices = () => pinnedRequest(`${joined.base}/v1/devices`, joined.fp, { headers: { Authorization: `Bearer ${pass}` } })
    expect((await devices()).status).toBe(200)
    // Node-only routes too: the brain is a brain.
    const other = await pinnedRequest(`${joined.base}/v1/devices/nobody/revoke`, joined.fp, { method: 'POST', headers: { Authorization: `Bearer ${pass}` } })
    expect(other.status).toBe(404)

    await joined.store.upsert('device', { id: brainId, name: 'Desk', kind: 'desktop', platform: 'windows', roles: ['brain', 'hands'], priority: 0, urls: [], fp: '', facts: {} as never, pairedAt: 1, lastSeen: 1, revoked: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await devices()).status).toBe(401)
  })

  it('without knownPeer a pass with no row is refused, as before', async () => {
    const plain = await node()
    const pass = newPass()
    plain.service.passTable().set('dev_someone', hashPass(pass))
    expect((await pinnedRequest(`${plain.base}/v1/devices`, plain.fp, { headers: { Authorization: `Bearer ${pass}` } })).status).toBe(401)
  })
})
