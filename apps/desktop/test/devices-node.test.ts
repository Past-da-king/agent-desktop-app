/**
 * The node for real: the devices service on 127.0.0.1 with its own certificate, the app's real IPC handlers
 * (registerIpc over a real Store) recorded for the wire, and a scripted device that pairs with the fingerprint
 * pinned, calls RPC methods, hears an event and fetches files.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Attachment, RunState } from '@agent/core'

import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { HandlerRegistry, recordHandlers } from '../src/main/devices/registry'
import { parsePairUri } from '../src/main/devices/pairing'
import { DevicesService } from '../src/main/devices/service'
import type { MessageOrigin } from '../src/main/devices/types'
import { registerIpc, type ChatRunner } from '../src/main/ipc'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { EVENTS } from '../src/shared/channels'
import { connectRpc, pinnedRequest } from './devices-client'

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
}

const phone = { name: 'Test phone', kind: 'phone', platform: 'android', appVersion: '1.0', screen: { width: 412, height: 915 }, canOpenLinks: true, canReceiveFiles: false, fingerprint: '', urls: [] }

let dir = ''
let store: Store
let service: DevicesService
let sends: Array<{ text: string; chat?: string; origin?: MessageOrigin }>
let windowEvents: string[]
let dispose: (() => void) | null = null
let base = ''
let pastedBytes: Uint8Array | null = null
let fp = ''

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-node-'))
  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-node' })
  const secrets = new Secrets(join(dir, 'secrets'), storage)
  const account = new AccountService(store, settings, secrets, { autoStart: false })
  sends = []
  windowEvents = []
  const chat: ChatRunner = {
    send: async (text: string, _attachments?: Attachment[], target?: string, origin?: MessageOrigin) => {
      sends.push({ text, chat: target, origin })
    },
    stop: () => undefined,
    state: (): RunState => ({ running: false, waiting: [] }),
    answer: async () => undefined,
    decide: async () => undefined,
    tap: async () => undefined,
  }
  const registry = new HandlerRegistry()
  const handlers = new Map<string, unknown>()
  const ipcMain = recordHandlers({ handle: (channel: string, listener: unknown) => void handlers.set(channel, listener) }, registry)
  const renderer = join(dir, 'renderer')
  mkdirSync(join(renderer, 'assets'), { recursive: true })
  writeFileSync(join(renderer, 'index.html'), '<!doctype html><html><head><title>Agent</title></head><body></body></html>')
  writeFileSync(join(renderer, 'assets', 'app.js'), 'console.log(1)')
  // The service is made first so the broadcast below can reach it.
  service = new DevicesService({
    userData: dir,
    store,
    secrets,
    registry,
    appVersion: '9.9.9',
    nodeName: () => settings.get().deviceName,
    platform: 'linux',
    ready: () => true,
    busy: () => false,
    rendererDir: renderer,
    emitWindow: (channel) => void windowEvents.push(channel),
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
    pasted: {
      save: async (name, mime, bytes) => {
        pastedBytes = bytes
        return { path: join(dir, 'attachments', name), name, mime }
      },
      clipboardFiles: async () => [],
    },
  })
  service.registerIpc(ipcMain)
  await service.start()
  // A free high port; the default 7787 may be taken on a developer machine.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await service.configure({ listen: '127.0.0.1', port: 20000 + Math.floor(Math.random() * 30000) })
    const status = await service.setEnabled(true)
    if (status.running) break
  }
  const status = service.status()
  expect(status.running).toBe(true)
  base = `https://127.0.0.1:${status.port}`
  fp = status.fp
})

afterEach(async () => {
  await service.stop()
  dispose?.()
  dispose = null
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function pair(roles: string[] = ['screen']): Promise<{ deviceId: string; pass: string }> {
  const offer = service.offer()
  const reply = await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code: offer.shortCode, device: phone, wantRoles: roles } })
  expect(reply.status).toBe(200)
  return reply.json() as { deviceId: string; pass: string }
}

describe('the desktop node', () => {
  it('pairs a device over pinned TLS and refuses the wrong certificate', async () => {
    const health = await pinnedRequest(`${base}/v1/health`, fp)
    expect(health.status).toBe(200)
    expect(health.json()).toMatchObject({ id: service.identity.nodeId, name: 'test-node', version: '9.9.9', ready: true, busy: false, meshId: service.identity.meshId })
    await expect(pinnedRequest(`${base}/v1/health`, 'A'.repeat(43))).rejects.toThrow(/pinned/)

    const offer = service.offer()
    const parts = parsePairUri(offer.uri)
    expect(parts?.fp).toBe(fp)
    expect(parts?.meshId).toBe(service.identity.meshId)
    expect(offer.qr.length).toBeGreaterThan(20)
    expect(offer.shortCode).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)

    const wrong = await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code: 'AAAA-AAAA', device: phone } })
    expect(wrong.status).toBe(403)
    const ok = await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code: parts?.secret, device: phone } })
    expect(ok.status).toBe(200)
    const answer = ok.json() as { deviceId: string; pass: string; meshId: string; node: { id: string }; brains: Array<{ id: string; fp: string }> }
    expect(answer.meshId).toBe(service.identity.meshId)
    expect(answer.node.id).toBe(service.identity.nodeId)
    expect(answer.brains.map((b) => b.id)).toEqual([service.identity.nodeId])
    expect(answer.brains[0]?.fp).toBe(fp)
    const again = await pinnedRequest(`${base}/v1/pair`, fp, { method: 'POST', body: { code: parts?.secret, device: phone } })
    expect(again.status).toBe(410)

    const row = await store.get('device', answer.deviceId)
    expect(row).toMatchObject({ name: 'Test phone', kind: 'phone', roles: ['screen'], revoked: false })
    expect(JSON.stringify(await store.list('device'))).not.toContain(answer.pass)

    expect((await pinnedRequest(`${base}/v1/devices`, fp)).status).toBe(401)
    const devices = await pinnedRequest(`${base}/v1/devices`, fp, { headers: { Authorization: `Bearer ${answer.pass}` } })
    expect(devices.status).toBe(200)
    const listed = devices.json() as { devices: Array<{ id: string }>; answering: string }
    expect(listed.devices.map((d) => d.id)).toEqual([service.identity.nodeId, answer.deviceId])
    expect(listed.answering).toBe(service.identity.nodeId)
  })

  it('runs the app contract over the WebSocket, records the origin and passes events on', async () => {
    const device = await pair()
    await expect(connectRpc(base, fp, 'not-a-pass', phone)).rejects.toThrow(/401/)
    const client = await connectRpc(base, fp, device.pass, phone)

    const settings = (await client.call('settings.get')) as { deviceName: string }
    expect(settings.deviceName).toBe('test-node')
    await expect(client.call('settings.setApiKey', 'sk-test')).rejects.toThrow('not available on this device')
    await expect(client.call('window.close')).rejects.toThrow('not available on this device')
    await expect(client.call('data.upsert', 'device', { id: device.deviceId, roles: ['brain'] })).rejects.toThrow('not available')

    const event = client.waitForEvent(EVENTS.data)
    const task = (await client.call('data.upsert', 'task', { title: 'Buy milk' })) as { id: string; title: string }
    expect(task.title).toBe('Buy milk')
    const change = (await event) as { entity: string; row: { id: string } }
    expect(change.entity).toBe('task')
    expect(change.row.id).toBe(task.id)
    expect(((await client.call('data.list', 'task')) as unknown[]).length).toBe(1)

    await client.call('chat.send', 'hello from the phone', [], '')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.text).toBe('hello from the phone')
    expect(sends[0]?.origin).toEqual({ deviceId: device.deviceId, name: 'Test phone', kind: 'phone', platform: 'android', screenWidth: 412, canOpenLinks: true, canReceiveFiles: false })
    expect(service.host().isConnected(device.deviceId)).toBe(true)
    expect(service.host().factsOf(device.deviceId)?.screen.width).toBe(412)

    // A method another part plugs in answers by name, and a device command reaches only that device.
    service.host().addRpc('test.echo', async (id, args) => ({ id, args }))
    expect(await client.call('test.echo', 1)).toEqual({ id: device.deviceId, args: [1] })
    const command = client.waitForEvent('device.command')
    service.host().emit(device.deviceId, 'device.command', { id: 'cmd_1', kind: 'notify', title: 'Hi' })
    expect(await command).toEqual({ id: 'cmd_1', kind: 'notify', title: 'Hi' })

    // Bytes travel both ways (a pasted screenshot from the phone).
    const saved = (await client.call('files.savePasted', 'shot.png', 'image/png', { $b64: Buffer.from('PNGDATA').toString('base64') })) as { path: string }
    expect(saved.path).toBe(join(dir, 'attachments', 'shot.png'))
    expect(pastedBytes instanceof Uint8Array).toBe(true)
    expect(Buffer.from(pastedBytes ?? new Uint8Array()).toString()).toBe('PNGDATA')
    client.close()
  })

  it('serves files only from chats, attachments and project folders, with ranges', async () => {
    const device = await pair()
    const auth = { Authorization: `Bearer ${device.pass}` }
    mkdirSync(join(dir, 'attachments'), { recursive: true })
    const attached = join(dir, 'attachments', 'note.txt')
    writeFileSync(attached, '0123456789')
    const named = join(dir, 'elsewhere', 'chart.png')
    mkdirSync(join(dir, 'elsewhere'), { recursive: true })
    writeFileSync(named, 'PNG')
    const secret = join(dir, 'secrets-file.txt')
    writeFileSync(secret, 'do not share')
    const project = join(dir, 'proj')
    mkdirSync(project)
    writeFileSync(join(project, 'readme.md'), '# hi')
    await store.upsert('project', { name: 'P', path: project })

    const get = (path: string, headers: Record<string, string> = {}) => pinnedRequest(`${base}/v1/file?path=${encodeURIComponent(path)}`, fp, { headers: { ...auth, ...headers } })
    const whole = await get(attached)
    expect(whole.status).toBe(200)
    expect(whole.body.toString()).toBe('0123456789')
    expect(whole.headers['content-type']).toContain('text/plain')
    const part = await get(attached, { Range: 'bytes=2-4' })
    expect(part.status).toBe(206)
    expect(part.body.toString()).toBe('234')
    expect((await get(secret)).status).toBe(404)
    expect((await get(join(dir, 'attachments', '..', 'secrets-file.txt'))).status).toBe(404)
    expect((await get(named)).status).toBe(404)
    await store.upsert('chat_item', { kind: 'agent', text: `Here is the chart: ${named}`, meta: '{}' })
    const now = await get(named)
    expect(now.status).toBe(200)
    expect(now.headers['content-type']).toBe('image/png')
    expect((await get(join(project, 'readme.md'))).status).toBe(200)
    expect((await pinnedRequest(`${base}/v1/file?path=${encodeURIComponent(attached)}`, fp)).status).toBe(401)
  })

  it('serves the web UI behind the pass cookie, tagged as remote', async () => {
    const device = await pair()
    const locked = await pinnedRequest(`${base}/app/`, fp)
    expect(locked.status).toBe(401)
    expect(locked.body.toString()).toContain('not linked yet')
    const login = await pinnedRequest(`${base}/app/?k=${encodeURIComponent(device.pass)}`, fp)
    expect(login.status).toBe(302)
    expect(login.headers['location']).toBe('/app/')
    const cookie = String(login.headers['set-cookie'])
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    const page = await pinnedRequest(`${base}/app/`, fp, { headers: { Cookie: `agent_pass=${device.pass}` } })
    expect(page.status).toBe(200)
    expect(page.body.toString()).toContain('<meta name="agent-remote" content="1" />')
    const asset = await pinnedRequest(`${base}/app/assets/app.js`, fp, { headers: { Cookie: `agent_pass=${device.pass}` } })
    expect(asset.status).toBe(200)
    expect(asset.headers['content-type']).toContain('javascript')
    const escape = await pinnedRequest(`${base}/app/..%2F..%2Fsecrets%2FdevicePasses.secret`, fp, { headers: { Cookie: `agent_pass=${device.pass}` } })
    expect(escape.status).toBe(404)
    expect((await pinnedRequest(`${base}/`, fp)).headers['location']).toBe('/app/')
  })

  it('revokes a device: its pass stops working and its connection closes', async () => {
    const screen = await pair()
    const brain = await pair(['brain'])
    const client = await connectRpc(base, fp, screen.pass, phone)
    await client.call('settings.get')
    // Only another agent (a node) may revoke over the wire.
    const refused = await pinnedRequest(`${base}/v1/devices/${brain.deviceId}/revoke`, fp, { method: 'POST', headers: { Authorization: `Bearer ${screen.pass}` } })
    expect(refused.status).toBe(403)
    const revoked = await pinnedRequest(`${base}/v1/devices/${screen.deviceId}/revoke`, fp, { method: 'POST', headers: { Authorization: `Bearer ${brain.pass}` } })
    expect(revoked.status).toBe(200)
    expect(await client.closed).toBe(4003)
    expect((await pinnedRequest(`${base}/v1/devices`, fp, { headers: { Authorization: `Bearer ${screen.pass}` } })).status).toBe(401)
    expect((await store.get('device', screen.deviceId))?.revoked).toBe(true)
    expect(windowEvents.length).toBeGreaterThan(0)
  })

  it('keeps the brain order and roles the person sets', async () => {
    const brain = await pair(['brain'])
    const self = service.identity.nodeId
    expect(service.list().filter((d) => d.roles.includes('brain')).map((d) => d.id)).toEqual([self, brain.deviceId])
    await service.move(brain.deviceId, 'up')
    expect(service.list().filter((d) => d.roles.includes('brain')).map((d) => d.id)).toEqual([brain.deviceId, self])
    await service.setRoles(brain.deviceId, ['screen'])
    expect(service.list().find((d) => d.id === brain.deviceId)?.roles).toEqual(['screen'])
    await expect(service.setRoles(self, ['screen'])).rejects.toThrow()
    await expect(service.revoke(self)).rejects.toThrow()
  })
})
