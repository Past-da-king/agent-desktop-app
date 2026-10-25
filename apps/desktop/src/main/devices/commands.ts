/**
 * Device commands (docs/devices-protocol.md s5.2): open a link, take a file, show a notification, on one of the
 * person's devices.
 *
 * A command is written as a synced `device_command` row first, so it survives a restart and any brain the device
 * connects to can deliver it. When the target is connected it goes out at once as the event `device.command` (only
 * to that device's connections) and the device answers with the RPC `device.ack(id, ok, note)`. When it is not, the
 * row waits; every brain checks its waiting rows every few seconds and delivers the ones whose device has come
 * online. After 10 minutes undelivered (or unanswered) it expires, and the brain that made it tells the chat.
 */
import { randomUUID } from 'node:crypto'

import { MAIN_CHAT, type DeviceCommandRow } from '@agent/core'

import type { DataStore } from '../runtime/data'
import type { DevicesHost } from './types'

export const COMMAND_TTL_MS = 10 * 60_000
const ACK_WAIT_MS = 20_000
const TICK_MS = 3_000

export type CommandKind = DeviceCommandRow['kind']

export interface CommandInput {
  kind: CommandKind
  url?: string
  path?: string
  name?: string
  title?: string
  body?: string
}

export interface CommandOutcome {
  /** done / failed: the device answered; sent: delivered, no answer yet; queued: waiting for the device. */
  status: 'done' | 'failed' | 'sent' | 'queued'
  id: string
  note: string
}

export interface DeviceCommandsDeps {
  store: DataStore
  /** This node's id: the brain that made a command is the one that tells the chat when it expires. */
  selfId: () => string
  /** Tell the run that made the command (`owner`; the chat when there is none) in a note it reads as its next message. */
  noteBack: (chat: string, text: string, owner?: string) => void | Promise<void>
  now?: () => number
  ackWaitMs?: number
  tickMs?: number
  ttlMs?: number
}

export class DeviceCommands {
  private host: DevicesHost | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly waiters = new Map<string, (ack: { ok: boolean; note: string }) => void>()
  private readonly now: () => number

  constructor(private readonly deps: DeviceCommandsDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Plug into the node server: the ack RPC, and the delivery loop. */
  attach(host: DevicesHost): void {
    this.host = host
    host.addRpc('device.ack', async (deviceId, args) => {
      const [id, ok, note] = args
      if (typeof id !== 'string') throw new Error('device.ack needs a command id')
      return this.ack(deviceId, id, ok === true, typeof note === 'string' ? note : '')
    })
    this.start()
  }

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.tick(), this.deps.tickMs ?? TICK_MS)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    for (const resolve of this.waiters.values()) resolve({ ok: false, note: 'The app is closing.' })
    this.waiters.clear()
  }

  /** Send a command to a device and wait a little for its answer. */
  async send(target: string, input: CommandInput, chat: string = MAIN_CHAT, targetName = 'the device', owner = ''): Promise<CommandOutcome> {
    const at = this.now()
    const row = await this.deps.store.upsert('device_command', {
      id: `cmd_${randomUUID()}`,
      target,
      ...clean(input),
      status: 'queued',
      note: '',
      chat,
      brainId: this.deps.selfId(),
      owner,
      expiresAt: at + (this.deps.ttlMs ?? COMMAND_TTL_MS),
      updatedAt: at,
    })
    const host = this.host
    if (host === null || !host.isConnected(target)) {
      return { status: 'queued', id: row.id, note: `${targetName} is not online right now. It will get this when it connects (within 10 minutes).` }
    }
    const answer = this.waitForAck(row.id)
    await this.deliver(host, row)
    const ack = await answer
    if (ack === null) return { status: 'sent', id: row.id, note: `Sent to ${targetName}; it has not confirmed yet.` }
    return { status: ack.ok ? 'done' : 'failed', id: row.id, note: ack.note }
  }

  /** The device's answer. Only the device a command was for may answer it. */
  async ack(deviceId: string, id: string, ok: boolean, note: string): Promise<boolean> {
    const row = await this.deps.store.get('device_command', id)
    if (row === null || row.target !== deviceId) return false
    if (row.status === 'done' || row.status === 'failed') return true
    await this.deps.store.upsert('device_command', { id, status: ok ? 'done' : 'failed', note: note.slice(0, 500), updatedAt: this.now() })
    const waiter = this.waiters.get(id)
    this.waiters.delete(id)
    waiter?.({ ok, note })
    if (waiter === undefined && !ok && row.brainId === this.deps.selfId()) {
      await this.deps.noteBack(row.chat, `[Device note: ${what(row)} did not work on the device${note === '' ? '' : `: ${note}`}.]`, row.owner ?? '')
    }
    return true
  }

  /** Deliver what waits for devices that are online now, and expire what waited too long. */
  async tick(): Promise<void> {
    // One pass at a time: two overlapping passes both saw a row still queued and told its run twice.
    if (this.ticking) return
    this.ticking = true
    try {
      await this.tickOnce()
    } finally {
      this.ticking = false
    }
  }

  private ticking = false

  private async tickOnce(): Promise<void> {
    const host = this.host
    const now = this.now()
    const rows = await this.deps.store.list('device_command')
    for (const row of rows) {
      if (row.status !== 'queued' && row.status !== 'sent') continue
      if (row.expiresAt <= now) {
        // Only the brain that made it reports it, so the chat hears it once.
        if (row.brainId !== this.deps.selfId()) continue
        await this.deps.store.upsert('device_command', { id: row.id, status: 'expired', updatedAt: now })
        const why = row.status === 'queued' ? 'the device did not come online within 10 minutes' : 'the device never confirmed it'
        await this.deps.noteBack(row.chat, `[Device note: ${what(row)} was not delivered: ${why}. Tell the user another way if it still matters.]`, row.owner ?? '')
        continue
      }
      if (row.status === 'queued' && row.kind !== 'tool' && host !== null && host.isConnected(row.target)) await this.deliver(host, row)
    }
  }

  private async deliver(host: DevicesHost, row: DeviceCommandRow): Promise<void> {
    host.emit(row.target, 'device.command', payloadOf(row))
    await this.deps.store.upsert('device_command', { id: row.id, status: 'sent', updatedAt: this.now() })
  }

  private waitForAck(id: string): Promise<{ ok: boolean; note: string } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        resolve(null)
      }, this.deps.ackWaitMs ?? ACK_WAIT_MS)
      this.waiters.set(id, (ack) => {
        clearTimeout(timer)
        resolve(ack)
      })
    })
  }
}

/** The event payload: the command, nothing about the brain or the chat. */
export function payloadOf(row: DeviceCommandRow): Record<string, string> {
  const out: Record<string, string> = { id: row.id, kind: row.kind }
  for (const key of ['url', 'path', 'name', 'title', 'body'] as const) {
    const value = row[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** The address a device downloads a file from, with its own pass (protocol s5, /v1/file). */
export function fileUrl(path: string): string {
  return `/v1/file?path=${encodeURIComponent(path)}`
}

function clean(input: CommandInput): CommandInput {
  const out: CommandInput = { kind: input.kind }
  for (const key of ['url', 'path', 'name', 'title', 'body'] as const) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') out[key] = value.slice(0, 4000)
  }
  return out
}

function what(row: DeviceCommandRow): string {
  if (row.kind === 'tool') return `Running ${row.tool ?? 'the tool'}`
  if (row.kind === 'open_url') return `Opening ${row.url ?? 'the link'}`
  if (row.kind === 'send_file') return `Sending ${row.name ?? 'the file'}`
  if (row.kind === 'show_image') return 'Showing the picture'
  return `The notification "${row.title ?? ''}"`
}
