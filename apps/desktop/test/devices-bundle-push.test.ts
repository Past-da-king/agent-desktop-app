/**
 * A brain pushes its bundle to a peer that cannot reach it (POST /v1/bundle): a server that joined from behind a
 * userspace VPN never reads the desktop's bundle again, so a phone paired later was refused there (live
 * cross-machine test, 22 Oct 2026, check f). The peer takes it only from a brain and only when it is newer.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { ProfileStore } from '../src/main/apps/profiles'
import { ConnectedAppsFile, LearnedStore } from '../src/main/apps/store'
import { BundleKeeper, pushBundle, registerBundle } from '../src/main/devices/bundle'
import type { PassTable } from '../src/main/devices/types'
import { startTestHost } from './devices-host'

const dirs: string[] = []
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const plain = { isEncryptionAvailable: () => false, encryptString: (t: string) => Buffer.from(t), decryptString: (b: Buffer) => b.toString('utf8') }

function passTable(): PassTable {
  let table: Record<string, string> = {}
  return { all: () => ({ ...table }), set: (id, hash) => void (table[id] = hash), remove: (id) => void delete table[id], replaceAll: (next) => void (table = { ...next }) }
}

function nodeState(clock: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-push-'))
  dirs.push(dir)
  const store = new Store(':memory:')
  closers.push(() => store.close())
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const passes = passTable()
  const keeper = new BundleKeeper({
    settings: { get: () => settings.get(), save: (patch) => settings.save(patch), onChange: (l) => settings.onChange(() => l()) },
    secrets: new Secrets(join(dir, 'secrets'), plain),
    profiles: new ProfileStore(join(dir, 'profiles.json')),
    learned: new LearnedStore(join(dir, 'learned-apps.json')),
    connected: new ConnectedAppsFile(join(dir, 'connected-apps.json')),
    passes,
    projects: () => store.list('project'),
    local: store,
    now: clock,
  })
  closers.push(() => keeper.dispose())
  return { store, settings, passes, keeper }
}

describe('pushing the bundle to a peer that cannot reach this node', () => {
  it('a brain hands its newer bundle over; a screen, an old bundle or junk are refused', async () => {
    let now = 10_000
    const desk = nodeState(() => now)
    const server = nodeState(() => now)
    desk.settings.save({ agentName: 'Kit' })
    desk.keeper.check()
    const host = await startTestHost('dev_server')
    closers.push(() => host.close())
    const base = { kind: 'desktop', platform: 'linux', priority: 0, urls: [], fp: '', facts: {}, pairedAt: 0, lastSeen: 0, revoked: false }
    await server.store.upsert('device', { ...base, id: 'dev_phone', name: 'Phone', kind: 'phone', roles: ['screen'] })
    host.passes.set('pass-desk', { deviceId: 'dev_desk', node: true })
    host.passes.set('pass-phone', { deviceId: 'dev_phone', node: false })
    closers.push(registerBundle(host, { keeper: server.keeper, devices: () => server.store.list('device') }))

    // A phone pairs with the desk later: its pass hash is in the desk's bundle, the server has never seen it.
    now = 20_000
    desk.passes.set('dev_phone2', 'b'.repeat(64))
    expect(desk.keeper.check()).toBe(true)
    // The desk's row has not reached the server yet; the node auth (knownPeer) let it in as a brain.
    expect(await pushBundle(desk.keeper, host.url, 'pass-desk', fetch)).toBe(true)
    expect(server.passes.all()['dev_phone2']).toBe('b'.repeat(64))
    expect(server.settings.get().agentName).toBe('Kit')
    // The same again is not newer: kept as it is.
    expect(await pushBundle(desk.keeper, host.url, 'pass-desk', fetch)).toBe(false)

    // A screen may not hand a bundle over (and a phone pass is not a node pass at all).
    const fromPhone = await fetch(`${host.url}/v1/bundle`, { method: 'POST', headers: { Authorization: 'Bearer pass-phone', 'content-type': 'application/json' }, body: JSON.stringify(await desk.keeper.build(true)) })
    expect(fromPhone.status).toBeGreaterThanOrEqual(400)
    const junk = await fetch(`${host.url}/v1/bundle`, { method: 'POST', headers: { Authorization: 'Bearer pass-desk', 'content-type': 'application/json' }, body: JSON.stringify({ hello: 1 }) })
    expect(junk.status).toBe(400)
  })
})
