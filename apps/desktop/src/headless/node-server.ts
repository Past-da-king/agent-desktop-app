/**
 * SEAM to workstream A's node server (devices/server.ts).
 *
 * `startNodeServer` is what the headless node calls once the runtime is up. Until A's server is merged it runs this
 * basic HTTPS server: the real certificate, the real port and listen address, `GET /v1/health` exactly as the
 * protocol (s5) says, plus a small route table that A's parts can plug into through the same `DevicesHost` shape
 * (addRoute / addRpc / emit). Every other path answers 404. At merge the lead swaps the body of `startNodeServer` for
 * A's server, passing the same deps; nothing else in the headless node changes.
 */
import { createServer, type Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'

import type { DevicesHost, DevicesRoute, DeviceFacts, RpcMethod } from '../main/devices/types'
import type { NodeCert, NodeConfig } from './node-config'
import type { HeadlessRuntime } from './runtime'

export interface NodeServerDeps {
  runtime: HeadlessRuntime
  config: NodeConfig
  cert: NodeCert
  version: string
}

export interface RunningNode {
  /** Every address this node believes reachable, as https URLs (protocol s2). */
  urls: string[]
  port: number
  host: DevicesHost
  close(): Promise<void>
}

export function selfFacts(config: NodeConfig, version: string, urls: string[], fp: string): DeviceFacts {
  return {
    name: config.name,
    kind: 'server',
    platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    appVersion: version,
    screen: { width: 0, height: 0 },
    canOpenLinks: false,
    canReceiveFiles: false,
    fingerprint: fp,
    urls,
  }
}

/** Ready = some AI account can run a turn now: a plan, or an API account with its key. */
export function canRunTurns(runtime: HeadlessRuntime): boolean {
  const accounts = runtime.accounts.all()
  if (accounts.some((a) => a.kind !== 'api' || a.hasKey)) return true
  return runtime.settings.get().hasKey
}

export function advertisedUrls(config: NodeConfig, port: number): string[] {
  const urls: string[] = []
  const loopbackOnly = config.listen === '127.0.0.1' || config.listen === '::1' || config.listen === 'localhost'
  if (!loopbackOnly) {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.internal) continue
        urls.push(net.family === 'IPv6' ? `https://[${net.address}]:${port}` : `https://${net.address}:${port}`)
      }
    }
  }
  return [...new Set([...config.publicUrls, ...urls])]
}

export async function startNodeServer(deps: NodeServerDeps): Promise<RunningNode> {
  const { runtime, config, cert, version } = deps
  const routes: DevicesRoute[] = []
  const rpcs = new Map<string, RpcMethod>()

  const health = (): unknown => ({
    id: config.id,
    name: config.name,
    version,
    roles: ['brain', 'hands'],
    ready: canRunTurns(runtime),
    busy: runtime.busy(),
    meshId: config.meshId,
  })

  const server: Server = createServer({ cert: cert.cert, key: cert.key, minVersion: 'TLSv1.2' }, (req, res) => {
    void handle(req, res).catch((error: unknown) => {
      runtime.logger.warn('Node request failed', { message: error instanceof Error ? error.message : String(error) })
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong on this node.' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'https://node.invalid')
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      send(res, 200, health())
      return
    }
    for (const route of routes) {
      if (route.method !== req.method) continue
      const params = match(route.path, url.pathname)
      if (params === null) continue
      // Device auth arrives with A's server (pass hashes from the bundle); until then only open routes are served.
      if (route.auth !== 'none') {
        send(res, 401, { error: 'Sign in with a device pass.' })
        return
      }
      const controller = new AbortController()
      req.on('close', () => controller.abort())
      const body = req.method === 'POST' ? await readJson(req) : undefined
      const reply = await route.handle({
        deviceId: null,
        method: req.method,
        path: url.pathname,
        params,
        query: url.searchParams,
        headers: req.headers,
        body,
        signal: controller.signal,
      })
      if ('json' in reply) send(res, reply.status, reply.json)
      else if ('text' in reply) {
        res.writeHead(reply.status, { 'content-type': reply.contentType ?? 'text/plain; charset=utf-8' })
        res.end(reply.text)
      } else send(res, 404, { error: 'Files are served once the full node server is in.' })
      return
    }
    send(res, 404, { error: 'not available on this device' })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.listen, () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : config.port
  const urls = advertisedUrls(config, port)

  const host: DevicesHost = {
    addRoute: (route) => routes.push(route),
    addRpc: (name, method) => rpcs.set(name, method),
    emit: () => undefined,
    factsOf: () => null,
    isConnected: () => false,
    self: () => ({ id: config.id, facts: selfFacts(config, version, urls, cert.fp) }),
  }

  return {
    urls,
    port,
    host,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}

function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    const part = want[i] ?? ''
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(got[i] ?? '')
    else if (part !== got[i]) return null
  }
  return params
}

function send(res: ServerResponse, status: number, json: unknown): void {
  const text = JSON.stringify(json)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 1024 * 1024) throw new Error('Request too large.')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}
