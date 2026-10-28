import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

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
import { registerVoiceIpc } from '../src/main/voice/ipc'
import { VoiceService } from '../src/main/voice/service'
import { EVENTS } from '../src/shared/channels'
import { cardsDelta, parsePrefs, phoneKeepsChatRow, rememberCards, shapeChange, trimHelperRow } from '../src/shared/device-feed'
import { deflateMessage, inflateMessage, offersDeflate } from '../src/main/devices/ws'
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
let ipcRef: ReturnType<typeof recordHandlers>
let settingsRef: SettingsStore
let secretsRef: Secrets
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
  ipcRef = ipcMain
  settingsRef = settings
  secretsRef = secrets
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


const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function link(options: { deflate?: boolean } = {}): ReturnType<typeof connectRpc> {
  const status = service.status()
  const base = `https://127.0.0.1:${status.port}`
  const pair = await pinnedRequest(`${base}/v1/pair`, status.fp, { method: 'POST', body: { code: service.offer().shortCode.replace('-', ''), device: PHONE, wantRoles: ['screen'] } })
  const { pass } = pair.json() as { deviceId: string; pass: string }
  return connectRpc(base, status.fp, pass, PHONE, PHONE_TOOLS, options)
}

/** 300 main-chat messages, helper steps (main chat but a helper's), a project chat, an old open question. */
async function seedChat(): Promise<{ question: string }> {
  // One transaction: 450 single writes each wait for the disk, which takes seconds on a Linux or WSL
  // filesystem and made these tests time out there (they passed on Windows).
  return store.batch(() => seedRows())
}

async function seedRows(): Promise<{ question: string }> {
  const t0 = Date.now() - 400_000
  for (let i = 0; i < 300; i += 1) await store.upsert('chat_item', { kind: i % 2 === 0 ? 'user' : 'agent', text: `message ${i}`, meta: '{}', createdAt: t0 + i * 1000 })
  for (let i = 0; i < 100; i += 1) await store.upsert('chat_item', { kind: 'activity', text: `step ${i}`, meta: JSON.stringify({ helper: 'h1', run: { stdout: 's'.repeat(5_000) } }), createdAt: t0 + i * 1000 + 1 })
  for (let i = 0; i < 50; i += 1) await store.upsert('chat_item', { kind: 'agent', text: `project line ${i}`, meta: JSON.stringify({ chat: 'proj-a' }), createdAt: t0 + i * 1000 + 2 })
  const q = await store.upsert('chat_item', { kind: 'question', text: 'old question', meta: JSON.stringify({ chat: 'proj-a' }), createdAt: t0 - 1000 })
  await store.upsert('memory', { title: 'Tea', body: 'likes rooibos', project: '' } as never)
  return { question: q.id }
}

describe('device-feed rules', () => {
  it('a v2 phone keeps main-chat messages and cards of any chat, never a helper step or a project line', () => {
    expect(phoneKeepsChatRow({ kind: 'agent', meta: '{}' })).toBe(true)
    expect(phoneKeepsChatRow({ kind: 'question', meta: JSON.stringify({ chat: 'p' }) })).toBe(true)
    expect(phoneKeepsChatRow({ kind: 'activity', meta: JSON.stringify({ helper: 'h' }) })).toBe(false)
    expect(phoneKeepsChatRow({ kind: 'agent', meta: JSON.stringify({ chat: 'p' }) })).toBe(false)
    const v2 = parsePrefs({ v: 2 })
    expect(shapeChange({ entity: 'turn', row: {} } as never, v2)).toBeNull()
    expect(shapeChange({ entity: 'memory', row: { project: 'x' } } as never, v2)).toBeNull()
    expect(shapeChange({ entity: 'task', row: { id: 't' } } as never, v2)).not.toBeNull()
    // Old phones: everything, untouched.
    expect(shapeChange({ entity: 'turn', row: {} } as never, parsePrefs(undefined))).not.toBeNull()
  })

  it('a helper row loses its long text and says there is more', () => {
    const row = { kind: 'helper', text: 'h', meta: JSON.stringify({ state: 'working', brief: 'b'.repeat(5_000), result: { a: 'r'.repeat(4_000) } }) }
    const out = trimHelperRow(row)
    const meta = JSON.parse(out.meta) as Record<string, unknown>
    expect(meta['state']).toBe('working')
    expect((meta['brief'] as string).length).toBe(300)
    expect(meta['result']).toBeUndefined()
    expect(meta['more']).toBe(true)
    expect(out.meta.length).toBeLessThan(700)
  })

  it('cards go as a delta of what changed', () => {
    const held = rememberCards({ seq: 1, at: 1, cards: [{ id: 'a', n: 1 }, { id: 'b', n: 1 }] } as never)
    const b = { seq: 2, at: 2, cards: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 1 }] }
    const { delta, next } = cardsDelta(held, b)
    expect(delta?.upsert.map((c) => c.id)).toEqual(['b', 'c'])
    expect(delta?.remove).toEqual([])
    expect(delta?.base).toBe(1)
    expect(delta?.order).toEqual(['a', 'b', 'c'])
    expect(cardsDelta(next, { ...b, seq: 3 }).delta).toBeNull()
    expect(cardsDelta(next, { seq: 4, at: 4, cards: [{ id: 'a', n: 1 }] }).delta?.remove).toEqual(['b', 'c'])
  })

  it('permessage-deflate is taken only when offered plainly, and a message round-trips', () => {
    expect(offersDeflate(undefined)).toBe(false)
    expect(offersDeflate('permessage-deflate')).toBe(true)
    expect(offersDeflate('permessage-deflate; client_max_window_bits')).toBe(true)
    expect(offersDeflate('permessage-deflate; server_max_window_bits=10')).toBe(false)
    expect(offersDeflate('x-webkit-deflate-frame, permessage-deflate')).toBe(true)
    const text = Buffer.from(JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: `row-${i}`, text: 'hello world '.repeat(5) })) }))
    const packed = deflateMessage(text)
    expect(packed.length).toBeLessThan(text.length / 5)
    expect(inflateMessage(packed).equals(text)).toBe(true)
  })
})

describe('a linked phone on mobile data', () => {
  it('compression is used when offered and a client that does not offer it is unchanged', async () => {
    await seedChat()
    const plain = await link()
    const packed = await link({ deflate: true })
    try {
      expect(plain.deflated).toBe(false)
      process.stdout.write(`ext header: ${packed.deflated}\n`)
      expect(packed.deflated).toBe(true)
      const a = (await plain.call('data.list', 'chat_item')) as unknown[]
      const b = (await packed.call('data.list', 'chat_item')) as unknown[]
      expect(b).toEqual(a)
      expect(packed.bytesIn()).toBeLessThan(plain.bytesIn() / 3)
    } finally {
      plain.close()
      packed.close()
    }
  })

  it('first open is the newest 20 messages and the open cards, and "load earlier" pages back 20 at a time', async () => {
    const seeded = await seedChat()
    const phone = await link({ deflate: true })
    try {
      await phone.call('device.prefs', { v: 2, metered: true, helpers: false })
      const before = phone.bytesIn()
      const first = (await phone.call('data.list', 'chat_item', { v: 2, limit: 20, withSeq: true })) as { seq: number; rows: Array<{ id: string; text: string; kind: string; createdAt: number }>; more: boolean }
      const cost = phone.bytesIn() - before
      const texts = first.rows.map((r) => r.text)
      expect(first.rows).toHaveLength(21) // 20 messages + the old open question from another chat
      expect(first.rows.some((r) => r.id === seeded.question)).toBe(true)
      expect(first.rows.some((r) => r.kind === 'activity')).toBe(false)
      expect(texts.some((t) => t.startsWith('project line'))).toBe(false)
      expect(texts).toContain('message 299')
      expect(texts).not.toContain('message 279')
      expect(first.more).toBe(true)
      expect(first.seq).toBeGreaterThan(0)
      expect(cost).toBeLessThan(10_000)
      const oldest = Math.min(...first.rows.filter((r) => r.kind !== 'question').map((r) => r.createdAt))
      const page = (await phone.call('data.page', oldest, 20)) as { rows: Array<{ text: string }>; more: boolean }
      expect(page.rows).toHaveLength(20)
      expect(page.rows[page.rows.length - 1]?.text).toBe('message 279')
      expect(page.rows[0]?.text).toBe('message 260')
      // The small kinds are only read when asked for.
      const memory = (await phone.call('data.list', 'memory', { v: 2, withSeq: true })) as { rows: unknown[] }
      expect(memory.rows).toHaveLength(1)
    } finally {
      phone.close()
    }
  })

  it('live events: only kept rows, tagged with a seq; no chat nudge; no helper steps; a legacy phone hears it all', async () => {
    await seedChat()
    const phone = await link()
    const old = await link()
    try {
      await phone.call('device.prefs', { v: 2, metered: true, helpers: false })
      phone.events.length = 0
      old.events.length = 0
      service.broadcast(EVENTS.chat, { type: 'chat_changed' })
      await store.upsert('chat_item', { kind: 'activity', text: 'a step', meta: JSON.stringify({ helper: 'h1' }), createdAt: Date.now() })
      await store.upsert('chat_item', { kind: 'agent', text: 'in a project', meta: JSON.stringify({ chat: 'proj-a' }), createdAt: Date.now() })
      await store.upsert('chat_item', { kind: 'agent', text: 'for you', meta: '{}', createdAt: Date.now() })
      await sleep(400)
      const data = phone.events.filter((e) => e.name === EVENTS.data).map((e) => e.payload as { row?: { text: string }; seq?: number })
      expect(data.map((d) => d.row?.text)).toEqual(['for you'])
      expect(typeof data[0]?.seq).toBe('number')
      expect(phone.events.some((e) => e.name === EVENTS.chat)).toBe(false)
      process.stdout.write(JSON.stringify(old.events.map((e) => [e.name, JSON.stringify(e.payload).slice(0, 120)])) + '\n')
      expect(old.events.filter((e) => e.name === EVENTS.data && (e.payload as { entity?: string }).entity === 'chat_item')).toHaveLength(3)
      expect(old.events.some((e) => e.name === EVENTS.chat)).toBe(true)
    } finally {
      phone.close()
      old.close()
    }
  })

  it('a reconnect asks "since seq" and gets only what it missed, in a few KB; a seq it cannot use means read afresh', async () => {
    await seedChat()
    const phone = await link({ deflate: true })
    try {
      await phone.call('device.prefs', { v: 2, metered: true, helpers: false })
      const first = (await phone.call('data.list', 'chat_item', { v: 2, limit: 20, withSeq: true })) as { seq: number }
      // While the phone is away: a reply, a helper's steps, a project line, a task.
      await store.upsert('chat_item', { kind: 'agent', text: 'while you were away', meta: '{}', createdAt: Date.now() })
      for (let i = 0; i < 30; i += 1) await store.upsert('chat_item', { kind: 'activity', text: `step ${i}`, meta: JSON.stringify({ helper: 'h1', run: { stdout: 'o'.repeat(8_000) } }), createdAt: Date.now() })
      await store.upsert('chat_item', { kind: 'agent', text: 'project', meta: JSON.stringify({ chat: 'proj-a' }), createdAt: Date.now() })
      await store.upsert('task', { title: 'Call Roger', done: false } as never)
      const before = phone.bytesIn()
      const since = (await phone.call('data.since', first.seq)) as { reset?: boolean; seq: number; changes: Array<{ entity: string; row?: { text?: string; title?: string } }> }
      const cost = phone.bytesIn() - before
      expect(since.reset).toBeUndefined()
      expect(since.changes.map((c) => c.row?.text ?? c.row?.title)).toEqual(['while you were away', 'Call Roger'])
      expect(since.seq).toBeGreaterThan(first.seq)
      expect(cost).toBeLessThan(2_000)
      const again = (await phone.call('data.since', since.seq)) as { changes: unknown[] }
      expect(again.changes).toEqual([])
      expect(((await phone.call('data.since', 10_000_000)) as { reset?: boolean }).reset).toBe(true)
      expect(((await phone.call('data.since', -1)) as { reset?: boolean }).reset).toBe(true)
    } finally {
      phone.close()
    }
  })

  it('helper cards: none while metered and off the helpers screen; the whole list once on opening it, then only what changed', async () => {
    const phone = await link()
    const legacy = await link()
    try {
      const card = (id: string, n: number): { id: string; n: number } => ({ id, n })
      const snap = (seq: number, cards: Array<{ id: string; n: number }>): { seq: number; at: number; cards: Array<{ id: string; n: number }> } => ({ seq, at: seq, cards })
      await phone.call('device.prefs', { v: 2, metered: true, helpers: false })
      phone.events.length = 0
      legacy.events.length = 0
      service.broadcast(EVENTS.helperCards, snap(1, [card('a', 1), card('b', 1)]))
      await sleep(200)
      expect(phone.events.filter((e) => e.name === EVENTS.helperCards)).toHaveLength(0)
      expect(legacy.events.filter((e) => e.name === EVENTS.helperCards)).toHaveLength(1)
      // He opens the helpers screen: says so, asks for the list.
      await phone.call('device.prefs', { v: 2, metered: true, helpers: true })
      await phone.call('helpers.cards')
      phone.events.length = 0
      service.broadcast(EVENTS.helperCards, snap(2, [card('a', 1), card('b', 1)]))
      await sleep(150)
      phone.events.length = 0
      service.broadcast(EVENTS.helperCards, snap(3, [card('a', 1), card('b', 2)]))
      service.broadcast(EVENTS.helperCards, snap(4, [card('a', 1), card('b', 2)]))
      await sleep(300)
      const got = phone.events.filter((e) => e.name === EVENTS.helperCards).map((e) => e.payload as { delta?: boolean; upsert: Array<{ id: string }>; remove: string[]; base: number })
      expect(got).toHaveLength(1)
      expect(got[0]?.delta).toBe(true)
      expect(got[0]?.upsert.map((c) => c.id)).toEqual(['b'])
      // He leaves the screen: the stream stops again.
      await phone.call('device.prefs', { v: 2, metered: true, helpers: false })
      phone.events.length = 0
      service.broadcast(EVENTS.helperCards, snap(5, [card('a', 9)]))
      await sleep(200)
      expect(phone.events.filter((e) => e.name === EVENTS.helperCards)).toHaveLength(0)
    } finally {
      phone.close()
      legacy.close()
    }
  })

  it('ten minutes of helper work with the app open costs a few KB, against whole events before', async () => {
    await seedChat()
    const phone = await link({ deflate: true })
    const old = await link()
    try {
      await phone.call('device.prefs', { v: 2, metered: true, helpers: false })
      phone.events.length = 0
      const b0 = phone.bytesIn()
      const o0 = old.bytesIn()
      // Ten minutes of two helpers: a step every 4 s with 6 KB of output, a chat nudge and a cards update each step.
      for (let i = 0; i < 150; i += 1) {
        await store.upsert('chat_item', { kind: 'activity', text: `step ${i}`, meta: JSON.stringify({ helper: 'h1', run: { stdout: 'o'.repeat(6_000) } }), createdAt: Date.now() })
        service.broadcast(EVENTS.chat, { type: 'chat_changed' })
        service.broadcast(EVENTS.helperCards, { seq: i + 1, at: i, cards: [{ id: 'h1', step: `step ${i}`, text: 'x'.repeat(600) }] })
      }
      await sleep(600)
      const now = phone.bytesIn() - b0
      const then = old.bytesIn() - o0
      expect(now).toBeLessThan(5_000)
      expect(then).toBeGreaterThan(now * 20)
      process.stdout.write(`10 min of helper work: new ${now} bytes, old ${then} bytes\n`)
    } finally {
      phone.close()
      old.close()
    }
  })

  it('a phone may ask the computer to start connecting an app, and gets the answer back to open itself', async () => {
    const phone = await link()
    try {
      const answer = (await phone.call('apps.connectLink', 'gmail', '')) as { ok: boolean; link: string; message: string }
      // This test computer has no apps service: it says so plainly, and nothing opens on the computer.
      expect(answer.ok).toBe(false)
      expect(answer.message.length).toBeGreaterThan(3)
      await expect(phone.call('apps.connectLink', 'Not A Slug!', '')).rejects.toThrow()
    } finally {
      phone.close()
    }
  })
})

