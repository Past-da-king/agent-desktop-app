import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { keyNameFor } from '@agent/core'

import { Store } from '../src/main/db'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { ProfileStore } from '../src/main/apps/profiles'
import { ConnectedAppsFile, LearnedStore } from '../src/main/apps/store'
import { BundleKeeper, parseBundle, pullBundle, registerBundle, type BundleSources } from '../src/main/devices/bundle'
import type { PassTable } from '../src/main/devices/types'
import { startTestHost, type TestHost } from './devices-host'

const dirs: string[] = []
const closers: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const close of closers.splice(0)) await close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const plain = {
  isEncryptionAvailable: () => false,
  encryptString: (text: string) => Buffer.from(text),
  decryptString: (bytes: Buffer) => bytes.toString('utf8'),
}

function passTable(): PassTable {
  let table: Record<string, string> = {}
  return {
    all: () => ({ ...table }),
    set: (id, hash) => {
      table[id] = hash
    },
    remove: (id) => {
      delete table[id]
    },
    replaceAll: (next) => {
      table = { ...next }
    },
  }
}

function nodeState(clock: () => number) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bundle-'))
  dirs.push(dir)
  const store = new Store(':memory:')
  closers.push(() => store.close())
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const secrets = new Secrets(join(dir, 'secrets'), plain)
  const profiles = new ProfileStore(join(dir, 'profiles.json'))
  const learned = new LearnedStore(join(dir, 'learned-apps.json'))
  const connected = new ConnectedAppsFile(join(dir, 'connected-apps.json'))
  const passes = passTable()
  const sources: BundleSources = {
    settings: { get: () => settings.get(), save: (patch) => settings.save(patch), onChange: (l) => settings.onChange(() => l()) },
    secrets,
    profiles,
    learned,
    connected,
    passes,
    projects: () => store.list('project'),
    local: store,
    now: clock,
  }
  const keeper = new BundleKeeper(sources)
  keeper.watch()
  closers.push(() => keeper.dispose())
  return { store, settings, secrets, profiles, learned, connected, passes, keeper }
}

const KEY = 'sk-test-0123456789abcdef'
const COMPOSIO = 'composio-test-key-abcdef'
const PASS_HASH = 'a'.repeat(64)

async function seeded(clock: () => number) {
  const a = nodeState(clock)
  a.settings.save({
    userName: 'Sam',
    agentName: 'Kit',
    quickAskHotkey: 'Alt+Q',
    accounts: [{ id: 'work', label: 'Work key', kind: 'api', provider: 'openai', model: 'm', hasKey: true }],
  })
  a.secrets.set(keyNameFor('work'), KEY)
  a.secrets.set('composioKey', COMPOSIO)
  a.passes.set('dev_phone', PASS_HASH)
  a.profiles.create('Side work')
  a.learned.save({ id: 'demo', name: 'Demo', startUrl: 'https://example.com', about: '', tools: [], trusted: false, updatedAt: 0 })
  a.connected.setRules('acct-1', { read: 'allow', change: 'never' })
  await a.store.upsert('project', { name: 'Garden' })
  a.keeper.check()
  return a
}

async function hostWith(a: Awaited<ReturnType<typeof seeded>>): Promise<TestHost> {
  const host = await startTestHost('dev_a')
  closers.push(() => host.close())
  const base = { kind: 'desktop', platform: 'linux', priority: 0, urls: [], fp: '', facts: {}, pairedAt: 0, lastSeen: 0, revoked: false }
  await a.store.upsert('device', { ...base, id: 'dev_b', name: 'Other brain', roles: ['brain'] })
  await a.store.upsert('device', { ...base, id: 'dev_phone', name: 'Phone', kind: 'phone', platform: 'android', roles: ['screen'] })
  host.passes.set('pass-b', { deviceId: 'dev_b', node: true })
  host.passes.set('pass-phone', { deviceId: 'dev_phone', node: false })
  closers.push(registerBundle(host, { keeper: a.keeper, devices: () => a.store.list('device') }))
  return host
}

describe('state bundle', () => {
  it('a screen gets the shared state and never a secret', async () => {
    let now = 1000
    const a = await seeded(() => now)
    const host = await hostWith(a)
    const res = await fetch(`${host.url}/v1/bundle`, { headers: { Authorization: 'Bearer pass-phone' } })
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain(KEY)
    expect(text).not.toContain(COMPOSIO)
    expect(text).not.toContain(PASS_HASH)
    const bundle = JSON.parse(text) as Record<string, unknown>
    expect(bundle['secrets']).toBeUndefined()
    expect((bundle['settings'] as Record<string, unknown>)['userName']).toBe('Sam')
    // Hotkeys belong to one machine.
    expect((bundle['settings'] as Record<string, unknown>)['quickAskHotkey']).toBeUndefined()
    expect((bundle['projects'] as Array<{ name: string }>).map((p) => p.name)).toEqual(['Garden'])
    expect((bundle['accounts'] as Array<{ id: string }>).map((p) => p.id)).toEqual(['work'])
    now++
  })

  it('a brain gets the keys and the pass table, and applying writes them into its own stores', async () => {
    let now = 5000
    const a = await seeded(() => now)
    const host = await hostWith(a)
    const b = nodeState(() => now)
    b.settings.save({ quickAskHotkey: 'Alt+W' })

    expect(await pullBundle(b.keeper, host.url, 'pass-b', fetch)).toBe(true)
    expect(b.secrets.get(keyNameFor('work'))).toBe(KEY)
    expect(b.secrets.get('composioKey')).toBe(COMPOSIO)
    expect(b.passes.all()).toEqual({ dev_phone: PASS_HASH })
    expect(b.settings.get().userName).toBe('Sam')
    expect(b.settings.get().quickAskHotkey).toBe('Alt+W')
    expect(b.settings.get().accounts[0]).toMatchObject({ id: 'work', hasKey: true })
    expect(b.profiles.all().map((p) => p.name)).toContain('Side work')
    expect(b.learned.apps().map((x) => x.id)).toEqual(['demo'])
    expect(b.connected.rulesFor('acct-1')).toEqual({ read: 'allow', change: 'never' })
    expect(b.connected.userId()).toBe(a.connected.userId())

    // The same bundle again is not newer: nothing happens, and B does not think it changed anything itself.
    expect(await pullBundle(b.keeper, host.url, 'pass-b', fetch)).toBe(false)
    expect(b.keeper.check()).toBe(false)
  })

  it('a change on one brain reaches the other, and the older one never overwrites it', async () => {
    let now = 10_000
    const a = await seeded(() => now)
    const host = await hostWith(a)
    const b = nodeState(() => now)
    await pullBundle(b.keeper, host.url, 'pass-b', fetch)

    // A key is added on A later: connected brains are told, the version moves on.
    host.connected.add('dev_b')
    const before = a.keeper.version()
    now = 20_000
    a.secrets.set('geminiKey', 'gm-test-key')
    expect(a.keeper.check()).toBe(true)
    expect(a.keeper.version()).not.toBe(before)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(host.events.filter((e) => e.name === 'devices.bundle').map((e) => e.deviceId)).toEqual(['dev_b'])
    // The event names a version only, never a secret.
    expect(JSON.stringify(host.events)).not.toContain('gm-test-key')

    expect(await pullBundle(b.keeper, host.url, 'pass-b', fetch)).toBe(true)
    expect(b.secrets.get('geminiKey')).toBe('gm-test-key')
    expect(b.settings.get().hasVoiceKey).toBe(true)

    // B's bundle is not newer than A's: A refuses it.
    const fromB = await b.keeper.build(true)
    expect(a.keeper.apply(fromB)).toBe(false)
  })

  it('an account removed on one brain takes its key away on the other', async () => {
    let now = 1
    const a = await seeded(() => now)
    const b = nodeState(() => now)
    expect(b.keeper.apply(parseBundle(JSON.parse(JSON.stringify(await a.keeper.build(true))))!)).toBe(true)
    expect(b.secrets.get(keyNameFor('work'))).toBe(KEY)
    now = 2
    a.settings.save({ accounts: [] })
    a.secrets.delete(keyNameFor('work'))
    a.keeper.check()
    expect(b.keeper.apply(parseBundle(JSON.parse(JSON.stringify(await a.keeper.build(true))))!)).toBe(true)
    expect(b.secrets.get(keyNameFor('work'))).toBeNull()
    expect(b.settings.get().accounts).toEqual([])
  })
})
