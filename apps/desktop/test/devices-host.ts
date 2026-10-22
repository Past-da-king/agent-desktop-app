/**
 * A small DevicesHost over real local HTTP for the Devices tests (workstream B). The real node server (TLS, pairing,
 * RPC over WebSocket) is devices/server.ts; this one only routes, checks the bearer pass, and records events, which
 * is all the replication, bundle and command modules need from it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'

import type { DeviceFacts, DevicesHost, DevicesRoute, RpcMethod } from '../src/main/devices/types'

export interface TestHost extends DevicesHost {
  url: string
  /** pass -> deviceId of who holds it; `node` marks it as a node pass. */
  passes: Map<string, { deviceId: string; node: boolean }>
  events: Array<{ deviceId: string | null; name: string; payload: unknown }>
  connected: Set<string>
  facts: Map<string, DeviceFacts>
  rpc: Map<string, RpcMethod>
  /** Requests answered, by path. */
  hits: Map<string, number>
  /** Turn the node "off the network": every request gets a dropped connection. */
  down: boolean
  close(): Promise<void>
}

export function facts(name: string, patch: Partial<DeviceFacts> = {}): DeviceFacts {
  return {
    name,
    kind: 'desktop',
    platform: 'linux',
    appVersion: '0.0.0',
    screen: { width: 1280, height: 800 },
    canOpenLinks: true,
    canReceiveFiles: true,
    fingerprint: '',
    urls: [],
    ...patch,
  }
}

export async function startTestHost(selfId: string, selfFacts: DeviceFacts = facts(selfId), tls?: { key: string; cert: string }): Promise<TestHost> {
  const routes: DevicesRoute[] = []
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res)
  }
  const server: Server = tls === undefined ? createServer(onRequest) : createHttpsServer({ key: tls.key, cert: tls.cert }, onRequest)

  const host: TestHost = {
    url: '',
    passes: new Map(),
    events: [],
    connected: new Set(),
    facts: new Map(),
    rpc: new Map(),
    hits: new Map(),
    down: false,
    addRoute(route) {
      routes.push(route)
    },
    addRpc(name, method) {
      host.rpc.set(name, method)
    },
    emit(deviceId, name, payload) {
      host.events.push({ deviceId, name, payload })
    },
    factsOf(deviceId) {
      return host.facts.get(deviceId) ?? null
    },
    isConnected(deviceId) {
      return host.connected.has(deviceId)
    },
    self() {
      return { id: selfId, facts: selfFacts }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (host.down) {
      req.socket.destroy()
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = routes.map((route) => ({ route, params: matchPath(route.path, url.pathname) })).find((m) => m.route.method === req.method && m.params !== null)
    if (match === undefined || match.params === null) {
      send(res, 404, { error: { message: 'not found' } })
      return
    }
    let deviceId: string | null = null
    if (match.route.auth !== 'none') {
      const header = req.headers.authorization ?? ''
      const pass = header.startsWith('Bearer ') ? header.slice(7) : ''
      const who = host.passes.get(pass)
      if (who === undefined || (match.route.auth === 'node' && !who.node)) {
        send(res, 401, { error: { message: 'not paired' } })
        return
      }
      deviceId = who.deviceId
    }
    const text = await readBody(req)
    let body: unknown
    try {
      body = text === '' ? undefined : (JSON.parse(text) as unknown)
    } catch {
      body = undefined
    }
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    host.hits.set(url.pathname, (host.hits.get(url.pathname) ?? 0) + 1)
    const reply = await match.route.handle({
      deviceId,
      method: req.method ?? 'GET',
      path: url.pathname,
      params: match.params,
      query: url.searchParams,
      headers: req.headers,
      body,
      signal: controller.signal,
    })
    if ('json' in reply) send(res, reply.status, reply.json)
    else if ('text' in reply) {
      res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'text/plain' })
      res.end(reply.text)
    } else {
      res.writeHead(reply.status)
      res.end()
    }
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  host.url = `${tls === undefined ? 'http' : 'https'}://127.0.0.1:${address.port}`
  return host
}

function matchPath(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split('/')
  const b = path.split('/')
  if (a.length !== b.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < a.length; i++) {
    const part = a[i] ?? ''
    const value = b[i] ?? ''
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(value)
    else if (part !== value) return null
  }
  return params
}

function send(res: ServerResponse, status: number, json: unknown): void {
  if (res.headersSent || res.destroyed) return
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(json))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}
