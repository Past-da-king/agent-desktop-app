/**
 * registerDevicesSync end to end: two brains on pinned HTTPS, wired the way the node server wires them. Rows
 * replicate both ways, and a key and a setting added on one brain reach the other through the bundle.
 */
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, keyNameFor } from '@agent/core'

import { Store } from '../src/main/db'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { ProfileStore } from '../src/main/apps/profiles'
import { fingerprintOf } from '../src/main/devices/pinned-fetch'
import { registerDevicesSync, type DevicesSync } from '../src/main/devices/sync'
import { buildSystemPrompt as buildPrompt } from '../src/main/runtime/prompt'
import { facts, startTestHost } from './devices-host'
import { waitFor } from '../../../packages/core/test/helpers'


function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function makeCert(dir: string, name: string): { key: string; cert: string; fp: string } {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=agent-node', '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.pem`)], { stdio: 'ignore' })
  const cert = readFileSync(join(dir, `${name}.pem`), 'utf8')
  return { key: readFileSync(join(dir, `${name}.key`), 'utf8'), cert, fp: fingerprintOf(new X509Certificate(cert).raw) }
}

const plain = { isEncryptionAvailable: () => false, encryptString: (t: string) => Buffer.from(t), decryptString: (b: Buffer) => b.toString('utf8') }
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

describe.skipIf(!hasOpenssl())('registerDevicesSync', () => {
  it('two brains on pinned HTTPS share rows both ways and a new key reaches the other brain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-mesh-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const ids = ['dev_a', 'dev_b'] as const
    const certs = { dev_a: makeCert(dir, 'a'), dev_b: makeCert(dir, 'b') }
    const nodes: Record<string, { store: Store; settings: SettingsStore; secrets: Secrets; sync: DevicesSync; url: string }> = {}
    const hosts = await Promise.all(ids.map((id) => startTestHost(id, facts(id), certs[id])))
    for (const host of hosts) cleanups.push(() => host.close())

    for (const [i, id] of ids.entries()) {
      const host = hosts[i]!
      for (const other of ids) host.passes.set(`pass-${other}`, { deviceId: other, node: true })
      const store = new Store(':memory:')
      const settings = new SettingsStore(join(dir, `${id}-settings.json`))
      const secrets = new Secrets(join(dir, `${id}-secrets`), plain)
      // Both know both (as after pairing): brains, with addresses and pinned fingerprints.
      for (const [j, other] of ids.entries()) {
        await store.upsert('device', { id: other, name: other, kind: 'desktop', platform: 'linux', roles: ['brain'], priority: j, urls: [hosts[j]!.url], fp: certs[other].fp, facts: {}, pairedAt: 1, lastSeen: 1, revoked: false })
      }
      const sync = registerDevicesSync(host, {
        store,
        pass: () => `pass-${id}`,
        bundle: { settings: { get: () => settings.get(), save: (p) => settings.save(p), onChange: (l) => settings.onChange(() => l()) }, secrets, profiles: new ProfileStore(join(dir, `${id}-profiles.json`)) },
        noteBack: () => undefined,
      })
      cleanups.push(() => {
        sync.stop()
        store.close()
      })
      nodes[id] = { store, settings, secrets, sync, url: host.url }
    }
    const a = nodes['dev_a']!
    const b = nodes['dev_b']!

    await a.store.upsert('task', { title: 'Made on A' })
    await waitFor(async () => (await b.store.list('task')).some((t) => t.title === 'Made on A'), 10_000)
    await b.store.upsert('task', { title: 'Made on B' })
    await waitFor(async () => (await a.store.list('task')).some((t) => t.title === 'Made on B'), 10_000)

    // A key and a name added on A: B sees the new bundle version on its next pull and takes it.
    a.settings.save({ userName: 'Sam', accounts: [{ id: 'k1', label: 'Key', kind: 'api', provider: 'openai', model: 'm', hasKey: true }] })
    a.secrets.set(keyNameFor('k1'), 'sk-test-mesh-key')
    a.sync.keeper.check()
    // A row change wakes the long poll, so the new version rides on the next answer.
    await a.store.upsert('task', { title: 'Nudge' })
    await waitFor(() => b.secrets.get(keyNameFor('k1')) === 'sk-test-mesh-key', 10_000)
    expect(b.settings.get().userName).toBe('Sam')
    expect(b.settings.get().accounts[0]).toMatchObject({ id: 'k1', hasKey: true })

    // Origin as the runner asks for it.
    expect(a.sync.selfOrigin()).toMatchObject({ deviceId: 'dev_a', kind: 'desktop' })
    await a.store.upsert('chat_item', { kind: 'user', text: 'hi', meta: JSON.stringify({ origin: { deviceId: 'dev_phone', name: 'Test Phone', kind: 'phone', platform: 'android', screenWidth: 390, canOpenLinks: true, canReceiveFiles: false } }) })
    const line = await a.sync.originLine('main')
    expect(line).toContain('Test Phone')
    const prompt = buildPrompt({ settings: DEFAULT_SETTINGS, now: new Date(0), platform: 'linux', memories: [], goals: [], tasks: [], latestUserText: 'hi', deviceLine: line, timeZone: 'UTC' })
    expect(prompt).toContain('THE DEVICE THE USER IS ON')
    expect(prompt).toContain('cannot receive files')
    expect(buildPrompt({ settings: DEFAULT_SETTINGS, now: new Date(0), platform: 'linux', memories: [], goals: [], tasks: [], latestUserText: 'hi', timeZone: 'UTC' })).not.toContain('THE DEVICE THE USER IS ON')
  }, 30_000)
})
