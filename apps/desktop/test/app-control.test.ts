/**
 * The app's own controls as agent tools (main/tools/app-control.ts): Settings > Devices and Settings, by tool. The
 * one short real check he asked for: two real nodes on this machine, one makes a pairing link with
 * device_pair_offer, the other joins it with device_join, and each then lists the other.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_SETTINGS, type Settings } from '@agent/core'
import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { cleanConfig } from '../src/main/devices/config'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import { appControlTools, findDevice, type AppControlDeps } from '../src/main/tools/app-control'
import { testContext, toolNamed } from './support'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

async function node(name: string): Promise<{ service: DevicesService; store: Store; base: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ctl-'))
  const store = new Store(join(dir, 'agent.db'))
  const data = new Map<string, string>()
  const service = new DevicesService({
    userData: dir,
    store,
    secrets: { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) },
    registry: new HandlerRegistry(),
    appVersion: '1.0.0',
    nodeName: () => name,
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: join(dir, 'none'),
    emitWindow: () => undefined,
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => service.stop())
  await service.start()
  let status = service.status()
  for (let attempt = 0; attempt < 5 && !status.running; attempt += 1) {
    await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    status = await service.setEnabled(true)
  }
  const base = `https://127.0.0.1:${status.port}`
  await service.setExtraUrls([base])
  return { service, store, base }
}

const tools = (deps: AppControlDeps) => appControlTools(deps)

describe('Devices by tool: offer on one node, join on the other', () => {
  it('device_pair_offer makes a link that device_join on another node takes, and both then list each other', async () => {
    const a = await node('Desk')
    const b = await node('Server')
    const offer = String(await toolNamed(tools({ devices: () => a.service }), 'device_pair_offer').run({}, testContext()))
    const link = /agent:\/\/pair\?\S+/.exec(offer)?.[0] ?? ''
    expect(link).not.toBe('')
    expect(offer).toMatch(/Short code: \S+/)

    const joined = String(await toolNamed(tools({ devices: () => b.service }), 'device_join').run({ link }, testContext()))
    expect(joined).toContain(`Joined Desk (id ${a.service.status().nodeId})`)
    expect(b.service.joinedPeers().map((peer) => peer.id)).toEqual([a.service.status().nodeId])
    expect(b.service.status().meshId ?? '').toBe(a.service.status().meshId ?? '')
    // A lists B now; B's status tool lists A as a joined brain.
    const aSees = String(await toolNamed(tools({ devices: () => a.service }), 'devices_status').run({}, testContext()))
    expect(aSees).toContain(`Server (id ${b.service.status().nodeId})`)
    // The link is one use.
    const again = String(await toolNamed(tools({ devices: () => b.service }), 'device_join').run({ link }, testContext()))
    expect(again).toMatch(/Could not join/)
  }, 30_000)

  it('device_remove takes a device out and clears its row; clear_revoked clears leftovers', async () => {
    const a = await node('Desk')
    const deps = { devices: () => a.service }
    const row = { name: 'Old phone', kind: 'phone' as const, platform: 'android' as const, roles: ['screen' as const], priority: 5, urls: [], fp: '', facts: {} as never, pairedAt: 1, lastSeen: 1 }
    await a.store.upsert('device', { id: 'dev_oldphone1', ...row, revoked: false })
    await a.store.upsert('device', { id: 'dev_gonephone', ...row, name: 'Gone phone', revoked: true })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const remove = toolNamed(tools(deps), 'device_remove')
    expect(String(await remove.run({ device: 'old phone' }, testContext()))).toContain('taken out and cleared')
    expect(String(await remove.run({ clear_revoked: true }, testContext()))).toContain('dev_gonephone')
    expect(a.service.list().map((r) => r.id)).toEqual([a.service.status().nodeId])
    expect(String(await remove.run({ device: a.service.status().nodeId }, testContext()))).toMatch(/cannot take itself out/)
  }, 30_000)

  it('device_share and devices_switch change what Settings shows', async () => {
    const a = await node('Desk')
    const deps = { devices: () => a.service }
    expect(String(await toolNamed(tools(deps), 'device_share').run({ group: 'shell', on: true }, testContext()))).toContain('may use shell')
    expect(a.service.status().shareGroups.shell).toBe(true)
    expect(String(await toolNamed(tools(deps), 'device_share').run({ group: 'nope', on: true }, testContext()))).toMatch(/Unknown group/)
    expect(String(await toolNamed(tools(deps), 'devices_switch').run({ on: false }, testContext()))).toContain('off')
    expect(a.service.status().enabled).toBe(false)
  }, 30_000)

  it('finds a device by id, id start or name, and says which when it is not sure', () => {
    const base = { kind: 'phone' as const, platform: 'android' as const, roles: ['screen' as const], priority: 0, urls: [], fp: '', facts: {} as never, pairedAt: 1, lastSeen: 1, createdAt: 1 }
    const rows = [
      { ...base, id: 'dev_aaa111', name: 'Phone', revoked: false },
      { ...base, id: 'dev_aab222', name: 'Phone', revoked: true },
      { ...base, id: 'dev_ccc333', name: 'Laptop', revoked: false },
    ]
    expect(findDevice(rows, 'laptop')).toEqual({ row: rows[2] })
    expect(findDevice(rows, 'phone')).toEqual({ row: rows[0] })
    // Two ids start so; the one still in wins. Two devices still in with one name: it asks for the id.
    expect(findDevice(rows, 'dev_aa')).toEqual({ row: rows[0] })
    expect('error' in findDevice([...rows, { ...base, id: 'dev_ddd444', name: 'Phone', revoked: false }], 'phone')).toBe(true)
    expect('error' in findDevice(rows, 'tablet')).toBe(true)
  })

  it('keeps joined peers in the config and drops bad ones', () => {
    const config = cleanConfig({ peers: [{ id: 'dev_good1', name: 'S', urls: ['https://x.example:7787', 'http://plain'], fp: 'ab' }, { id: 'bad', fp: 'x' }, { id: 'dev_nofp' }] })
    expect(config.peers).toEqual([{ id: 'dev_good1', name: 'S', urls: ['https://x.example:7787'], fp: 'ab' }])
  })
})

describe('settings by tool', () => {
  function settingsStore(): { get(): Settings; save(patch: Partial<Settings>): Settings } {
    let current: Settings = { ...DEFAULT_SETTINGS }
    return { get: () => current, save: (patch) => (current = { ...current, ...patch }) }
  }

  it('reads settings with how each may be changed, and never shows a secret', async () => {
    const out = String(await toolNamed(tools({ settings: settingsStore() }), 'settings_get').run({}, testContext()))
    expect(out).toMatch(/theme \[free\]/)
    expect(out).toMatch(/shell \[needs his yes\]/)
    expect(out).not.toMatch(/apiKey/)
  })

  it('changes a plain setting at once, asks first for a guarded one, and refuses secrets and read-only state', async () => {
    const settings = settingsStore()
    const set = toolNamed(tools({ settings }), 'settings_set')
    const asked: string[] = []
    const out = String(
      await set.run(
        { values: { theme: 'dark', shell: 'always', apiKey: 'sk-test', hasKey: true } },
        testContext({ approve: async (summary, details) => (asked.push(`${summary} ${details ?? ''}`), false) }),
      ),
    )
    expect(settings.get().theme).toBe('dark')
    expect(settings.get().shell).toBe(DEFAULT_SETTINGS.shell)
    expect(asked[0]).toContain('shell')
    expect(out).toMatch(/apiKey \(a secret/)
    expect(out).toMatch(/hasKey \(read-only/)
    expect(out).toMatch(/shell \(the person said no\)/)
    await set.run({ values: { shell: 'always' } }, testContext({ approve: async () => true }))
    expect(settings.get().shell).toBe('always')
  })
})
