/**
 * Reaching another node through a SOCKS5 proxy (RFC 1928, no authentication, CONNECT). Some machines can only reach
 * the person's other devices that way, e.g. a server whose mesh VPN runs in userspace and offers a local SOCKS5
 * port. The TLS (and the certificate pin) still runs end to end on top: the proxy only sees encrypted bytes.
 */
import { Agent } from 'node:https'
import { connect, isIP, type Socket } from 'node:net'
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls'

import { getOverlayNet } from './net'

export interface SocksProxy {
  host: string
  port: number
}

/** True for this machine's own addresses: those never go through a proxy. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127\./.test(h)
}

/** "socks5://host:port" (or socks5h://) to a proxy, null for anything else or empty. */
export function parseSocksProxy(raw: string | undefined): SocksProxy | null {
  const text = (raw ?? '').trim()
  if (text === '') return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'socks5:' && url.protocol !== 'socks5h:') return null
  const port = Number(url.port || '1080')
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port }
}

export function socksConnect(proxy: SocksProxy, host: string, port: number, timeoutMs = 15_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: proxy.host, port: proxy.port })
    let stage: 'greet' | 'connect' = 'greet'
    let buffered = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error(`The proxy did not connect to ${host} in ${Math.round(timeoutMs / 1000)} s.`)), timeoutMs)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.destroy()
      reject(error)
    }
    socket.once('error', (error) => fail(new Error(`The proxy could not be reached: ${error.message}`)))
    socket.once('connect', () => socket.write(Buffer.from([0x05, 0x01, 0x00])))
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk])
      if (stage === 'greet') {
        if (buffered.length < 2) return
        if (buffered[0] !== 0x05 || buffered[1] !== 0x00) return fail(new Error('The proxy wants a sign-in, which is not supported.'))
        buffered = buffered.subarray(2)
        stage = 'connect'
        socket.write(connectRequest(host, port))
        if (buffered.length === 0) return
      }
      // VER REP RSV ATYP BND.ADDR BND.PORT
      if (buffered.length < 5) return
      if (buffered[1] !== 0x00) return fail(new Error(`The proxy could not reach ${host}:${port} (code ${buffered[1] ?? 0}).`))
      const atyp = buffered[3]
      const addrLength = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? 1 + (buffered[4] ?? 0) : -1
      if (addrLength < 0) return fail(new Error('The proxy answered in a way this app does not read.'))
      const total = 4 + addrLength + 2
      if (buffered.length < total) return
      clearTimeout(timer)
      socket.off('data', onData)
      socket.removeAllListeners('error')
      // Anything after the reply belongs to the tunnelled connection.
      const rest = buffered.subarray(total)
      if (rest.length > 0) socket.unshift(rest)
      resolve(socket)
    }
    socket.on('data', onData)
  })
}

function connectRequest(host: string, port: number): Buffer {
  const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff])
  const kind = isIP(host)
  if (kind === 4) return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x01]), Buffer.from(host.split('.').map(Number)), portBytes])
  if (kind === 6) {
    const parts = expandIpv6(host)
    return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), Buffer.from(parts.flatMap((p) => [(p >> 8) & 0xff, p & 0xff])), portBytes])
  }
  const name = Buffer.from(host, 'utf8')
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBytes])
}

function expandIpv6(address: string): number[] {
  const [head = '', tail = ''] = address.split('::')
  const a = head === '' ? [] : head.split(':')
  const b = tail === '' ? [] : tail.split(':')
  const middle = new Array<string>(8 - a.length - b.length).fill('0')
  return [...a, ...(address.includes('::') ? middle : []), ...b].map((part) => parseInt(part || '0', 16))
}

/** The proxy this app reaches other devices through, if any (`AGENT_NODE_PROXY`, or set by the headless node). */
let current: SocksProxy | null = parseSocksProxy(process.env['AGENT_NODE_PROXY'])

export function setDevicesProxy(next: SocksProxy | null): void {
  current = next
}

export function devicesProxy(): SocksProxy | null {
  return current
}

/**
 * The proxy a connection to `host` goes through, or null for a direct one. Loopback: never. A proxy the person set
 * (agent-node config --proxy, AGENT_NODE_PROXY): always, it wins. Otherwise the built-in overlay's own SOCKS port
 * (devices/net.ts) for overlay hosts the computer cannot route itself (Network = Tailscale or Headscale).
 */
export function proxyFor(host: string): SocksProxy | null {
  const h = host.replace(/^\[|\]$/g, '')
  if (h === '' || isLoopbackHost(h)) return null
  if (current !== null) return current
  const net = getOverlayNet()
  if (net === null || !net.shouldProxy(h)) return null
  return parseSocksProxy(`socks5://${net.socksAddress() ?? ''}`)
}

/**
 * For https.request: an Agent that opens each connection through the proxy, or false for a direct connection (as
 * before). TLS and the pin check still run on the socket the request gets, so 'secureConnect' fires as usual.
 */
export function proxyAgent(host = ''): Agent | false {
  // With a host: the proxy for that host (proxyFor). Without one (older callers): only the person's own proxy.
  const proxy = host === '' ? current : proxyFor(host)
  if (proxy === null) return false
  return proxiedAgent(proxy, false)
}

/**
 * For the replication and health links between nodes: an Agent that keeps its connections open and hands them to the
 * next request to the same address, direct or through the proxy for that host. Each request on a relayed overlay path
 * (Tailscale through DERP, ~200 ms a round trip) used to open a new TCP and TLS connection, about 20 a minute when
 * the agent was busy, and a share of those handshakes timed out in a userspace VPN (29 Oct 2026). One pooled
 * connection per peer stays up instead. Callers must check the pin on every request, a reused socket included
 * (pinned-fetch.ts does).
 */
export function keptAgent(host: string): Agent {
  const proxy = proxyFor(host)
  const key = proxy === null ? 'direct' : JSON.stringify(proxy)
  const known = kept.get(key)
  if (known !== undefined) return known
  const agent = proxy === null ? new Agent(KEPT_OPTIONS) : proxiedAgent(proxy, true)
  kept.set(key, agent)
  return agent
}

/** Close every kept connection (a node stopping, a test ending). */
export function closeKeptAgents(): void {
  for (const agent of kept.values()) agent.destroy()
  kept.clear()
}

// No TLS session cache: a resumed session carries no peer certificate, so the pin could not be checked on it.
const KEPT_OPTIONS = { keepAlive: true, keepAliveMsecs: 15_000, maxSockets: 6, maxFreeSockets: 2, maxCachedSessions: 0, timeout: 60_000, scheduling: 'lifo' as const }
const kept = new Map<string, Agent>()

function proxiedAgent(proxy: SocksProxy, keepAlive: boolean): Agent {
  const agent = new Agent(keepAlive ? KEPT_OPTIONS : { keepAlive: false })
  ;(agent as unknown as { createConnection: unknown }).createConnection = (
    options: ConnectionOptions & { host?: string; port?: number },
    done: (error: Error | null, socket?: Socket) => void,
  ): undefined => {
    const host = (options.host ?? 'localhost').replace(/^\[|\]$/g, '')
    if (isLoopbackHost(host)) {
      done(null, tlsConnect({ ...options, host }))
      return undefined
    }
    socksConnect(proxy, host, Number(options.port ?? 443)).then(
      (raw) => done(null, tlsConnect({ ...options, socket: raw })),
      (error: Error) => done(error),
    )
    return undefined
  }
  return agent
}
