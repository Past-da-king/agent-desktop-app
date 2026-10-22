/**
 * Optional overlay network for Devices (docs/devices-protocol.md s10). When the person picks Network = Tailscale or
 * Headscale in Settings > Devices, this starts the `agent-net` sidecar (tools/agent-net, Go + tsnet) as a child
 * process. The sidecar joins the overlay in user space (no system VPN, no admin rights), forwards overlay TCP on the
 * node port to this node's server on loopback, and runs a local SOCKS5 proxy that dials through the overlay.
 *
 * Nothing depends on it: with Network = None (the default), or when the sidecar is missing or fails, LAN and direct
 * addresses work exactly as before. The auth key lives only in the secrets module; it reaches the sidecar on stdin,
 * never in argv, env or logs.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { connect as netConnect, isIP, isIPv4, type Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { connect as tlsConnect, type ConnectionOptions, type TLSSocket } from 'node:tls'

import type { DevicesNetwork, NetworkMode } from '@agent/core'

import type { SecretsLike } from './passes'

export type { DevicesNetwork, NetworkMode }

/** The secrets-module name of the overlay auth key. */
export const NET_AUTHKEY_SECRET = 'devicesNetAuthKey'

export interface NetSettings {
  network: NetworkMode
  /** Control server for Headscale (https URL). Ignored for Tailscale. */
  controlUrl: string
}

export const DEFAULT_NET_SETTINGS: NetSettings = { network: 'none', controlUrl: '' }

/** A control-server URL: http(s), a host, no credentials. Plain http is allowed only for loopback (a local test). */
export function cleanControlUrl(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const text = raw.trim()
  if (text === '' || text.length > 300) return ''
  let url: URL
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return ''
  }
  if (url.username !== '' || url.password !== '' || url.hostname === '') return ''
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return ''
  return url.origin
}

export function cleanNetSettings(raw: unknown): NetSettings {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const network: NetworkMode = value['network'] === 'tailscale' || value['network'] === 'headscale' ? value['network'] : 'none'
  return { network, controlUrl: cleanControlUrl(value['controlUrl']) }
}

/** A name the overlay accepts: lower case letters, digits and dashes, at most 63. */
export function overlayHostname(name: string): string {
  const clean = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '')
  return clean === '' ? 'agent-node' : clean
}

// ---- the sidecar binary ----

const GOOS: Record<string, string> = { win32: 'windows', darwin: 'darwin', linux: 'linux' }
const GOARCH: Record<string, string> = { x64: 'amd64', arm64: 'arm64' }

/** The file name of the sidecar as built (tools/agent-net/build.sh). */
export function sidecarBuildName(platform: string = process.platform, arch: string = process.arch): string | null {
  const os = GOOS[platform]
  const cpu = GOARCH[arch]
  if (os === undefined || cpu === undefined) return null
  return `agent-net-${os}-${cpu}${platform === 'win32' ? '.exe' : ''}`
}

export interface SidecarLookup {
  /** `process.resourcesPath` in a packaged Electron app. */
  resourcesPath?: string
  /** More folders to look in (next to the headless bundle; the repo in development). */
  dirs?: string[]
  env?: NodeJS.ProcessEnv
  platform?: string
  arch?: string
  exists?: (path: string) => boolean
}

/**
 * Where the sidecar is: AGENT_NET_PATH, then `<resources>/agent-net/agent-net[.exe]` (electron-builder
 * extraResources), then each folder in `dirs` (plain name, then the build name, then `tools/agent-net/dist/`).
 */
export function findSidecar(lookup: SidecarLookup = {}): string | null {
  const env = lookup.env ?? process.env
  const platform = lookup.platform ?? process.platform
  const exists = lookup.exists ?? existsSync
  const plain = platform === 'win32' ? 'agent-net.exe' : 'agent-net'
  const built = sidecarBuildName(platform, lookup.arch ?? process.arch)
  const candidates: string[] = []
  const fromEnv = env['AGENT_NET_PATH']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') candidates.push(fromEnv.trim())
  if (lookup.resourcesPath !== undefined && lookup.resourcesPath !== '') candidates.push(join(lookup.resourcesPath, 'agent-net', plain))
  for (const dir of lookup.dirs ?? []) {
    candidates.push(join(dir, plain))
    if (built !== null) {
      candidates.push(join(dir, built))
      candidates.push(join(dir, 'tools', 'agent-net', 'dist', built))
    }
  }
  return candidates.find((path) => exists(path)) ?? null
}

// ---- the sidecar's status lines ----

export interface SidecarPeer {
  name: string
  dnsName: string
  ips: string[]
  online: boolean
}

export interface SidecarStatus {
  state: string
  authURL: string
  tailnetIPs: string[]
  dnsName: string
  socks: string
  peers: SidecarPeer[]
}

export type SidecarLine =
  | { type: 'status'; status: SidecarStatus }
  | { type: 'error'; error: string }
  | { type: 'exit' }

const strings = (raw: unknown, max = 16): string[] =>
  Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string' && item.length <= 300).slice(0, max) : []
const str = (raw: unknown): string => (typeof raw === 'string' && raw.length <= 2000 ? raw : '')

/** One stdout line from the sidecar, checked; null for anything else (it never throws). */
export function parseSidecarLine(line: string): SidecarLine | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const obj = value as Record<string, unknown>
  if (obj['type'] === 'exit') return { type: 'exit' }
  if (obj['type'] === 'error') return { type: 'error', error: str(obj['error']).slice(0, 300) || 'The network helper stopped.' }
  if (obj['type'] !== 'status') return null
  const peers: SidecarPeer[] = []
  if (Array.isArray(obj['peers'])) {
    for (const raw of obj['peers'].slice(0, 500)) {
      if (typeof raw !== 'object' || raw === null) continue
      const peer = raw as Record<string, unknown>
      peers.push({ name: str(peer['name']), dnsName: str(peer['dnsName']), ips: strings(peer['ips']), online: peer['online'] === true })
    }
  }
  const authURL = str(obj['authURL'])
  return {
    type: 'status',
    status: {
      state: str(obj['state']) || 'NoState',
      authURL: /^https?:\/\//i.test(authURL) ? authURL : '',
      tailnetIPs: strings(obj['tailnetIPs']).filter((ip) => isIP(ip) !== 0),
      dnsName: str(obj['dnsName']).replace(/\.$/, ''),
      socks: /^127\.0\.0\.1:\d{1,5}$/.test(str(obj['socks'])) ? str(obj['socks']) : '',
      peers,
    },
  }
}

// ---- which hosts are on the overlay ----

function v4Number(ip: string): number {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
}

/** 100.64.0.0/10 (the overlay's IPv4 range) or fd7a:115c:a1e0::/48 (its IPv6 range). */
export function isOverlayIp(raw: string): boolean {
  const ip = raw.replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  if (isIPv4(ip)) {
    const n = v4Number(ip)
    return n >= v4Number('100.64.0.0') && n <= v4Number('100.127.255.255')
  }
  return isIP(ip) === 6 && /^fd7a:115c:a1e0:/i.test(ip)
}

/** An overlay address, a *.ts.net name, or a name under the overlay's own DNS suffix (Headscale's base domain). */
export function isOverlayHost(host: string, dnsSuffix = ''): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (isIP(h) !== 0) return isOverlayIp(h)
  if (h.endsWith('.ts.net')) return true
  const suffix = dnsSuffix.toLowerCase().replace(/^\.+|\.$/g, '')
  return suffix !== '' && h.endsWith(`.${suffix}`)
}

/**
 * True when the computer itself is on an overlay (the regular Tailscale app runs): an interface holds an address in
 * the overlay's IPv6 range, or a 100.64/10 address on an interface named like one. Then the OS routes overlay
 * addresses and names itself, and no proxy is needed.
 */
export function osHasOverlayRoute(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): boolean {
  for (const [name, list] of Object.entries(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal) continue
      const v6 = entry.family === 'IPv6' || (entry.family as unknown) === 6
      if (v6 && /^fd7a:115c:a1e0:/i.test(entry.address)) return true
      if (!v6 && isOverlayIp(entry.address) && /tailscale|utun|^ts\d|wg/i.test(name)) return true
    }
  }
  return false
}

/** The DNS suffix of the overlay from this node's own name: "box.example.ts.net" gives "example.ts.net". */
export function dnsSuffixOf(dnsName: string): string {
  const at = dnsName.indexOf('.')
  return at < 0 ? '' : dnsName.slice(at + 1)
}

// ---- SOCKS5 client ----

/** Opens a TCP stream to host:port through a SOCKS5 proxy (no auth, CONNECT). Names are resolved by the proxy. */
export function socksConnect(proxy: string, host: string, port: number, timeoutMs = 20_000): Promise<Socket> {
  const [proxyHost, proxyPortText] = splitHostPort(proxy)
  return new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: proxyHost, port: Number(proxyPortText) })
    let stage = 0
    let buffer = Buffer.alloc(0)
    const timer = setTimeout(() => fail(new Error('The overlay did not answer in time.')), timeoutMs)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.destroy()
      reject(error)
    }
    const target = host.replace(/^\[|\]$/g, '')
    const request = (): Buffer => {
      const portBytes = Buffer.from([(port >> 8) & 0xff, port & 0xff])
      if (isIPv4(target)) return Buffer.concat([Buffer.from([5, 1, 0, 1]), Buffer.from(target.split('.').map(Number)), portBytes])
      if (isIP(target) === 6) return Buffer.concat([Buffer.from([5, 1, 0, 4]), ipv6Bytes(target), portBytes])
      const name = Buffer.from(target, 'utf8')
      if (name.length > 255) throw new Error('That name is too long.')
      return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes])
    }
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      if (stage === 0) {
        if (buffer.length < 2) return
        if (buffer[0] !== 5 || buffer[1] !== 0) return fail(new Error('The overlay proxy refused the connection.'))
        buffer = buffer.subarray(2)
        stage = 1
        try {
          socket.write(request())
        } catch (error) {
          return fail(error as Error)
        }
      }
      if (stage === 1) {
        if (buffer.length < 5) return
        if (buffer[0] !== 5) return fail(new Error('The overlay proxy answered oddly.'))
        if (buffer[1] !== 0) return fail(new Error('That device could not be reached over the overlay.'))
        const type = buffer[3]
        const length = type === 1 ? 10 : type === 4 ? 22 : type === 3 ? 7 + (buffer[4] ?? 0) : 10
        if (buffer.length < length) return
        clearTimeout(timer)
        socket.removeListener('data', onData)
        const rest = buffer.subarray(length)
        if (rest.length > 0) socket.unshift(rest)
        stage = 2
        resolve(socket)
      }
    }
    socket.on('data', onData)
    socket.once('error', (error) => {
      if (stage < 2) fail(error)
    })
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])))
  })
}

function splitHostPort(addr: string): [string, string] {
  const at = addr.lastIndexOf(':')
  return [addr.slice(0, at).replace(/^\[|\]$/g, ''), addr.slice(at + 1)]
}

function ipv6Bytes(ip: string): Buffer {
  const [head = '', tail = ''] = ip.split('::')
  const parts = (s: string): string[] => (s === '' ? [] : s.split(':'))
  const h = parts(head)
  const t = parts(tail)
  const groups = ip.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2))
  return out
}

// ---- the sidecar process ----

export interface SpawnLike {
  (command: string, args: string[], options: SpawnOptions): ChildProcess
}

export interface OverlayNetDeps {
  /** `<userData>/devices`; the overlay keeps `net.json` and its node state in `net/` there. */
  dir: string
  secrets: SecretsLike
  /** The sidecar's path, or null when this build has none. */
  binary: () => string | null
  /** This node's name; the overlay hostname is made from it. */
  nodeName: () => string
  /** Something about the overlay changed (state, addresses). */
  onChange: () => void
  log?: (message: string, detail?: Record<string, unknown>) => void
  spawn?: SpawnLike
  /** Restart delays after a crash, ms (tests shorten them). */
  backoffMs?: number[]
  /** The computer's interfaces (tests pass their own). */
  interfaces?: () => ReturnType<typeof networkInterfaces>
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000]

export class OverlayNet {
  private settings: NetSettings
  private child: ChildProcess | null = null
  private sidecar: SidecarStatus | null = null
  private error = ''
  /** The child is wanted for this port (null = not wanted). */
  private wantPort: number | null = null
  /** What the running child was started with, to know when a restart is needed. */
  private runningKey = ''
  private crashes = 0
  private restartTimer: NodeJS.Timeout | null = null
  private readonly file: string

  constructor(private readonly deps: OverlayNetDeps) {
    this.file = join(deps.dir, 'net.json')
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      raw = null
    }
    this.settings = cleanNetSettings(raw)
  }

  getSettings(): NetSettings {
    return { ...this.settings }
  }

  hasKey(): boolean {
    const key = this.deps.secrets.get(NET_AUTHKEY_SECRET)
    return key !== null && key.trim() !== ''
  }

  /**
   * Saves the person's choice. `authKey`: a new key replaces the old one, '' leaves it, null removes it.
   * Throws a plain sentence when the choice cannot work (Headscale without a usable URL).
   */
  save(input: { network: NetworkMode; controlUrl?: string; authKey?: string | null }): NetSettings {
    const next = cleanNetSettings({ network: input.network, controlUrl: input.controlUrl ?? this.settings.controlUrl })
    if (next.network === 'headscale' && next.controlUrl === '') throw new Error('Add the address of your Headscale server, like https://headscale.example.com.')
    if (input.authKey === null) this.deps.secrets.delete(NET_AUTHKEY_SECRET)
    else if (typeof input.authKey === 'string' && input.authKey.trim() !== '') {
      const key = input.authKey.trim()
      if (key.length > 500 || /\s/.test(key)) throw new Error('That auth key does not look right. Paste it again.')
      this.deps.secrets.set(NET_AUTHKEY_SECRET, key)
    }
    const wasOn = this.settings.network !== 'none'
    this.settings = next
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(next, null, 2), 'utf8')
    renameSync(`${this.file}.tmp`, this.file)
    // Switching the overlay off by choice logs this node out, so it leaves the tailnet.
    if (wasOn && next.network === 'none' && this.child !== null) this.stopChild('logout')
    return this.getSettings()
  }

  /** Starts, restarts or stops the sidecar to match the settings. `port`: the node server's port, or null when off. */
  apply(port: number | null): void {
    this.wantPort = this.settings.network === 'none' ? null : port
    if (this.wantPort === null) {
      this.cancelRestart()
      if (this.child !== null) this.stopChild('quit')
      this.sidecar = null
      if (this.settings.network === 'none') this.error = ''
      this.deps.onChange()
      return
    }
    const key = this.startKey(this.wantPort)
    if (this.child !== null && key === this.runningKey) return
    if (this.child !== null) this.stopChild('quit')
    this.crashes = 0
    this.startChild()
  }

  /** Stops the sidecar (app quit); the node stays logged in for next time. Resolves when it has exited. */
  async stop(): Promise<void> {
    this.wantPort = null
    this.cancelRestart()
    const child = this.child
    if (child === null) return
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    this.stopChild('quit')
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 6_000))])
  }

  status(): DevicesNetwork {
    const s = this.sidecar
    const available = this.deps.binary() !== null
    let state: DevicesNetwork['state'] = 'off'
    if (this.settings.network !== 'none') {
      if (this.error !== '') state = 'error'
      else if (this.wantPort === null) state = 'off'
      else if (s === null) state = 'starting'
      else if (s.state === 'Running') state = 'running'
      else if (s.state === 'NeedsLogin' || s.state === 'NeedsMachineAuth') state = 'needs-login'
      else state = 'starting'
    }
    return {
      mode: this.settings.network,
      controlUrl: this.settings.controlUrl,
      state,
      available,
      hasKey: this.hasKey(),
      addresses: state === 'running' && s !== null ? [...s.tailnetIPs] : [],
      dnsName: state === 'running' && s !== null ? s.dnsName : '',
      peers: state === 'running' && s !== null ? s.peers.length : 0,
      authUrl: state === 'needs-login' && s !== null ? s.authURL : '',
      error: this.error,
    }
  }

  /** The overlay addresses this node is reachable on, as https URLs on the node port (IPv4, name, IPv6). */
  urls(port: number): string[] {
    const s = this.sidecar
    if (s === null || s.state !== 'Running') return []
    const out: string[] = []
    for (const ip of s.tailnetIPs) if (isIPv4(ip)) out.push(`https://${ip}:${port}`)
    if (s.dnsName !== '') out.push(`https://${s.dnsName}:${port}`)
    for (const ip of s.tailnetIPs) if (!isIPv4(ip)) out.push(`https://[${ip}]:${port}`)
    return out
  }

  /** The local SOCKS5 address while the overlay runs, else null. */
  socksAddress(): string | null {
    const s = this.sidecar
    return s !== null && s.state === 'Running' && s.socks !== '' ? s.socks : null
  }

  /** True when a connection to `host` should go through the sidecar: an overlay host the OS cannot route itself. */
  shouldProxy(host: string, interfaces?: ReturnType<typeof networkInterfaces>): boolean {
    if (this.socksAddress() === null) return false
    if (!isOverlayHost(host, dnsSuffixOf(this.sidecar?.dnsName ?? ''))) return false
    return !osHasOverlayRoute(interfaces ?? this.deps.interfaces?.())
  }

  // ---- inside ----

  private startKey(port: number): string {
    const key = this.deps.secrets.get(NET_AUTHKEY_SECRET) ?? ''
    // The key itself is not kept here; a short marker says whether it changed.
    let marker = 0
    for (let i = 0; i < key.length; i += 1) marker = (marker * 31 + key.charCodeAt(i)) | 0
    return JSON.stringify([this.settings.network, this.settings.controlUrl, port, this.deps.nodeName(), marker])
  }

  private startChild(): void {
    const port = this.wantPort
    if (port === null) return
    const binary = this.deps.binary()
    if (binary === null) {
      this.error = 'This build does not include the network helper. LAN and typed addresses still work.'
      this.deps.onChange()
      return
    }
    const stateDir = join(this.deps.dir, 'net', this.settings.network)
    mkdirSync(stateDir, { recursive: true })
    const args = [
      '--state-dir', stateDir,
      '--hostname', overlayHostname(this.deps.nodeName()),
      '--forward', String(port),
      '--listen-port', String(port),
      '--socks', '127.0.0.1:0',
      '--authkey-stdin',
      '--stdin-control',
    ]
    if (this.settings.network === 'headscale') args.push('--control-url', this.settings.controlUrl)
    const env = { ...process.env }
    delete env['AGENT_NET_AUTHKEY']
    const run = this.deps.spawn ?? (spawn as SpawnLike)
    let child: ChildProcess
    try {
      child = run(binary, args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true })
    } catch (error) {
      this.error = `The network helper did not start: ${(error as Error).message}`
      this.deps.onChange()
      return
    }
    this.child = child
    this.runningKey = this.startKey(port)
    this.sidecar = null
    this.error = ''
    // The key goes in on stdin, once; stdin then stays open as the control line (quit, logout). When this process
    // dies, stdin closes and the sidecar stops by itself.
    const key = this.deps.secrets.get(NET_AUTHKEY_SECRET) ?? ''
    child.stdin?.on('error', () => undefined)
    child.stdin?.write(`${key.trim()}\n`)
    if (child.stdout !== null) {
      createInterface({ input: child.stdout }).on('line', (line) => this.onLine(child, line))
    }
    child.stderr?.on('data', () => undefined)
    child.once('error', (error) => {
      if (this.child !== child) return
      this.error = `The network helper did not start: ${error.message}`
      this.child = null
      this.deps.onChange()
    })
    child.once('exit', (code) => this.onExit(child, code))
    this.deps.log?.('overlay network starting', { mode: this.settings.network, port })
    this.deps.onChange()
  }

  private onLine(child: ChildProcess, line: string): void {
    if (this.child !== child) return
    const parsed = parseSidecarLine(line)
    if (parsed === null) return
    if (parsed.type === 'status') {
      const before = JSON.stringify(this.sidecar)
      this.sidecar = parsed.status
      if (parsed.status.state === 'Running') this.crashes = 0
      if (JSON.stringify(parsed.status) !== before) this.deps.onChange()
    } else if (parsed.type === 'error') {
      this.error = parsed.error
      this.deps.onChange()
    }
  }

  private onExit(child: ChildProcess, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    this.sidecar = null
    if (this.wantPort === null) {
      this.deps.onChange()
      return
    }
    // It stopped on its own: say so, and try again after a pause.
    if (this.error === '') this.error = `The network helper stopped (code ${code ?? 'none'}). Trying again.`
    const delays = this.deps.backoffMs ?? BACKOFF_MS
    const delay = delays[Math.min(this.crashes, delays.length - 1)] ?? 60_000
    this.crashes += 1
    this.deps.log?.('overlay network stopped, restarting', { code, delay })
    this.cancelRestart()
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.wantPort !== null && this.child === null) {
        this.error = ''
        this.startChild()
      }
    }, delay)
    this.restartTimer.unref?.()
    this.deps.onChange()
  }

  private stopChild(how: 'quit' | 'logout'): void {
    const child = this.child
    if (child === null) return
    this.child = null
    this.sidecar = null
    this.runningKey = ''
    try {
      child.stdin?.write(`${how}\n`)
      child.stdin?.end()
    } catch {
      // Already gone.
    }
    const kill = setTimeout(() => child.kill('SIGKILL'), how === 'logout' ? 12_000 : 6_000)
    kill.unref?.()
    child.once('exit', () => clearTimeout(kill))
  }

  private cancelRestart(): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.restartTimer = null
  }
}

// ---- for the rest of the app: dialling peers ----

let current: OverlayNet | null = null

export function setOverlayNet(net: OverlayNet | null): void {
  current = net
}

export function getOverlayNet(): OverlayNet | null {
  return current
}

/** A TCP stream to a peer: through the overlay when `host` needs it, else null (dial directly as usual). */
export async function overlayDial(host: string, port: number, net: OverlayNet | null = current): Promise<Socket | null> {
  if (net === null || !net.shouldProxy(host)) return null
  const socks = net.socksAddress()
  if (socks === null) return null
  return socksConnect(socks, host, port)
}

type CreateConnection = (options: ConnectionOptions & { host?: string; port?: number | string }, done: (error: Error | null, socket?: TLSSocket) => void) => undefined

/**
 * For `https.request({ ..., createConnection })` to a peer url: when the host is on the overlay and the OS cannot
 * reach it, the TLS connection runs over the sidecar's proxy; otherwise undefined (the normal path). The caller's
 * TLS options (rejectUnauthorized, the fingerprint check on secureConnect) apply unchanged.
 */
export function overlayCreateConnection(host: string, net: OverlayNet | null = current): CreateConnection | undefined {
  if (net === null || !net.shouldProxy(host)) return undefined
  return (options, done) => {
    const port = Number(options.port ?? 443)
    overlayDial(host, port, net)
      .then((raw) => {
        if (raw === null) throw new Error('The overlay network is not running.')
        const name = host.replace(/^\[|\]$/g, '')
        const tls = tlsConnect({ ...options, socket: raw, servername: isIP(name) === 0 ? name : undefined })
        done(null, tls)
      })
      .catch((error: Error) => done(error))
    return undefined
  }
}

/**
 * The connection options for an https request to a peer url. Normally `{ agent: false }` (a fresh socket per
 * request, as pinnedFetch does); for an overlay host the OS cannot reach, `{ createConnection }` instead. Node uses
 * createConnection only when no agent is given, so the two never go together. Spread it into the request options.
 */
export function peerRequestOptions(host: string, net: OverlayNet | null = current): { agent: false } | { createConnection: CreateConnection } {
  const createConnection = overlayCreateConnection(host, net)
  return createConnection === undefined ? { agent: false } : { createConnection }
}
