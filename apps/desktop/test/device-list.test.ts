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
import { DEVICE_CHAT_ROWS, boundRows } from '../src/shared/device-list'
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


const N = 60_000

/** A big install: `N` chat rows (main chat plus two project chats, each row ~4 KB), a few cards, one live helper. */
function seed(file: string): { openApproval: string; openQuestion: string; answered: string; helper: string } {
  const db = new DatabaseSync(file)
  const insert = db.prepare("INSERT OR REPLACE INTO rows(entity, cid, stamp, deleted, payload, local) VALUES ('chat_item', ?, ?, 0, ?, 0)")
  const filler = 'x'.repeat(4_000)
  const t0 = Date.now() - N * 1000
  db.exec('BEGIN')
  for (let i = 0; i < N; i += 1) {
    const chat = i % 10 === 0 ? 'proj-a' : i % 10 === 1 ? 'proj-b' : undefined
    const meta = chat === undefined ? '{}' : JSON.stringify({ chat })
    const stamp = String(i).padStart(12, '0')
    insert.run(`row-${i}`, stamp, JSON.stringify({ kind: i % 2 === 0 ? 'user' : 'agent', text: `${filler} ${i}`, meta, createdAt: t0 + i * 1000 }))
  }
  const card = (id: string, kind: string, meta: object, at: number): void =>
    void insert.run(id, 'z' + id, JSON.stringify({ kind, text: id, meta: JSON.stringify(meta), createdAt: at }))
  // Old cards, far outside the newest 400: one waiting approval, one waiting question, one answered question, a live helper.
  card('old-approval', 'approval', {}, t0 + 5)
  card('old-question', 'question', {}, t0 + 6)
  card('old-answered', 'question', { answer: 'yes' }, t0 + 7)
  card('old-helper', 'helper', { state: 'working' }, Date.now() - 60_000)
  db.exec('COMMIT')
  db.close()
  return { openApproval: 'old-approval', openQuestion: 'old-question', answered: 'old-answered', helper: 'old-helper' }
}

describe('a linked device asks for a big chat table', () => {
  it('boundRows keeps the newest rows inside the row and byte caps', () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => ({ i, pad: 'y'.repeat(1_000) }))
    const kept = boundRows(rows)
    const old = boundRows([{ i: -1, keep: true }, ...rows], (r) => 'keep' in r)
    expect(old[0]).toEqual({ i: -1, keep: true })
    expect(kept.length).toBeLessThanOrEqual(2_000)
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(4_000_000 + kept.length)
    expect(kept[kept.length - 1]?.i).toBe(4_999)
    expect(boundRows([{ a: 1 }, { a: 2 }])).toHaveLength(2)
  })

  it('the store hands back the recent rows of every chat plus open cards and live helpers, fast, out of 60k rows', async () => {
    const ids = seed(join(dir, 'agent.db'))
    const started = performance.now()
    const rows = await store.listChatItemsForDevice(DEVICE_CHAT_ROWS)
    const took = performance.now() - started
    const chatOf = (r: { meta: string }): string => (JSON.parse(r.meta) as { chat?: string }).chat ?? 'main'
    const per = (chat: string): number => rows.filter((r) => chatOf(r) === chat).length
    // 400 per chat; the live helper is already among the newest rows.
    expect(per('main')).toBe(DEVICE_CHAT_ROWS + 2) // the two old waiting cards ride along
    expect(per('proj-a')).toBe(DEVICE_CHAT_ROWS)
    expect(per('proj-b')).toBe(DEVICE_CHAT_ROWS)
    const got = new Set(rows.map((r) => r.id))
    expect(got.has(ids.openApproval)).toBe(true)
    expect(got.has(ids.openQuestion)).toBe(true)
    expect(got.has(ids.helper)).toBe(true)
    expect(got.has(ids.answered)).toBe(false)
    expect(rows.length).toBe(3 * DEVICE_CHAT_ROWS + 2)
    // Oldest first, and the newest row is the newest of the table.
    const times = rows.map((r) => r.createdAt)
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(rows[rows.length - 1]?.id).toBe(`row-${N - 1}`)
    expect(took).toBeLessThan(3_000)
  }, 120_000)

  it('over the wire: the list arrives small and fast, and pings keep being answered while it is built', async () => {
    seed(join(dir, 'agent.db'))
    const status = service.status()
    const base = `https://127.0.0.1:${status.port}`
    const pair = await pinnedRequest(`${base}/v1/pair`, status.fp, { method: 'POST', body: { code: service.offer().shortCode.replace('-', ''), device: PHONE, wantRoles: ['screen'] } })
    const { pass } = pair.json() as { deviceId: string; pass: string }
    const phone = await connectRpc(base, status.fp, pass, PHONE, PHONE_TOOLS)
    try {
      // A ticker proves the event loop is never held for long while the list is answered.
      let worst = 0
      let last = performance.now()
      const tick = setInterval(() => {
        const now = performance.now()
        worst = Math.max(worst, now - last)
        last = now
      }, 10)
      const started = performance.now()
      const rows = (await phone.call('data.list', 'chat_item')) as Array<{ id: string; text: string }>
      const took = performance.now() - started
      clearInterval(tick)
      // 4 KB rows: the 4 MB cap cuts the oldest, but the waiting cards stay and the newest row is there.
      const got = new Set(rows.map((r) => r.id))
      expect(got.has('old-approval') && got.has('old-question') && got.has('old-helper')).toBe(true)
      expect(got.has('old-answered')).toBe(false)
      expect(rows[rows.length - 1]?.id).toBe(`row-${N - 1}`)
      expect(rows.length).toBeLessThanOrEqual(3 * DEVICE_CHAT_ROWS + 2)
      expect(JSON.stringify(rows).length).toBeLessThan(4_200_000)
      expect(took).toBeLessThan(5_000)
      console.log("worst-stall-ms", Math.round(worst)); expect(worst).toBeLessThan(500)
      // The same device asking again, and other kinds, still work.
      expect(((await phone.call('data.list', 'chat_item')) as unknown[]).length).toBe(rows.length)
      expect(await phone.call('data.list', 'goal')).toEqual([])
    } finally {
      phone.close()
    }
  }, 120_000)
})
