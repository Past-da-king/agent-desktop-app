/**
 * 27 Nov 2026: the computer's drive filled up. Every message from the phone came back with ENOSPC or "database or
 * disk is full", the phone kept trying the same full computer, and nothing said the disk was full.
 *
 * This runs the real node the phone talks to, with the real database failing for real (SQLite's own SQLITE_FULL), and
 * checks what the phone gets: the reason in one short line when a write fails, a health answer of "not ready" from that
 * moment, and a closed link (4011, "this brain is not ready") instead of another message taken in. That is what makes
 * the phone move to the next brain in the order instead of failing here again and again.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Attachment, Decision, RunState } from '@agent/core'

import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { DiskHealth } from '../src/main/disk-health'
import { DiskWatch } from '../src/main/disk-watch'
import { HandlerRegistry, recordHandlers } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import type { MessageOrigin } from '../src/main/devices/types'
import { registerIpc, type ChatRunner } from '../src/main/ipc'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { connectRpc, pinnedRequest, type RpcClient } from './devices-client'

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
}

const PHONE = { name: 'A35', kind: 'phone', platform: 'android', appVersion: '0.15.81', screen: { width: 412, height: 915 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }

let dir = ''
let store: Store
let service: DevicesService
let health: DiskHealth
let dispose: (() => void) | null = null
let sends: Array<{ text: string; chat?: string }>
/** Movable time, so a test can jump past the half-minute hold a failed write keeps this node out for. */
let clock = { at: 1_000 }

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-disk-full-node-'))
  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'pc' })
  const secrets = new Secrets(join(dir, 'secrets'), storage)
  const account = new AccountService(store, settings, secrets, { autoStart: false })
  sends = []
  clock = { at: 1_000 }
  health = new DiskHealth({ name: () => 'pc', now: () => clock.at })
  const watch = new DiskWatch({
    health,
    path: () => dir,
    notify: () => undefined,
    note: (text) => void store.upsert('chat_item', { kind: 'notice', text, meta: JSON.stringify({ diskHealth: true }) }).catch(() => undefined),
    stat: async () => ({ freeGb: 0.2, totalGb: 476 }),
  })
  store.setDiskFullHandler((error) => watch.writeFailed(error))
  const chat: ChatRunner = {
    send: async (text: string, _a?: Attachment[], target?: string, _o?: MessageOrigin) => void sends.push({ text, chat: target }),
    stop: () => undefined,
    state: (): RunState => ({ running: false, waiting: [] }),
    answer: async () => undefined,
    decide: async (_id: string, _decision: Decision) => undefined,
    tap: async () => undefined,
  }
  mkdirSync(join(dir, 'renderer'), { recursive: true })
  // One registry: the handlers registerIpc records are the ones the node serves over /v1/rpc to the phone.
  const registry = new HandlerRegistry()
  service = new DevicesService({
    userData: dir,
    store,
    secrets,
    registry,
    appVersion: '9.9.9',
    nodeName: () => 'pc',
    platform: 'linux',
    // What the app wires in index.ts: a full disk is this node not being ready, and the reason is on its own line.
    ready: () => !health.blocked(),
    availability: () => health.line(),
    busy: () => false,
    rendererDir: join(dir, 'renderer'),
    emitWindow: () => undefined,
  })
  const ipcMain = recordHandlers({ handle: () => undefined }, registry)
  dispose = registerIpc({
    store,
    settings,
    secrets,
    account,
    chat,
    ipcMain,
    windows: { minimize: () => undefined, toggleMaximize: () => undefined, close: () => undefined, isMaximized: () => false },
    broadcast: (channel, payload) => service.broadcast(channel, payload),
    routines: { runNow: async () => undefined },
    helpers: { delegate: async () => '', steer: async () => '', push: async () => '', status: async () => '', stop: async () => true, stopAll: async () => 0 },
    pasted: { save: async (name, mime) => ({ path: join(dir, 'attachments', name), name, mime }), clipboardFiles: async () => [] },
    answerBlocker: () => (health.blocked() ? health.line() : ''),
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

/** The phone: paired with a short code, then on the real socket with its own pass. */
async function connectPhone(): Promise<RpcClient & { base: string; fp: string }> {
  const status = service.status()
  const base = `https://127.0.0.1:${status.port}`
  const reply = await pinnedRequest(`${base}/v1/pair`, status.fp, { method: 'POST', body: { code: service.offer().shortCode.replace('-', ''), device: PHONE, wantRoles: ['screen'] } })
  expect(reply.status).toBe(200)
  const { pass } = reply.json() as { pass: string }
  const phone = await connectRpc(base, status.fp, pass, PHONE)
  return Object.assign(phone, { base, fp: status.fp })
}

/** Fill the real database to SQLite's own ceiling, so the next write fails exactly as it does on a full drive. */
function fillTheDatabase(): void {
  ;(store as unknown as { db: { exec(sql: string): void } }).db.exec('PRAGMA max_page_count = 96')
}

describe('the node when its disk is full', { timeout: 60_000 }, () => {
  it('gives the phone the reason in one short line, and stops being ready in the same breath', async () => {
    const phone = await connectPhone()
    fillTheDatabase()
    // One write too many: the phone's own write fails for real, and the link is closed under it so it tries the next
    // brain rather than being told its message was bad (27 Nov 2026: it retried this full computer again and again).
    let refusal: Error | null = null
    let outcome = 'ok'
    for (let i = 0; i < 5_000 && outcome === 'ok'; i += 1) {
      outcome = await Promise.race([
        phone.call('data.upsert', 'task', { title: `row ${i}`, notes: 'x'.repeat(2_000), status: 'todo', owner: 'user' }).then(
          () => 'ok',
          (error: Error) => {
            refusal = error
            return 'error'
          },
        ),
        phone.closed.then(() => 'closed'),
      ])
    }
    expect(outcome).not.toBe('ok')
    // What the phone is shown: the reason. Not the rollback noise it got on 27 Nov 2026 ("cannot rollback - no
    // transaction is active"), and not a message that says nothing.
    expect(refusal).not.toBeNull()
    expect(refusal?.message).toContain('database or disk is full')
    expect(refusal?.message).not.toContain('rollback')
    // And this node let the phone go, down the order to the next brain.
    await expect(phone.closed).resolves.toBe(4011)

    // It took itself out at that moment, without waiting for a timer: its health answer says not ready.
    expect(health.blocked()).toBe(true)
    const healthNow = await pinnedRequest(`${phone.base}/v1/health`, phone.fp)
    expect((healthNow.json() as { ready: boolean }).ready).toBe(false)
    // And its own line says why, so the person reading Devices on any device sees it.
    expect(service.status().answering).toContain('disk is full')
    expect(service.status().answering).toContain('another device')
  })

  it('takes no message while it is full: the phone link is closed with the reason, and nothing is stored', async () => {
    const phone = await connectPhone()
    health.writeFailed(new Error('ENOSPC: no space left on device, write'))
    // The phone's next message: the node refuses and closes the link (4011), so the phone moves down the order.
    void phone.call('chat.sendOnce', { sendId: 'aaaabbbbccccdddd0001', sentAt: 1, text: 'hello' }).catch(() => undefined)
    await expect(phone.closed).resolves.toBe(4011)
    expect(sends).toEqual([])
    // A fresh link gets no further either: it is closed again, at once, with the same reason for the person.
    const again = await connectPhone()
    void again.call('chat.sendOnce', { sendId: 'aaaabbbbccccdddd0002', sentAt: 2, text: 'hello again' }).catch(() => undefined)
    await expect(again.closed).resolves.toBe(4011)
    expect(sends).toEqual([])
    expect(health.line()).toContain('disk is full')
  })

  it('answers again, and takes a message, once the disk has had room for half a minute', async () => {
    const phone = await connectPhone()
    health.writeFailed(new Error('ENOSPC: no space left on device, write'))
    // A reading taken a moment later saying there is room is not believed yet (it may be a stale one).
    clock.at += 5_000
    health.sample(200, 476)
    expect(health.blocked()).toBe(true)
    expect(((await pinnedRequest(`${phone.base}/v1/health`, phone.fp)).json() as { ready: boolean }).ready).toBe(false)
    // Half a minute on, with room on the drive: back in the order, and a message lands.
    clock.at += 60_000
    health.sample(200, 476)
    expect(health.blocked()).toBe(false)
    expect(((await pinnedRequest(`${phone.base}/v1/health`, phone.fp)).json() as { ready: boolean }).ready).toBe(true)
    const after = await connectPhone()
    await after.call('chat.sendOnce', { sendId: 'aaaabbbbccccdddd0003', sentAt: 3, text: 'room again' })
    expect(sends.map((send) => send.text)).toEqual(['room again'])
  })
})
