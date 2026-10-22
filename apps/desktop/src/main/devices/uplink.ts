/**
 * When another brain answers (it is first in the brain order), this node connects OUT to that brain's /v1/rpc as
 * a device: hello with its facts and tools, then it runs the tool commands the brain sends and answers with
 * device.result (protocol s11). So a computer behind a firewall still lends its browser, files and approvals.
 * The brain's certificate is pinned from its device row; the pass is this node's own (its hash is in the mesh's
 * pass table, which travels to the brains in the bundle).
 */
import { createHash, randomBytes } from 'node:crypto'
import { request } from 'node:https'
import type { TLSSocket } from 'node:tls'

import { proxyAgent } from './socks'

import { WsConnection } from './ws'
import type { DeviceFacts, DeviceToolResult } from './types'

const RECHECK_MS = 15_000
const HEALTH_TIMEOUT_MS = 3000

export interface UplinkTarget {
  id: string
  urls: string[]
  fp: string
}

export interface UplinkDeps {
  /** The brain to serve, or null when this node is the one answering (or Devices is off). */
  target: () => UplinkTarget | null
  pass: () => string
  facts: () => DeviceFacts
  /** Runs a device command of kind "tool". */
  runTool: (command: unknown) => Promise<DeviceToolResult>
  /** Any other device command (open_url, notify...): done here, answered with device.ack. */
  other?: (command: Record<string, unknown>) => Promise<{ ok: boolean; note: string }>
  log?: (message: string, detail?: Record<string, unknown>) => void
  onState?: (connectedTo: string | null) => void
}

/** Opens a WebSocket to `url` with the certificate pinned to `fp`. Rejects on a wrong certificate or a refusal. */
export function connectPinned(url: string, fp: string, pass: string, timeoutMs = 8000): Promise<WsConnection> {
  return new Promise((resolve, reject) => {
    const req = request(`${url}/v1/rpc`, {
      // Through the devices proxy when one is set, or the built-in overlay for its hosts (devices/socks.ts proxyFor).
      agent: proxyAgent(new URL(url).hostname),
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Authorization: `Bearer ${pass}`,
      },
    })
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const raw = (socket as TLSSocket).getPeerCertificate().raw
        if (raw === undefined || createHash('sha256').update(raw).digest('base64url') !== fp) req.destroy(new Error('The other device showed a different certificate.'))
      })
    })
    req.on('timeout', () => req.destroy(new Error('No answer.')))
    req.on('response', (res) => {
      res.resume()
      reject(new Error(res.statusCode === 401 ? 'The other device does not know this one yet.' : `Refused (${res.statusCode ?? 0}).`))
    })
    req.on('error', reject)
    req.on('upgrade', (_res, socket, head) => {
      socket.setTimeout(0)
      const conn = new WsConnection(socket, true)
      if (head.length > 0) conn.feed(head)
      resolve(conn)
    })
    req.end()
  })
}

export class Uplink {
  private conn: WsConnection | null = null
  private connectedTo: string | null = null
  private timer: NodeJS.Timeout | null = null
  private busy = false
  private next = 1
  private running = false

  constructor(private readonly deps: UplinkDeps) {}

  start(): void {
    if (this.running) return
    this.running = true
    void this.tick()
    this.timer = setInterval(() => void this.tick(), RECHECK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.drop()
  }

  /** The brain this node is serving now, or null. */
  get target(): string | null {
    return this.connectedTo
  }

  /** Says hello again (the tools or facts changed). */
  refresh(): void {
    this.hello()
  }

  /** Checks the target now: connects, moves to another brain, or lets go. */
  async tick(): Promise<void> {
    if (!this.running || this.busy) return
    const target = this.deps.target()
    if (target === null) {
      this.drop()
      return
    }
    if (this.conn?.isOpen === true && this.connectedTo === target.id) return
    this.drop()
    this.busy = true
    try {
      for (const url of target.urls) {
        try {
          const conn = await connectPinned(url, target.fp, this.deps.pass(), HEALTH_TIMEOUT_MS * 2)
          this.attach(conn, target.id)
          this.deps.log?.('Serving tools to the answering device', { device: target.id })
          return
        } catch {
          // Try its next address.
        }
      }
    } finally {
      this.busy = false
    }
  }

  private attach(conn: WsConnection, id: string): void {
    this.conn = conn
    this.connectedTo = id
    conn.onClose(() => {
      if (this.conn === conn) {
        this.conn = null
        this.connectedTo = null
        this.deps.onState?.(null)
      }
    })
    conn.onMessage((message) => {
      if ('text' in message) void this.onText(message.text)
    })
    this.hello()
    this.deps.onState?.(id)
  }

  private hello(): void {
    if (this.conn?.isOpen !== true) return
    const facts = this.deps.facts()
    this.conn.sendText(JSON.stringify({ type: 'hello', device: facts, tools: facts.tools ?? [] }))
  }

  private call(method: string, args: unknown[]): void {
    if (this.conn?.isOpen !== true) return
    this.conn.sendText(JSON.stringify({ type: 'call', id: `u${this.next++}`, method, args }))
  }

  private async onText(text: string): Promise<void> {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (frame['type'] !== 'event' || frame['name'] !== 'device.command') return
    const command = frame['payload']
    if (typeof command !== 'object' || command === null) return
    const value = command as Record<string, unknown>
    const id = typeof value['id'] === 'string' ? value['id'] : ''
    if (id === '') return
    if (value['kind'] === 'tool') {
      const result = await this.deps.runTool(command)
      this.call('device.result', result.ok ? [id, true, result.value] : [id, false, result.error])
      return
    }
    const done = this.deps.other === undefined ? { ok: false, note: 'This device does not do that.' } : await this.deps.other(value).catch(() => ({ ok: false, note: 'It failed here.' }))
    this.call('device.ack', [id, done.ok, done.note])
  }

  private drop(): void {
    const conn = this.conn
    this.conn = null
    if (this.connectedTo !== null) this.deps.onState?.(null)
    this.connectedTo = null
    conn?.close(1000, 'moving on')
  }
}
