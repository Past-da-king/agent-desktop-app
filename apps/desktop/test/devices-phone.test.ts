/**
 * The phone app (workstream D) against the real node, with the phone's exact frames: pairing with the short code as
 * the phone sends it (no dash), hello with tools at the top level, every RPC call its native screens make, and the
 * events it listens for.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Attachment, Decision, RunState } from '@agent/core'

import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { HandlerRegistry, recordHandlers } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import type { MessageOrigin } from '../src/main/devices/types'
import { registerIpc, type ChatRunner } from '../src/main/ipc'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { connectRpc, pinnedRequest } from './devices-client'

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
}

// What the phone app sends (D's DeviceFacts and its tool catalogue).
const PHONE = { name: 'Pixel 8', kind: 'phone', platform: 'android', appVersion: '0.4.0', screen: { width: 412, height: 915 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }
const PHONE_TOOLS = [
  { name: 'notifications_read', description: 'Read the notifications on the phone', params: { type: 'object', properties: {} }, group: 'notifications', readOnly: true },
  { name: 'open_url', description: 'Open a link on the phone', params: { type: 'object', properties: { url: { type: 'string' } } }, group: 'phone', readOnly: false },
]

let dir = ''
let store: Store
let service: DevicesService
let dispose: (() => void) | null = null
let calls: string[]
let sends: Array<{ text: string; chat?: string; origin?: MessageOrigin }>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-phone-'))
  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-node' })
  const secrets = new Secrets(join(dir, 'secrets'), storage)
  const account = new AccountService(store, settings, secrets, { autoStart: false })
  calls = []
  sends = []
  const chat: ChatRunner = {
    send: async (text: string, _a?: Attachment[], target?: string, origin?: MessageOrigin) => void sends.push({ text, chat: target, origin }),
    stop: (target?: string) => void calls.push(`stop:${target ?? ''}`),
    state: (): RunState => ({ running: false, waiting: [] }),
    answer: async (id: string, answer: string) => void calls.push(`answer:${id}:${answer}`),
    decide: async (id: string, decision: Decision) => void calls.push(`decide:${id}:${decision}`),
    tap: async () => undefined,
  }
  const registry = new HandlerRegistry()
  const ipcMain = recordHandlers({ handle: () => undefined }, registry)
  mkdirSync(join(dir, 'renderer'), { recursive: true })
  service = new DevicesService({
    userData: dir,
    store,
    secrets,
    registry,
    appVersion: '9.9.9',
    nodeName: () => 'test-node',
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: join(dir, 'renderer'),
    emitWindow: () => undefined,
  })
  dispose = registerIpc({
    store,
    settings,
    secrets,
    account,
    chat,
    ipcMain,
    windows: { minimize: () => undefined, toggleMaximize: () => undefined, close: () => undefined, isMaximized: () => false },
    broadcast: (channel, payload) => service.broadcast(channel, payload),
    routines: { runNow: async (id) => void calls.push(`routine:${id}`) },
    helpers: {
      delegate: async () => '',
      steer: async () => '',
      push: async () => '',
      status: async () => '',
      stop: async (id) => (calls.push(`helper:${id}`), true),
      stopAll: async () => 0,
    },
    pasted: { save: async (name, mime) => ({ path: join(dir, 'attachments', name), name, mime }), clipboardFiles: async () => [] },
  })
  service.registerIpc(ipcMain)
  await service.start()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    if ((await service.setEnabled(true)).running) break
  }
})

afterEach(async () => {
  await service.stop()
  dispose?.()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the phone app against the node', () => {
  it('pairs with the bare short code, says hello with tools and uses every call and event it needs', async () => {
    const status = service.status()
    const base = `https://127.0.0.1:${status.port}`
    const fp = status.fp
    // (1) The phone sends the code as typed: no dash; any case works too.
    const bare = service.offer().shortCode.replace('-', '')
    expect(bare).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
    const pairReply = await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code: bare, device: PHONE, wantRoles: ['screen'] } })
    expect(pairReply.status).toBe(200)
    const lower = service.offer().shortCode.toLowerCase().replace('-', '')
    expect((await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code: lower, device: PHONE } })).status).toBe(200)
    const { deviceId, pass } = pairReply.json() as { deviceId: string; pass: string }

    // What B registers through addRpc: answered by name, though not on RPC_ALLOWED.
    const acks: unknown[][] = []
    service.host().addRpc('device.ack', async (id, args) => (acks.push([id, ...args]), true))
    const results: unknown[] = []
    service.host().onDeviceResult((id, cmd, result) => void results.push([id, cmd, result]))

    // (2) hello: { type, device, tools } with tools at the top level.
    const phone = await connectRpc(base, fp, pass, PHONE, PHONE_TOOLS)
    await phone.call('chat.state', '')
    const row = await store.get('device', deviceId)
    expect(row?.tools?.map((t) => t.name)).toEqual(['notifications_read', 'open_url'])
    expect(row?.tools?.[1]).toMatchObject({ group: 'phone', readOnly: false })

    // (3) The calls the native screens make.
    const made: Record<string, string> = {}
    for (const [entity, row] of [
      ['chat_item', { kind: 'agent', text: 'hi', meta: '{}' }],
      ['memory', { title: 'Fact', body: 'b', kind: 'fact', topics: '', pinned: false, source: 'user', updatedAt: 0 }],
      ['goal', { title: 'Goal', why: '', status: 'open' }],
      ['task', { title: 'Milk', notes: '', status: 'todo', owner: 'user' }],
      ['trigger', { name: 'Brief', kind: 'daily', spec: '07:30', prompt: 'Brief me', enabled: true }],
    ] as const) {
      const saved = (await phone.call('data.upsert', entity, row)) as { id: string }
      made[entity] = saved.id
      expect(((await phone.call('data.list', entity)) as Array<{ id: string }>).some((r) => r.id === saved.id)).toBe(true)
    }
    await phone.call('data.remove', 'goal', made['goal'])
    expect(await phone.call('data.list', 'goal')).toEqual([])
    expect(((await phone.call('data.list', 'project')) as unknown[]).length).toBe(0)
    await expect(phone.call('data.upsert', 'device', { id: deviceId, roles: ['brain'] })).rejects.toThrow('not available')
    await expect(phone.call('data.remove', 'device', deviceId)).rejects.toThrow('not available')

    await phone.call('chat.send', 'hello from the phone')
    await phone.call('chat.send', 'with nothing attached', [])
    expect(sends.map((s) => [s.text, s.origin?.deviceId, s.origin?.name])).toEqual([
      ['hello from the phone', deviceId, 'Pixel 8'],
      ['with nothing attached', deviceId, 'Pixel 8'],
    ])
    await phone.call('chat.answer', 'q1', 'Yes')
    await phone.call('chat.decide', 'a1', 'approve')
    await phone.call('chat.stop', '')
    expect(await phone.call('chat.state', '')).toEqual({ running: false, waiting: [] })
    await phone.call('routines.runNow', made['trigger'])
    expect(await phone.call('helpers.stop', 'h1')).toBe(true)
    expect(calls).toEqual(['answer:q1:Yes', 'decide:a1:approve', 'stop:', `routine:${made['trigger']}`, 'helper:h1'])
    const pasted = (await phone.call('files.savePasted', 'photo.jpg', 'image/jpeg', { $b64: Buffer.from('JPEG').toString('base64') })) as { path: string }
    expect(pasted.path).toBe(join(dir, 'attachments', 'photo.jpg'))
    expect(await phone.call('device.ack', 'cmd_1', true, 'Opened')).toBe(true)
    expect(acks).toEqual([[deviceId, 'cmd_1', true, 'Opened']])
    expect(await phone.call('device.result', 'cmd_2', true, { text: 'two new' })).toBe(true)
    expect(results).toEqual([[deviceId, 'cmd_2', { ok: true, value: { text: 'two new' } }]])

    // (4) The exact event names the phone listens for.
    const dataEvent = phone.waitForEvent('agent:evt:data.changed')
    await store.upsert('task', { title: 'From the computer' })
    expect(((await dataEvent) as { entity: string }).entity).toBe('task')
    const chatEvent = phone.waitForEvent('agent:evt:chat.event')
    service.broadcast('agent:evt:chat.event', { type: 'chat_changed' })
    expect(await chatEvent).toEqual({ type: 'chat_changed' })
    const devicesEvent = phone.waitForEvent('agent:evt:devices.changed')
    await service.setShareGroup('shell', false)
    expect(await devicesEvent).toBeNull()
    const command = phone.waitForEvent('device.command')
    service.host().emit(deviceId, 'device.command', { kind: 'tool', id: 'cmd_3', tool: 'notifications_read', args: {}, chatId: 'main', deadlineMs: 120000 })
    expect(await command).toEqual({ kind: 'tool', id: 'cmd_3', tool: 'notifications_read', args: {}, chatId: 'main', deadlineMs: 120000 })
    // Events about this computer's own window never go to the phone.
    service.broadcast('agent:evt:window.maximized', true)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(phone.events.some((e) => e.name === 'agent:evt:window.maximized')).toBe(false)
    phone.close()
  })
})
