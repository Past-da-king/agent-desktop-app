/**
 * The node's HTTPS server (protocol s2 and s5): one port, its own certificate, routes added by the parts that
 * plug in (DevicesHost), pass auth by Bearer header or the agent_pass cookie, and the RPC WebSocket at /v1/rpc.
 */
import { createReadStream, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import type { DataChange } from '@agent/core'

import { EVENTS } from '../../shared/channels'
import { cardsDelta, dropsChatNudge, rememberCards, shapeChange, type CardsSnapshot } from '../../shared/device-feed'
import { RPC_EVENTS } from '../../shared/rpc-methods'
import { feedState } from './feed-state'
import { ConnectionLog, peerOf } from './conn-log'
import { compilePath, matchPath, passFrom, type CompiledPath } from './router'
import { RpcSession } from './rpc'
import type { DeviceFacts, DeviceRole, DevicesHost, DevicesRoute, DeviceToolResult, RouteReply, RpcMethod } from './types'
import { acceptUpgrade } from './ws'

const SMALL_BODY = 64 * 1024
const LARGE_BODY = 32 * 1024 * 1024

export interface DevicesServerOptions {
  keyPem: string
  certPem: string
  /** The paired device a pass belongs to, or null. */
  deviceForPass(pass: string): string | null
  /** A paired device's roles; null when it is unknown or revoked (its pass is then refused). */
  rolesOf(deviceId: string): DeviceRole[] | null
  self(): { id: string; facts: DeviceFacts }
  /** Runs one RPC call that no `addRpc` method answered (rpc.ts callAllowed). */
  callRpc(session: RpcSession, method: string, args: unknown[]): Promise<unknown>
  /** The newest change-log seq, stamped on the data events a v2 phone hears so it can ask for what it missed. */
  logSeq?(): number
  /** A device connected, said hello or went away. */
  onConnections?(): void
  /** A device was heard from (for lastSeen). */
  onSeen?(deviceId: string): void
  /** A device said hello (again): its latest facts, tools included. */
  onHello?(deviceId: string, facts: DeviceFacts): void
  log?(message: string, detail?: Record<string, unknown>): void
}

interface Mounted {
  route: DevicesRoute
  compiled: CompiledPath
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A short machine word for why (no-pass, unknown-pass, revoked), sent beside the message and logged. */
    readonly reason?: string,
  ) {
    super(message)
  }
}

/** Why a request's pass let nobody in. */
export type RefusedReason = 'no-pass' | 'unknown-pass' | 'revoked'

/** What a device is told when its pass is refused, by reason. Its app shows its own words for 401. */
export const REFUSED_MESSAGES: Record<RefusedReason, string> = {
  'no-pass': 'This device is not paired with this computer.',
  'unknown-pass': 'This computer does not know this device any more. Pair it again.',
  revoked: 'This device was taken out of this computer. Pair it again.',
}

export const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  woff: 'font/woff',
  pdf: 'application/pdf',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  zip: 'application/zip',
  csv: 'text/csv; charset=utf-8',
}

export function contentTypeFor(path: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

/** Parses a single `bytes=a-b` range against a size; null for none or one we do not serve (then the whole file). */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'bad' | null {
  if (header === undefined || header === '') return null
  const found = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (found === null) return null
  const [, a = '', b = ''] = found
  if (a === '' && b === '') return 'bad'
  let start: number
  let end: number
  if (a === '') {
    const suffix = Number(b)
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(a)
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return 'bad'
  return { start, end }
}

export class DevicesServer implements DevicesHost {
  private readonly routes: Mounted[] = []
  private readonly rpcMethods = new Map<string, RpcMethod>()
  private readonly sessions = new Set<RpcSession>()
  private server: Server | null = null
  private readonly resultListeners = new Set<(deviceId: string, id: string, result: DeviceToolResult) => void>()
  private readonly connLog: ConnectionLog

  constructor(private readonly options: DevicesServerOptions) {
    this.connLog = new ConnectionLog(options.log)
    // s11: a device answers a tool command with device.result(id, ok, value | error); whoever sent it listens.
    this.addRpc('device.result', async (deviceId, args) => {
      const [id, ok, value] = args
      if (typeof id !== 'string' || id === '' || id.length > 200) throw new Error('A result needs the command id.')
      const result: DeviceToolResult =
        ok === true ? { ok: true, value: value ?? null } : { ok: false, error: typeof value === 'string' ? value.slice(0, 2000) : 'The device could not do that.' }
      for (const listener of this.resultListeners) listener(deviceId, id, result)
      return true
    })
  }

  onDeviceResult(listener: (deviceId: string, id: string, result: DeviceToolResult) => void): () => void {
    this.resultListeners.add(listener)
    return () => {
      this.resultListeners.delete(listener)
    }
  }

  // ---- DevicesHost ----

  addRoute(route: DevicesRoute): void {
    this.routes.push({ route, compiled: compilePath(route.path) })
  }

  addRpc(name: string, method: RpcMethod): void {
    this.rpcMethods.set(name, method)
  }

  emit(deviceId: string | null, name: string, payload: unknown): void {
    for (const session of this.sessions) {
      if (session.facts === null) continue
      if (deviceId === null || session.deviceId === deviceId) session.event(name, payload)
    }
  }

  factsOf(deviceId: string): DeviceFacts | null {
    let latest: DeviceFacts | null = null
    for (const session of this.sessions) if (session.deviceId === deviceId && session.facts !== null) latest = session.facts
    return latest
  }

  isConnected(deviceId: string): boolean {
    for (const session of this.sessions) if (session.deviceId === deviceId && session.open) return true
    return false
  }

  self(): { id: string; facts: DeviceFacts } {
    return this.options.self()
  }

  // ---- for the devices service ----

  /** A main-process event: passed on to every connection when it is one devices may hear. */
  broadcast(channel: string, payload: unknown): void {
    if (!RPC_EVENTS.has(channel)) return
    for (const session of this.sessions) {
      if (session.facts === null) continue
      const out = this.shape(session.deviceId, channel, payload)
      if (out !== undefined) session.event(channel, out)
    }
  }

  /** What one device is sent of an event (undefined: nothing). A device that sent no prefs hears it whole. */
  private shape(deviceId: string, channel: string, payload: unknown): unknown {
    const prefs = feedState.prefsOf(deviceId)
    if (prefs.v < 2) return payload
    if (channel === EVENTS.chat) return dropsChatNudge(payload, prefs) ? undefined : payload
    if (channel === EVENTS.data) {
      const shaped = shapeChange(payload as DataChange, prefs)
      if (shaped === null) return undefined
      const seq = this.options.logSeq?.()
      return seq === undefined ? shaped : { ...shaped, seq }
    }
    if (channel === EVENTS.helperCards) {
      if (prefs.metered && !prefs.helpers) return undefined
      const snapshot = payload as CardsSnapshot
      const held = feedState.cardsHeld(deviceId)
      if (held === undefined) {
        feedState.setCards(deviceId, rememberCards(snapshot))
        return snapshot
      }
      const { delta, next } = cardsDelta(held, snapshot)
      feedState.setCards(deviceId, next)
      return delta === null ? undefined : { ...delta, delta: true }
    }
    return payload
  }

  added(): ReadonlyMap<string, RpcMethod> {
    return this.rpcMethods
  }

  connectedIds(): string[] {
    const ids = new Set<string>()
    for (const session of this.sessions) if (session.open) ids.add(session.deviceId)
    return [...ids]
  }

  /** Closes every connection of one device (revoked). */
  closeDevice(deviceId: string): void {
    for (const session of [...this.sessions]) if (session.deviceId === deviceId) session.close(4003, 'revoked')
  }

  /** The device a request's pass belongs to, when that device is still paired. */
  deviceFor(headers: Record<string, string | string[] | undefined>): string | null {
    const who = this.whoIs(headers)
    return 'id' in who ? who.id : null
  }

  /** The device a pass belongs to, or why it lets nobody in (for the log and the answer; never the pass itself). */
  whoIs(headers: Record<string, string | string[] | undefined>): { id: string } | { reason: RefusedReason; device?: string } {
    const pass = passFrom(headers)
    if (pass === '') return { reason: 'no-pass' }
    const id = this.options.deviceForPass(pass)
    if (id === null) return { reason: 'unknown-pass' }
    if (this.options.rolesOf(id) === null) return { reason: 'revoked', device: id }
    return { id }
  }

  get running(): boolean {
    return this.server !== null && this.server.listening
  }

  port(): number {
    const address = this.server?.address()
    return typeof address === 'object' && address !== null ? (address as AddressInfo).port : 0
  }

  start(listen: string, port: number): Promise<void> {
    if (this.server !== null) return Promise.resolve()
    const server = createServer({ key: this.options.keyPem, cert: this.options.certPem, minVersion: 'TLSv1.2' }, (req, res) => {
      void this.onRequest(req, res)
    })
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.onUpgrade(req, socket, head))
    // A device that gives up during the handshake (a pin mismatch on its side, a wrong port) shows here.
    server.on('tlsClientError', (error: Error & { code?: string }, socket: { remoteAddress?: string }) => {
      const from = peerOf(socket)
      // A peer that hangs up mid-handshake (a port scanner, a probe, a client that gave up) is one kind of event however many
      // addresses it comes from, so it is said once a minute with a count, not once per address.
      const quiet = error.code === 'ECONNRESET' || error.code === 'EPIPE'
      this.connLog.note(quiet ? `tls:${error.code}` : `tls:${error.code ?? error.message}:${from}`, 'Devices TLS handshake failed', { code: error.code ?? '', message: error.message.slice(0, 200), from })
    })
    server.on('clientError', (error: Error & { code?: string }, socket: Duplex & { remoteAddress?: string }) => {
      const from = peerOf(socket)
      if (error.code !== 'ECONNRESET') this.connLog.note(`http-bad:${error.code ?? ''}:${from}`, 'Devices bad request', { code: error.code ?? '', from })
      if (!socket.destroyed) socket.destroy()
    })
    this.server = server
    return new Promise((resolve, reject) => {
      const fail = (error: Error): void => {
        this.server = null
        reject(error)
      }
      server.once('error', fail)
      server.listen(port, listen, () => {
        server.off('error', fail)
        server.on('error', (error) => this.options.log?.('Devices server error', { message: error.message }))
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    for (const session of [...this.sessions]) session.close(1001, 'node stopping')
    this.sessions.clear()
    this.connLog.stop()
    const server = this.server
    this.server = null
    if (server === null) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  // ---- HTTP ----

  private find(method: string, path: string): { mounted: Mounted; params: Record<string, string> } | null {
    for (const mounted of this.routes) {
      if (mounted.route.method !== method) continue
      const params = matchPath(mounted.compiled, path)
      if (params !== null) return { mounted, params }
    }
    return null
  }

  private authorise(auth: DevicesRoute['auth'], headers: IncomingMessage['headers']): string | null {
    if (auth === 'none') return null
    const who = this.whoIs(headers)
    if (!('id' in who)) throw new HttpError(401, REFUSED_MESSAGES[who.reason], who.reason)
    const id = who.id
    if (auth === 'node') {
      const roles = this.options.rolesOf(id) ?? []
      if (!roles.includes('brain') && !roles.includes('hands')) throw new HttpError(403, 'Only another agent can do that.')
    }
    this.options.onSeen?.(id)
    return id
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    try {
      const url = new URL(req.url ?? '/', 'https://node.invalid')
      const method = (req.method ?? 'GET').toUpperCase()
      const found = this.find(method === 'HEAD' ? 'GET' : method, url.pathname)
      if (found === null) throw new HttpError(404, 'Not found.')
      const deviceId = this.authorise(found.mounted.route.auth, req.headers)
      const body = method === 'POST' ? await readJson(req, found.mounted.route.auth === 'none' ? SMALL_BODY : LARGE_BODY) : undefined
      const reply = await found.mounted.route.handle({
        deviceId,
        method,
        path: url.pathname,
        params: found.params,
        query: url.searchParams,
        headers: req.headers,
        body,
        signal: controller.signal,
      })
      await this.send(req, res, reply)
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      const reason = error instanceof HttpError ? error.reason : undefined
      if (status === 500) this.options.log?.('Devices request failed', { message: error instanceof Error ? error.message : String(error) })
      if (status === 401 || status === 403) {
        const from = peerOf(req.socket)
        this.connLog.note(`http:${status}:${reason ?? ''}:${from}`, 'Devices request refused', { status, reason: reason ?? 'not allowed', path: safePath(req.url), from })
      }
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Something went wrong on the node.' : (error as Error).message, ...(reason !== undefined ? { reason } : {}) })
      else res.destroy()
    }
  }

  private async send(req: IncomingMessage, res: ServerResponse, reply: RouteReply): Promise<void> {
    for (const [name, value] of Object.entries(reply.headers ?? {})) res.setHeader(name, value)
    if ('json' in reply) {
      sendJson(res, reply.status, reply.json)
      return
    }
    if ('text' in reply) {
      const bytes = Buffer.from(reply.text, 'utf8')
      res.writeHead(reply.status, { 'Content-Type': reply.contentType ?? 'text/plain; charset=utf-8', 'Content-Length': bytes.length })
      res.end(req.method === 'HEAD' ? undefined : bytes)
      return
    }
    const info = statSync(reply.file, { throwIfNoEntry: false })
    if (info === undefined || !info.isFile()) throw new HttpError(404, 'That file is not on this computer.')
    const type = reply.contentType ?? contentTypeFor(reply.file)
    const range = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, info.size)
    if (range === 'bad') {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
      res.end()
      return
    }
    const headers: Record<string, string | number> = { 'Content-Type': type, 'Accept-Ranges': 'bytes' }
    if (range === null) {
      res.writeHead(reply.status, { ...headers, 'Content-Length': info.size })
    } else {
      res.writeHead(206, { ...headers, 'Content-Length': range.end - range.start + 1, 'Content-Range': `bytes ${range.start}-${range.end}/${info.size}` })
    }
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    await new Promise<void>((resolve) => {
      const stream = createReadStream(reply.file, range === null ? {} : { start: range.start, end: range.end })
      stream.on('error', () => {
        res.destroy()
        resolve()
      })
      stream.on('end', () => resolve())
      stream.pipe(res)
    })
  }

  // ---- WebSocket ----

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'https://node.invalid')
    const from = peerOf(req.socket)
    if (url.pathname !== '/v1/rpc') {
      this.connLog.note(`ws-404:${from}`, 'Devices link refused', { reason: 'not-found', path: safePath(req.url), from })
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }
    const who = this.whoIs(req.headers)
    if (!('id' in who)) {
      // Say why, in the log and to the device: an old pass after a reset, a revoked device, or no pass at all.
      this.connLog.note(`ws-401:${who.reason}:${from}`, 'Devices link refused', { reason: who.reason, ...(who.device !== undefined ? { device: who.device } : {}), from })
      const body = JSON.stringify({ error: REFUSED_MESSAGES[who.reason], reason: who.reason })
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\n' +
          `X-Agent-Refused: ${who.reason}\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      )
      return
    }
    const deviceId = who.id
    const conn = acceptUpgrade(req, socket, head)
    if (conn === null) {
      this.connLog.note(`ws-400:${from}`, 'Devices link refused', { reason: 'not-a-websocket', device: deviceId, from })
      return
    }
    this.options.onSeen?.(deviceId)
    const openedAt = Date.now()
    this.connLog.note(`ws-open:${deviceId}`, 'Device connected', { device: deviceId, from, deflate: conn.deflate })
    const session = new RpcSession(conn, {
      deviceId,
      call: (from, method, args) => this.options.callRpc(from, method, args),
      onHello: (hello) => {
        if (hello.facts !== null) this.options.onHello?.(deviceId, hello.facts)
        this.options.onSeen?.(deviceId)
        this.options.onConnections?.()
      },
      onClose: (closed, code) => {
        this.sessions.delete(closed)
        if (![...this.sessions].some((other) => other.deviceId === deviceId)) feedState.clear(deviceId)
        this.connLog.linkEnded(deviceId, Date.now() - openedAt, { code, hello: closed.facts !== null, from })
        this.options.onConnections?.()
      },
    })
    this.sessions.add(session)
    this.options.onConnections?.()
  }
}

/** A request path for the log, without its query (a pass may ride in one). */
function safePath(url: string | undefined): string {
  return (url ?? '/').split('?')[0]?.slice(0, 120) ?? '/'
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const bytes = Buffer.from(JSON.stringify(value ?? null), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
  res.end(bytes)
}

function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        reject(new HttpError(413, 'That is too big to send.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (size === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'The body is not JSON.'))
      }
    })
    req.on('error', reject)
  })
}
