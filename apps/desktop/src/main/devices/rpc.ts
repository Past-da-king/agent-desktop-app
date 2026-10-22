/**
 * The app contract over a WebSocket (protocol s5.1). One RpcSession per connection: the device says hello with its
 * facts, then calls methods by their dotted AgentApi name and hears the main process events. Methods resolve in
 * this order: ones another part added with `addRpc`, then the recorded IPC handler behind the ALLOWLIST.
 */
import { NOT_AVAILABLE, RPC_ALLOWED, RPC_CHANNELS, decodeWire, encodeWire } from '../../shared/rpc-methods'
import { cleanFacts } from './facts'
import { originFrom } from './origin'
import type { HandlerRegistry, WireEvent } from './registry'
import type { DeviceFacts, MessageOrigin, RpcMethod } from './types'
import type { WsConnection } from './ws'

const HELLO_WAIT_MS = 15_000
const PING_MS = 25_000
const MAX_ERROR = 400

export interface RpcSessionDeps {
  deviceId: string
  /** Runs one call; throws with a plain message on failure. */
  call(session: RpcSession, method: string, args: unknown[]): Promise<unknown>
  onHello(session: RpcSession): void
  /** The link ended with WebSocket close `code` (1006: the socket just went). */
  onClose(session: RpcSession, code: number): void
}

export class RpcSession {
  readonly deviceId: string
  facts: DeviceFacts | null = null
  private readonly pinger: NodeJS.Timeout
  private readonly helloTimer: NodeJS.Timeout

  constructor(
    private readonly conn: WsConnection,
    private readonly deps: RpcSessionDeps,
  ) {
    this.deviceId = deps.deviceId
    conn.onMessage((message) => {
      if ('text' in message) void this.onText(message.text)
    })
    conn.onClose((code) => {
      clearInterval(this.pinger)
      clearTimeout(this.helloTimer)
      deps.onClose(this, code)
    })
    this.pinger = setInterval(() => conn.ping(), PING_MS)
    this.pinger.unref?.()
    this.helloTimer = setTimeout(() => {
      if (this.facts === null) conn.close(4000, 'hello first')
    }, HELLO_WAIT_MS)
    this.helloTimer.unref?.()
  }

  get open(): boolean {
    return this.conn.isOpen
  }

  origin(): MessageOrigin | null {
    return this.facts === null ? null : originFrom(this.deviceId, this.facts)
  }

  event(name: string, payload: unknown): void {
    this.send({ type: 'event', name, payload: encodeWire(payload ?? null) })
  }

  close(code = 4001, reason = 'closed'): void {
    this.conn.close(code, reason)
  }

  private send(frame: unknown): void {
    if (this.conn.isOpen) this.conn.sendText(JSON.stringify(frame))
  }

  private async onText(text: string): Promise<void> {
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const value = frame as Record<string, unknown>
    if (value['type'] === 'hello') {
      // s11: the catalogue rides in the hello, beside the facts (or inside them).
      const device = value['device']
      const withTools =
        value['tools'] !== undefined && typeof device === 'object' && device !== null ? { ...(device as Record<string, unknown>), tools: value['tools'] } : device
      const facts = cleanFacts(withTools)
      if (facts === null) {
        this.conn.close(4002, 'bad hello')
        return
      }
      this.facts = facts
      this.deps.onHello(this)
      return
    }
    if (value['type'] !== 'call') return
    const id = value['id']
    if (typeof id !== 'string' && typeof id !== 'number') return
    const method = typeof value['method'] === 'string' ? value['method'] : ''
    const args = Array.isArray(value['args']) ? (decodeWire(value['args']) as unknown[]) : []
    if (this.facts === null) {
      this.send({ type: 'result', id, ok: false, error: 'Say hello first.' })
      return
    }
    try {
      const result = await this.deps.call(this, method, args)
      this.send({ type: 'result', id, ok: true, value: encodeWire(result ?? null) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.send({ type: 'result', id, ok: false, error: message.slice(0, MAX_ERROR) })
    }
  }
}

/** Methods a device may never reach through data.* (the device registry changes only through devices.*). */
function guardData(method: string, args: unknown[]): void {
  if ((method === 'data.upsert' || method === 'data.remove') && args[0] === 'device') throw new Error(NOT_AVAILABLE)
}

/** Calls a recorded IPC handler by its dotted name, if the ALLOWLIST lets a device reach it. */
export async function callAllowed(
  registry: HandlerRegistry,
  added: ReadonlyMap<string, RpcMethod>,
  session: { deviceId: string; origin(): MessageOrigin | null },
  method: string,
  args: unknown[],
): Promise<unknown> {
  const extra = added.get(method)
  if (extra !== undefined) return extra(session.deviceId, args)
  if (!RPC_ALLOWED.has(method)) throw new Error(NOT_AVAILABLE)
  guardData(method, args)
  const channel = RPC_CHANNELS[method]
  const handler = channel === undefined ? null : registry.get(channel)
  if (handler === null) throw new Error(NOT_AVAILABLE)
  const origin = session.origin()
  if (origin === null) throw new Error('Say hello first.')
  const event: WireEvent = { sender: null, wire: { deviceId: session.deviceId, origin } }
  return handler(event, ...args)
}
