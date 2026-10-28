/**
 * A scripted device for the devices tests: HTTPS with the node's certificate pinned by fingerprint (as the phone
 * does), and the RPC WebSocket over the node's own framing (main/devices/ws.ts, client side).
 */
import { createHash } from 'node:crypto'
import { request } from 'node:https'
import type { TLSSocket } from 'node:tls'

import { WsConnection } from '../src/main/devices/ws'

export interface PinnedReply {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
  json: () => unknown
}

export function pinnedRequest(
  url: string,
  fp: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<PinnedReply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), 'utf8')
    const req = request(
      url,
      {
        method: options.method ?? 'GET',
        // A fresh connection every time, so every request is pinned (a kept-alive socket skips secureConnect).
        agent: false,
        rejectUnauthorized: false,
        headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(payload.length) }), ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const body = Buffer.concat(chunks)
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body.toString('utf8')) })
        })
      },
    )
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const raw = (socket as TLSSocket).getPeerCertificate().raw
        const seen = createHash('sha256').update(raw).digest('base64url')
        if (seen !== fp) req.destroy(new Error(`certificate does not match the pinned fingerprint`))
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

export interface RpcClient {
  call(method: string, ...args: unknown[]): Promise<unknown>
  events: Array<{ name: string; payload: unknown }>
  waitForEvent(name: string, ms?: number): Promise<unknown>
  closed: Promise<number>
  close(): void
  send(frame: unknown): void
  /** Bytes read off the socket since it opened (what the link cost, after any compression). */
  bytesIn(): number
  /** Whether permessage-deflate was agreed. */
  deflated: boolean
}

export function connectRpc(base: string, fp: string, pass: string, hello: unknown, tools?: unknown[], options: { deflate?: boolean } = {}): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/v1/rpc`, {
      agent: false,
      rejectUnauthorized: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('agent-devices-01').toString('base64'),
        Authorization: `Bearer ${pass}`,
        ...(options.deflate === true ? { 'Sec-WebSocket-Extensions': 'permessage-deflate' } : {}),
      },
    })
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        const raw = (socket as TLSSocket).getPeerCertificate().raw
        if (createHash('sha256').update(raw).digest('base64url') !== fp) req.destroy(new Error('pin mismatch'))
      })
    })
    req.on('response', (res) => reject(new Error(`upgrade refused: ${res.statusCode ?? 0}`)))
    req.on('error', reject)
    req.on('upgrade', (res, socket, head) => {
      const conn = new WsConnection(socket, true)
      conn.deflate = options.deflate === true && String(res.headers['sec-websocket-extensions'] ?? '').includes('permessage-deflate')
      let received = head.length
      socket.on('data', (chunk: Buffer) => {
        received += chunk.length
      })
      if (head.length > 0) conn.feed(head)
      let next = 1
      const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
      const events: Array<{ name: string; payload: unknown }> = []
      const waiters: Array<{ name: string; resolve: (v: unknown) => void }> = []
      let closedResolve: (code: number) => void = () => undefined
      const closed = new Promise<number>((r) => {
        closedResolve = r
      })
      conn.onClose((code) => closedResolve(code))
      conn.onMessage((message) => {
        if (!('text' in message)) return
        const frame = JSON.parse(message.text) as Record<string, unknown>
        if (frame['type'] === 'result') {
          const waiting = pending.get(String(frame['id']))
          pending.delete(String(frame['id']))
          if (frame['ok'] === true) waiting?.resolve(frame['value'])
          else waiting?.reject(new Error(String(frame['error'])))
        } else if (frame['type'] === 'event') {
          const event = { name: String(frame['name']), payload: frame['payload'] }
          events.push(event)
          for (const waiter of [...waiters]) {
            if (waiter.name === event.name) {
              waiters.splice(waiters.indexOf(waiter), 1)
              waiter.resolve(event.payload)
            }
          }
        }
      })
      // The phone's own frame: tools at the top level, beside the facts (protocol s11).
      conn.sendText(JSON.stringify(tools === undefined ? { type: 'hello', device: hello } : { type: 'hello', device: hello, tools }))
      resolve({
        bytesIn: () => received,
        deflated: conn.deflate,
        call: (method, ...args) =>
          new Promise((ok, fail) => {
            const id = String(next++)
            pending.set(id, { resolve: ok, reject: fail })
            conn.sendText(JSON.stringify({ type: 'call', id, method, args }))
          }),
        events,
        waitForEvent: (name, ms = 5000) =>
          new Promise((ok, fail) => {
            const timer = setTimeout(() => fail(new Error(`no ${name} event`)), ms)
            waiters.push({
              name,
              resolve: (value) => {
                clearTimeout(timer)
                ok(value)
              },
            })
          }),
        closed,
        close: () => conn.close(),
        send: (frame) => conn.sendText(JSON.stringify(frame)),
      })
    })
    req.end()
  })
}
