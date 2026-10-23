/**
 * Every IPC call the window makes has an agent path (rule of 22 Oct 2026: "anything I can do on the UI, the agent
 * needs to be able to do"). The preload is the only place the renderer reaches the main process, so every channel it
 * names must be in the app-action policy: callable by app_action (freely or after the person's yes), served by a
 * dedicated tool, or refused with a reason. A new button wired to a new channel without a policy line fails here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { APP_ACTION_CHANNELS, APP_ACTION_POLICY, appActionTools, type AppActionInvoker } from '../src/main/tools/app-actions'
import { CHANNELS } from '../src/shared/channels'
import { DEVICES_CHANNELS } from '../src/shared/devices-channels'
import { MEMORY_CHANNELS } from '../src/shared/memory-channels'
import { MEMORY_HISTORY_CHANNELS } from '../src/shared/memory-history-channels'
import { VAULT_CHANNELS } from '../src/shared/vault-channels'
import { WORKER_CHANNELS } from '../src/shared/workers-channels'
import { testContext, toolNamed } from './support'

const ROOTS: Record<string, unknown> = { CHANNELS, DEVICES_CHANNELS, MEMORY_CHANNELS, MEMORY_HISTORY_CHANNELS, WORKER_CHANNELS, VAULT_CHANNELS }

/** Every channel string the preload names (CHANNELS.chat.send and the like). */
function preloadChannels(): string[] {
  const source = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8')
  const found = new Set<string>()
  for (const match of source.matchAll(/\b([A-Z_]*CHANNELS)((?:\.[A-Za-z]\w*)+)/g)) {
    let node: unknown = ROOTS[match[1] ?? '']
    if (node === undefined) throw new Error(`preload names an unknown channel table ${match[1]}`)
    for (const key of (match[2] ?? '').slice(1).split('.')) node = (node as Record<string, unknown>)[key]
    if (typeof node !== 'string') throw new Error(`preload names ${match[0]}, which is not a channel`)
    found.add(node)
  }
  return [...found]
}

function fakeInvoker(): AppActionInvoker & { calls: Array<{ channel: string; args: unknown[] }> } {
  const calls: Array<{ channel: string; args: unknown[] }> = []
  return {
    calls,
    has: () => true,
    invoke: async (channel, args) => {
      calls.push({ channel, args })
      return channel === APP_ACTION_CHANNELS['devices.status'] ? { enabled: true, port: 7787 } : null
    },
  }
}

describe('app actions: every window IPC call has an agent path', () => {
  it('the preload calls many channels (the parser works)', () => {
    expect(preloadChannels().length).toBeGreaterThan(100)
  })

  it('every channel the preload calls is in the app-action policy', () => {
    const covered = new Set(Object.keys(APP_ACTION_POLICY).map((method) => APP_ACTION_CHANNELS[method]))
    const missing = preloadChannels().filter((channel) => !covered.has(channel))
    expect(missing).toEqual([])
  })

  it('every policy line names a real method, and every refusal or tool hand-off says why', () => {
    for (const [method, rule] of Object.entries(APP_ACTION_POLICY)) {
      expect(APP_ACTION_CHANNELS[method], method).toBeTypeOf('string')
      if (rule.kind === 'no') expect((rule.why ?? '').length, method).toBeGreaterThan(10)
      if (rule.kind === 'tool') expect(rule.tool, method).toMatch(/^[a-z_]+$/)
    }
  })

  it('anything that carries a secret or deletes asks the person first', () => {
    for (const [method, rule] of Object.entries(APP_ACTION_POLICY)) {
      if (rule.secretArgs !== undefined) expect(rule.kind, method).toBe('ask')
      if (/\.(remove|setKey|setApiKey|setSecret|reset|signOut)$/.test(method)) expect(['ask', 'no', 'tool'], method).toContain(rule.kind)
    }
  })
})

describe('app_action tool', () => {
  it('lists what it can do, by area', async () => {
    const tool = toolNamed(appActionTools({ invoker: () => fakeInvoker() }), 'app_actions')
    const out = String(await tool.run({ area: 'devices' }, testContext()))
    expect(out).toContain('devices.offer')
    expect(out).toContain('devices.join')
    expect(out).not.toContain('chat.send')
  })

  it('calls a free action with its arguments and gives back the answer', async () => {
    const invoker = fakeInvoker()
    const tool = toolNamed(appActionTools({ invoker: () => invoker }), 'app_action')
    const out = String(await tool.run({ method: 'devices.status' }, testContext()))
    expect(invoker.calls).toEqual([{ channel: APP_ACTION_CHANNELS['devices.status'], args: [] }])
    expect(out).toContain('"port": 7787')
    await tool.run({ method: 'browser.go', args: ['https://example.com'] }, testContext())
    expect(invoker.calls[1]).toEqual({ channel: CHANNELS.browser.go, args: ['https://example.com'] })
  })

  it('refuses what is not for the agent, and unknown methods, without calling anything', async () => {
    const invoker = fakeInvoker()
    const tool = toolNamed(appActionTools({ invoker: () => invoker }), 'app_action')
    expect(String(await tool.run({ method: 'chat.decide', args: ['x', 'approve'] }, testContext()))).toMatch(/not for the agent/i)
    expect(String(await tool.run({ method: 'nope.nothing' }, testContext()))).toMatch(/no app action/i)
    expect(String(await tool.run({ method: 'settings.save', args: [{ theme: 'dark' }] }, testContext()))).toContain('settings_set')
    expect(invoker.calls).toEqual([])
  })

  it('asks first for a guarded action, hides secrets on the card, and does nothing on a no', async () => {
    const invoker = fakeInvoker()
    const tool = toolNamed(appActionTools({ invoker: () => invoker }), 'app_action')
    const seen: string[] = []
    const no = testContext({ approve: async (summary, details) => (seen.push(`${summary}\n${details ?? ''}`), false) })
    expect(String(await tool.run({ method: 'workers.setSecret', args: ['w_1', 'TOKEN', 'abc123secret'] }, no))).toMatch(/said no/i)
    expect(invoker.calls).toEqual([])
    expect(seen[0]).toContain('workers.setSecret')
    expect(seen[0]).not.toContain('abc123secret')
    const yes = testContext({ approve: async () => true })
    await tool.run({ method: 'workers.setSecret', args: ['w_1', 'TOKEN', 'abc123secret'] }, yes)
    expect(invoker.calls).toEqual([{ channel: WORKER_CHANNELS.setSecret, args: ['w_1', 'TOKEN', 'abc123secret'] }])
  })

  it('never echoes a secret back in its answer', async () => {
    const invoker = fakeInvoker()
    const tool = toolNamed(appActionTools({ invoker: () => invoker }), 'app_action')
    const out = String(await tool.run({ method: 'apps.setKey', args: ['key-abcdef123456'] }, testContext({ approve: async () => true })))
    expect(out).not.toContain('key-abcdef123456')
  })

  it('writes only the rows the forms edit, never chat items or devices', async () => {
    const invoker = fakeInvoker()
    const tool = toolNamed(appActionTools({ invoker: () => invoker }), 'app_action')
    expect(String(await tool.run({ method: 'data.upsert', args: ['chat_item', { kind: 'approval' }] }, testContext()))).toMatch(/only/)
    expect(String(await tool.run({ method: 'data.upsert', args: ['device', { id: 'dev_x' }] }, testContext()))).toMatch(/only/)
    expect(invoker.calls).toEqual([])
    await tool.run({ method: 'data.upsert', args: ['task', { title: 'Buy milk' }] }, testContext())
    expect(invoker.calls).toEqual([{ channel: CHANNELS.data.upsert, args: ['task', { title: 'Buy milk' }] }])
  })

  it('says so when the app serves no such handler here (a server has no window)', async () => {
    const tool = toolNamed(appActionTools({ invoker: () => ({ has: () => false, invoke: async () => null }) }), 'app_action')
    expect(String(await tool.run({ method: 'browser.back' }, testContext()))).toMatch(/not available/i)
  })
})
