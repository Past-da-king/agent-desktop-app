import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { DEFAULT_SETTINGS, type JsonObject } from '@agent/core'
import { Store } from '../src/main/db'
import { PrGate } from '../src/main/runtime/pr-gate'
import { reviewableCall } from '../src/main/runtime/pr-gate-detect'
import {
  prepareRemoteGrant,
  remoteArguments,
  receiveRemoteGrant,
  consumeRemoteGrant,
  remoteCaller,
} from '../src/main/runtime/pr-gate-remote'
import { BundleKeeper, parseBundle } from '../src/main/devices/bundle'
import { testContext } from './support'

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const p of folders.splice(0)) rmSync(p, { recursive: true, force: true })
})
function folder(home = false) {
  const p = mkdtempSync(join(home ? homedir() : tmpdir(), '.pr-gate-round4-'))
  folders.push(p)
  return p
}
function envelope(key: string) {
  const ctx = testContext({ owner: 'helper:origin' })
  const args = { command: 'gh pr ready 7' }
  prepareRemoteGrant(ctx, 'shell_run', args, key)
  return remoteArguments(ctx, 'shell_run', args)
}
it('m1 persists used grants across a real database reopen and a fresh module instance', async () => {
  const path = join(folder(), 'gate.sqlite'),
    key = 'a'.repeat(64)
  const input = envelope(key)
  const store = new Store(path)
  const gate = new PrGate(
    store,
    () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true }),
    Date.now,
    () => key,
  )
  const received = receiveRemoteGrant(
    testContext({ owner: 'device' }),
    'shell_run',
    input,
  )
  expect(
    await gate.acceptRemote('shell_run', received.args, received.context),
  ).toBe(true)
  store.close()
  // Reset the module cache too: an in-memory consumed-id Map cannot satisfy this test.
  vi.resetModules()
  const fresh = await import('../src/main/runtime/pr-gate')
  const remote = await import('../src/main/runtime/pr-gate-remote')
  const reopened = new Store(path)
  try {
    const restarted = new fresh.PrGate(
      reopened,
      () => ({ ...DEFAULT_SETTINGS, prGateEnabled: true }),
      Date.now,
      () => key,
    )
    const replay = remote.receiveRemoteGrant(
      testContext({ owner: 'device' }),
      'shell_run',
      input,
    )
    expect(
      await restarted.acceptRemote('shell_run', replay.args, replay.context),
    ).toBe(false)
  } finally {
    reopened.close()
  }
})
it.each(['unsigned', 'tampered', 'wrong-key'])(
  'm5 refuses %s grants without trusting their caller',
  (mode) => {
    const key = 'b'.repeat(64),
      input = envelope(key)
    const grant = input['_agentPrGateGrant'] as JsonObject
    if (mode === 'unsigned') delete grant['signature']
    if (mode === 'tampered') grant['owner'] = 'helper:forged'
    const received = receiveRemoteGrant(
      testContext({ owner: 'device' }),
      'shell_run',
      input,
    )
    expect(
      consumeRemoteGrant(
        received.context,
        'shell_run',
        received.args,
        mode === 'wrong-key' ? 'c'.repeat(64) : key,
      ),
    ).toBe(false)
    expect(remoteCaller(received.context).owner).toBe('device')
  },
)
it('m5 private bundle sync carries the signing key to brains and never screens', async () => {
  function peer() {
    const map = new Map<string, string>(),
      store = new Store(':memory:')
    const secrets = {
      get: (name: string) => map.get(name) ?? null,
      set: (name: string, value: string) => {
        map.set(name, value)
      },
      delete: (name: string) => {
        map.delete(name)
      },
    }
    const settings = { ...DEFAULT_SETTINGS }
    const keeper = new BundleKeeper({
      settings: {
        get: () => settings,
        save: (patch) => Object.assign(settings, patch),
      },
      secrets,
      local: store,
    })
    return { store, secrets, keeper }
  }
  const a = peer(),
    b = peer()
  try {
    const privateBundle = await a.keeper.build(true),
      publicBundle = await a.keeper.build(false)
    expect(privateBundle.secrets?.prGateTransportKey).toMatch(/^[a-f0-9]{64}$/)
    expect(publicBundle.secrets).toBeUndefined()
    const decoded = parseBundle(privateBundle)!
    expect(b.keeper.apply(decoded, true)).toBe(true)
    expect(b.secrets.get('prGateTransportKey')).toBe(
      a.secrets.get('prGateTransportKey'),
    )
  } finally {
    a.store.close()
    b.store.close()
  }
})
it.each(['tilde', 'pushd'])(
  'm4 inspects scripts after %s changes the execution folder',
  (mode) => {
    const dir = folder(mode === 'tilde')
    writeFileSync(join(dir, 'gate.sh'), 'gh pr ready 7')
    const command =
      mode === 'tilde'
        ? 'cd ~/' + basename(dir) + ' && bash gate.sh'
        : 'pushd ' + dir + ' && bash gate.sh'
    expect(reviewableCall('shell_run', { command, cwd: tmpdir() })).toBe(true)
  },
)
it('m4 deduplicates varying commands for the same unreadable script', async () => {
  const store = new Store(':memory:')
  try {
    const gate = new PrGate(store, () => ({
        ...DEFAULT_SETTINGS,
        prGateEnabled: true,
      })),
      ctx = testContext()
    const cwd = folder()
    for (let i = 0; i < 20; i++)
      await gate.check(
        'shell_run',
        { command: 'bash missing.sh --seed=' + i, cwd },
        ctx,
      )
    const rows = await store.listWhere('chat_item', {
      chat: 'pr-gate-audit',
      kind: 'pr_gate',
    })
    expect(
      rows.filter((r) => r.text === 'unreadable local script (not gated)'),
    ).toHaveLength(1)
  } finally {
    store.close()
  }
})
it('m4 script-note retention cannot evict a decision receipt', async () => {
  const store = new Store(':memory:')
  try {
    const gate = new PrGate(store, () => ({
        ...DEFAULT_SETTINGS,
        prGateEnabled: true,
      })),
      ctx = testContext()
    const held = await gate.check(
      'shell_run',
      { command: 'gh pr ready 7' },
      ctx,
    )
    const id = held!.match(/Gate id: ([a-f0-9-]+)/)![1]!
    for (let i = 0; i < 501; i++)
      await store.upsert('chat_item', {
        kind: 'pr_gate',
        text: 'unreadable local script (not gated)',
        meta: JSON.stringify({ chat: 'pr-gate-audit', at: Date.now() }),
      })
    await gate.check('shell_run', { command: 'gh pr ready 8' }, ctx)
    const rows = await store.listWhere('chat_item', {
      chat: 'pr-gate-audit',
      kind: 'pr_gate',
    })
    expect(rows.some((r) => JSON.parse(r.meta).gateId === id)).toBe(true)
    expect(
      rows.filter((r) => r.text === 'unreadable local script (not gated)'),
    ).toHaveLength(100)
  } finally {
    store.close()
  }
}, 20000)
it('n1 keeps pre-existing device method formatting', () => {
  const hub = readFileSync(
    new URL('../src/main/devices/device-tools.ts', import.meta.url),
    'utf8',
  )
  expect(hub).toContain(
    'async resolve(ref: string, tool: string, chat: string): Promise<{ row: DeviceRow } | { error: string }> {',
  )
})
it('n4 keeps the host header and sharing constants in their target formatting', () => {
  const host = readFileSync(
    new URL('../src/main/devices/device-tool-host.ts', import.meta.url),
    'utf8',
  )
  expect(host).toContain(
    "export const SHARE_GROUPS: readonly ShareGroup[] = ['browser', 'files', 'notifications', 'approval', 'shell']",
  )
})
it('n2 identifies the actual historical output cap', () => {
  const docs = readFileSync(
    new URL('../../../docs/pr-gate.md', import.meta.url),
    'utf8',
  )
  expect(docs).toContain('former 2,000,000-character cap')
})
it('n3 documents direct output sinks, including their truncation notices', () => {
  const docs = readFileSync(
    new URL('../../../docs/pr-gate.md', import.meta.url),
    'utf8',
  )
  expect(docs).toContain(
    'shared shell and code output sinks also retain head and tail',
  )
  expect(docs).toContain('own truncation notice before the MCP limit applies')
})
