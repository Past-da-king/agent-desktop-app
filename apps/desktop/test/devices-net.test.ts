/**
 * The optional overlay network (main/devices/net.ts, protocol s10): status-line parsing, which hosts go through the
 * overlay, finding the helper, and the helper's whole life with a fake sidecar (start with the key on stdin, status,
 * advertised urls, crash and restart, quit, logout), plus a real TLS request to a peer through a SOCKS5 stub the
 * way pinnedFetch will make it. The real Go sidecar has its own tests (tools/agent-net).
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpsRequest } from 'node:https'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { loadIdentity } from '../src/main/devices/identity'
import { pinnedFetch } from '../src/main/devices/pinned-fetch'
import { proxyFor, setDevicesProxy } from '../src/main/devices/socks'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import { Secrets } from '../src/main/secrets'
import {
  NET_AUTHKEY_SECRET,
  OverlayNet,
  cleanControlUrl,
  cleanNetSettings,
  dnsSuffixOf,
  findSidecar,
  isOverlayHost,
  isOverlayIp,
  osHasOverlayRoute,
  overlayCreateConnection,
  overlayDial,
  overlayHostname,
  parseSidecarLine,
  peerRequestOptions,
  setOverlayNet,
  sidecarBuildName,
  socksConnect,
  type SpawnLike,
} from '../src/main/devices/net'

const FAKE = join(__dirname, 'fixtures', 'fake-agent-net.mjs')
const KEY = 'test-overlay-key-not-real-0001'

class MemorySecrets {
  values = new Map<string, string>()
  get(name: string): string | null {
    return this.values.get(name) ?? null
  }
  set(name: string, value: string): void {
    this.values.set(name, value)
  }
  delete(name: string): void {
    this.values.delete(name)
  }
}

async function until(what: string, check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${what}`)
}

function readLog(file: string): Array<Record<string, unknown>> {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** A minimal SOCKS5 server that records each CONNECT target and sends every stream to one local port. */
function socksStub(toPort: number): Promise<{ server: Server; addr: string; targets: string[] }> {
  const targets: string[] = []
  const server = createServer((client) => {
    let buf = Buffer.alloc(0)
    let stage = 0
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      if (stage === 0 && buf.length >= 3) {
        buf = buf.subarray(2 + (buf[1] ?? 0))
        client.write(Buffer.from([5, 0]))
        stage = 1
      }
      if (stage === 1 && buf.length >= 5) {
        const type = buf[3]
        let host = ''
        let at = 4
        if (type === 1) {
          host = [...buf.subarray(4, 8)].join('.')
          at = 8
        } else if (type === 3) {
          const n = buf[4] ?? 0
          host = buf.subarray(5, 5 + n).toString()
          at = 5 + n
        } else if (type === 4) {
          host = 'v6'
          at = 20
        }
        if (buf.length < at + 2) return
        const port = buf.readUInt16BE(at)
        targets.push(`${host}:${port}`)
        client.removeListener('data', onData)
        const rest = buf.subarray(at + 2)
        const up = connect(toPort, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
          if (rest.length > 0) up.write(rest)
          client.pipe(up)
          up.pipe(client)
        })
        up.on('error', () => client.destroy())
        stage = 2
      }
    }
    client.on('data', onData)
    client.on('error', () => undefined)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, addr: `127.0.0.1:${(server.address() as AddressInfo).port}`, targets })))
}

function echoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket: Socket) => socket.pipe(socket))
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port })))
}

describe('net helpers', () => {
  it('parses status lines and refuses junk', () => {
    const line = parseSidecarLine(
      JSON.stringify({ type: 'status', state: 'Running', tailnetIPs: ['100.64.0.1', 'nope'], dnsName: 'a.example.ts.net.', socks: '127.0.0.1:4000', peers: [{ name: 'b', ips: ['100.64.0.2'], online: true }, 7] }),
    )
    expect(line).toEqual({
      type: 'status',
      status: { state: 'Running', authURL: '', tailnetIPs: ['100.64.0.1'], dnsName: 'a.example.ts.net', socks: '127.0.0.1:4000', peers: [{ name: 'b', dnsName: '', ips: ['100.64.0.2'], online: true }] },
    })
    // A proxy anywhere but loopback, or a login link that is not http(s), is dropped.
    const odd = parseSidecarLine(JSON.stringify({ type: 'status', state: 'NeedsLogin', socks: '192.0.2.1:1080', authURL: 'javascript:alert(1)' }))
    expect(odd?.type === 'status' && odd.status.socks).toBe('')
    expect(odd?.type === 'status' && odd.status.authURL).toBe('')
    expect(parseSidecarLine('not json')).toBeNull()
    expect(parseSidecarLine('[1,2]')).toBeNull()
    expect(parseSidecarLine('{"type":"other"}')).toBeNull()
    expect(parseSidecarLine('{"type":"error","error":"bad key"}')).toEqual({ type: 'error', error: 'bad key' })
    expect(parseSidecarLine('{"type":"exit"}')).toEqual({ type: 'exit' })
  })

  it('knows which hosts are on the overlay', () => {
    expect(isOverlayIp('100.64.0.1')).toBe(true)
    expect(isOverlayIp('100.127.255.254')).toBe(true)
    expect(isOverlayIp('100.128.0.1')).toBe(false)
    expect(isOverlayIp('100.63.255.255')).toBe(false)
    expect(isOverlayIp('192.168.1.5')).toBe(false)
    expect(isOverlayIp('fd7a:115c:a1e0::5')).toBe(true)
    expect(isOverlayIp('[fd7a:115c:a1e0:ab12::1]')).toBe(true)
    expect(isOverlayIp('fd00::1')).toBe(false)
    expect(isOverlayHost('box.example.ts.net')).toBe(true)
    expect(isOverlayHost('box.example.com')).toBe(false)
    expect(isOverlayHost('box.hs.example', 'hs.example')).toBe(true)
    expect(isOverlayHost('127.0.0.1')).toBe(false)
    expect(dnsSuffixOf('me.hs.example')).toBe('hs.example')
    expect(dnsSuffixOf('plain')).toBe('')
  })

  it('sees when the computer already has an overlay route', () => {
    const v6 = { address: 'fd7a:115c:a1e0::3', netmask: 'ffff:ffff:ffff::', family: 'IPv6', mac: '00:00:00:00:00:00', internal: false, cidr: null, scopeid: 0 } as const
    const v4 = { address: '100.64.0.3', netmask: '255.192.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null } as const
    const lan = { address: '192.168.1.4', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null } as const
    expect(osHasOverlayRoute({ eth0: [lan] })).toBe(false)
    expect(osHasOverlayRoute({ tailscale0: [v4] })).toBe(true)
    expect(osHasOverlayRoute({ utun4: [v6] })).toBe(true)
    // A 100.64/10 address on an ordinary interface is the ISP's shared range, not an overlay.
    expect(osHasOverlayRoute({ eth0: [v4] })).toBe(false)
  })

  it('cleans names, control urls and settings', () => {
    expect(overlayHostname('My Laptop (2)')).toBe('my-laptop-2')
    expect(overlayHostname('***')).toBe('agent-node')
    expect(overlayHostname('a'.repeat(80))).toHaveLength(63)
    expect(cleanControlUrl('headscale.example.com')).toBe('https://headscale.example.com')
    expect(cleanControlUrl('https://hs.example.com:8443/path')).toBe('https://hs.example.com:8443')
    expect(cleanControlUrl('http://hs.example.com')).toBe('')
    expect(cleanControlUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
    expect(cleanControlUrl('https://user:pw@hs.example.com')).toBe('')
    expect(cleanNetSettings({ network: 'bogus', controlUrl: 5 })).toEqual({ network: 'none', controlUrl: '' })
    expect(cleanNetSettings({ network: 'headscale', controlUrl: 'hs.example.com' })).toEqual({ network: 'headscale', controlUrl: 'https://hs.example.com' })
  })

  it('finds the helper in resources, next to the bundle, or in the repo build', () => {
    expect(sidecarBuildName('win32', 'x64')).toBe('agent-net-windows-amd64.exe')
    expect(sidecarBuildName('darwin', 'arm64')).toBe('agent-net-darwin-arm64')
    expect(sidecarBuildName('freebsd', 'x64')).toBeNull()
    const have = (paths: string[]) => (path: string) => paths.includes(path)
    expect(findSidecar({ resourcesPath: '/r', platform: 'linux', arch: 'x64', env: {}, exists: have([join('/r', 'agent-net', 'agent-net')]) })).toBe(join('/r', 'agent-net', 'agent-net'))
    expect(findSidecar({ resourcesPath: 'C:/r', platform: 'win32', arch: 'x64', env: {}, exists: have([join('C:/r', 'agent-net', 'agent-net.exe')]) })).toBe(join('C:/r', 'agent-net', 'agent-net.exe'))
    expect(findSidecar({ dirs: ['/repo'], platform: 'linux', arch: 'arm64', env: {}, exists: have([join('/repo', 'tools', 'agent-net', 'dist', 'agent-net-linux-arm64')]) })).toBe(join('/repo', 'tools', 'agent-net', 'dist', 'agent-net-linux-arm64'))
    expect(findSidecar({ env: { AGENT_NET_PATH: '/x/agent-net' }, exists: have(['/x/agent-net']) })).toBe('/x/agent-net')
    expect(findSidecar({ dirs: ['/nothing'], env: {}, exists: () => false })).toBeNull()
  })
})

describe('OverlayNet with a fake sidecar', () => {
  let dir = ''
  let log = ''
  let secrets: MemorySecrets
  let changes = 0
  let nets: OverlayNet[] = []
  let servers: Server[] = []
  const fakeSpawn = (env: Record<string, string>): SpawnLike => (command, args, options) => spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, ...env } })

  const make = (env: Record<string, string> = {}, extra: Partial<ConstructorParameters<typeof OverlayNet>[0]> = {}): OverlayNet => {
    const net = new OverlayNet({
      dir,
      secrets,
      binary: () => '/fake/agent-net',
      nodeName: () => 'Test Box',
      onChange: () => {
        changes += 1
      },
      spawn: fakeSpawn({ FAKE_NET_LOG: log, ...env }),
      backoffMs: [50, 50],
      interfaces: () => ({}),
      ...extra,
    })
    nets.push(net)
    return net
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-net-ts-'))
    log = join(dir, 'fake.log')
    secrets = new MemorySecrets()
    changes = 0
    nets = []
    servers = []
  })

  afterEach(async () => {
    for (const net of nets) await net.stop()
    for (const server of servers) server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does nothing with Network = None', () => {
    const net = make()
    net.apply(7787)
    expect(net.status()).toMatchObject({ mode: 'none', state: 'off', hasKey: false, addresses: [] })
    expect(readLog(log)).toEqual([])
    expect(net.urls(7787)).toEqual([])
    expect(net.socksAddress()).toBeNull()
  })

  it('starts with the key on stdin only, reports status and advertises overlay urls', async () => {
    const net = make({ FAKE_NET_SOCKS: '127.0.0.1:4555' })
    process.env['AGENT_NET_AUTHKEY'] = 'should-not-pass-down'
    try {
      net.save({ network: 'tailscale', authKey: KEY })
      net.apply(7787)
      expect(net.status().state).toBe('starting')
      await until('running', () => net.status().state === 'running')
    } finally {
      delete process.env['AGENT_NET_AUTHKEY']
    }
    const status = net.status()
    expect(status).toMatchObject({ mode: 'tailscale', state: 'running', hasKey: true, addresses: ['100.64.0.9', 'fd7a:115c:a1e0::9'], dnsName: 'test-box.example.ts.net', peers: 1, error: '' })
    expect(net.urls(7787)).toEqual(['https://100.64.0.9:7787', 'https://test-box.example.ts.net:7787', 'https://[fd7a:115c:a1e0::9]:7787'])
    expect(net.socksAddress()).toBe('127.0.0.1:4555')
    expect(changes).toBeGreaterThan(0)
    const entries = readLog(log)
    const start = entries.find((e) => e['type'] === 'start') as { args: string[]; envHasKey: boolean }
    expect(start.args).toEqual(expect.arrayContaining(['--forward', '7787', '--listen-port', '7787', '--socks', '127.0.0.1:0', '--authkey-stdin', '--stdin-control', '--hostname', 'test-box']))
    expect(start.args).not.toContain('--control-url')
    expect(start.args.join(' ')).not.toContain(KEY)
    expect(start.envHasKey).toBe(false)
    expect(entries.find((e) => e['type'] === 'key')).toEqual({ type: 'key', key: KEY })
    // The key lives in the secrets module, never in net.json.
    expect(secrets.get(NET_AUTHKEY_SECRET)).toBe(KEY)
    expect(readFileSync(join(dir, 'net.json'), 'utf8')).not.toContain(KEY)
    // Overlay hosts go through the proxy; LAN hosts do not.
    expect(net.shouldProxy('100.64.0.10')).toBe(true)
    expect(net.shouldProxy('other.example.ts.net')).toBe(true)
    expect(net.shouldProxy('192.168.1.20')).toBe(false)
    // Not when the computer has its own overlay route (the regular Tailscale app).
    const own = { tailscale0: [{ address: '100.64.0.3', netmask: '255.192.0.0', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: false, cidr: null }] }
    expect(net.shouldProxy('100.64.0.10', own)).toBe(false)
  })

  it('passes Headscale its control url and refuses Headscale without one', async () => {
    const net = make()
    expect(() => net.save({ network: 'headscale', controlUrl: '' })).toThrow(/Headscale/)
    net.save({ network: 'headscale', controlUrl: 'https://hs.example.com', authKey: KEY })
    net.apply(7790)
    await until('running', () => net.status().state === 'running')
    const start = readLog(log).find((e) => e['type'] === 'start') as { args: string[] }
    expect(start.args).toEqual(expect.arrayContaining(['--control-url', 'https://hs.example.com', '--forward', '7790']))
    expect(start.args.some((a) => a.endsWith(join('net', 'headscale')))).toBe(true)
  })

  it('without a key it starts and shows the sign-in link', async () => {
    const net = make()
    net.save({ network: 'tailscale' })
    net.apply(7787)
    await until('needs-login', () => net.status().state === 'needs-login')
    expect(net.status()).toMatchObject({ hasKey: false, authUrl: 'https://login.example.com/a/123', addresses: [] })
    expect(net.urls(7787)).toEqual([])
  })

  it('restarts after a crash and comes back', async () => {
    const net = make({ FAKE_NET_CRASH_ONCE: join(dir, 'crashed') })
    net.save({ network: 'tailscale', authKey: KEY })
    net.apply(7787)
    await until('crash seen', () => existsSync(join(dir, 'crashed')) && net.status().state === 'error')
    expect(net.status().error).toMatch(/stopped/)
    await until('running again', () => net.status().state === 'running')
    expect(readLog(log).filter((e) => e['type'] === 'start')).toHaveLength(2)
  })

  it('stops with quit on app exit and logs out when switched to None', async () => {
    const net = make()
    net.save({ network: 'tailscale', authKey: KEY })
    net.apply(7787)
    await until('running', () => net.status().state === 'running')
    await net.stop()
    await until('quit logged', () => readLog(log).some((e) => e['type'] === 'stop'))
    expect(readLog(log).filter((e) => e['type'] === 'stop')).toEqual([{ type: 'stop', how: 'quit' }])

    net.apply(7787)
    await until('running again', () => net.status().state === 'running')
    net.save({ network: 'none' })
    net.apply(7787)
    await until('logout logged', () => readLog(log).filter((e) => e['type'] === 'stop').length === 2)
    expect(readLog(log).filter((e) => e['type'] === 'stop')[1]).toEqual({ type: 'stop', how: 'logout' })
    expect(net.status()).toMatchObject({ mode: 'none', state: 'off' })
    // Removing the key works too.
    net.save({ network: 'none', authKey: null })
    expect(net.hasKey()).toBe(false)
  })

  it('restarts when the node port changes, and stops when Devices goes off', async () => {
    const net = make()
    net.save({ network: 'tailscale', authKey: KEY })
    net.apply(7787)
    await until('running', () => net.status().state === 'running')
    net.apply(7787)
    expect(readLog(log).filter((e) => e['type'] === 'start')).toHaveLength(1)
    net.apply(7799)
    await until('second start', () => readLog(log).filter((e) => e['type'] === 'start').length === 2)
    await until('running', () => net.status().state === 'running')
    expect(net.urls(7799)[0]).toBe('https://100.64.0.9:7799')
    net.apply(null)
    expect(net.status().state).toBe('off')
    await until('stopped', () => readLog(log).filter((e) => e['type'] === 'stop').length >= 1)
  })

  it('says so plainly when the build has no helper', () => {
    const net = make({}, { binary: () => null })
    net.save({ network: 'tailscale', authKey: KEY })
    net.apply(7787)
    expect(net.status()).toMatchObject({ state: 'error', available: false })
    expect(net.status().error).toMatch(/does not include/)
  })

  it('dials a peer through the overlay proxy: raw TCP and a TLS request like pinnedFetch makes', async () => {
    const echo = await echoServer()
    servers.push(echo.server)
    const socks = await socksStub(echo.port)
    servers.push(socks.server)

    // Raw SOCKS5 client, by IP and by name.
    const raw = await socksConnect(socks.addr, '100.64.0.10', 7787)
    const back = await new Promise<string>((resolve) => {
      raw.once('data', (d: Buffer) => resolve(d.toString()))
      raw.write('ping over overlay')
    })
    raw.destroy()
    expect(back).toBe('ping over overlay')
    const named = await socksConnect(socks.addr, 'other.example.ts.net', 7787)
    named.destroy()
    expect(socks.targets).toEqual(['100.64.0.10:7787', 'other.example.ts.net:7787'])

    // Through OverlayNet: only overlay hosts are proxied.
    const net = make({ FAKE_NET_SOCKS: socks.addr })
    net.save({ network: 'tailscale', authKey: KEY })
    net.apply(7787)
    await until('running', () => net.status().state === 'running')
    expect(await overlayDial('192.168.1.20', 7787, net)).toBeNull()
    expect(overlayCreateConnection('192.168.1.20', net)).toBeUndefined()
    expect(peerRequestOptions('192.168.1.20', net)).toEqual({ agent: false })

    // A TLS server with a node certificate stands in for the peer; the request goes over the proxy.
    const identity = loadIdentity(join(dir, 'peer'))
    const tls = createHttpsServer({ key: identity.keyPem, cert: identity.certPem }, (req, res) => {
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', () => resolve()))
    servers.push(tls)
    const tlsSocks = await socksStub((tls.address() as AddressInfo).port)
    servers.push(tlsSocks.server)
    const net2 = make({ FAKE_NET_SOCKS: tlsSocks.addr })
    // A second node in the same folder would share state; give it its own.
    net2.save({ network: 'tailscale', authKey: KEY })
    net2.apply(7788)
    await until('running', () => net2.status().state === 'running' && net2.socksAddress() === tlsSocks.addr)
    const createConnection = overlayCreateConnection('100.64.0.10', net2)
    expect(createConnection).toBeDefined()
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        { hostname: '100.64.0.10', port: 7787, path: '/v1/health', method: 'GET', rejectUnauthorized: false, ...(peerRequestOptions('100.64.0.10', net2) as object) },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve(Buffer.concat(chunks).toString()))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(JSON.parse(body)).toEqual({ ok: true, path: '/v1/health' })
    expect(tlsSocks.targets).toEqual(['100.64.0.10:7787'])
  })
})

describe('peer dialling picks the overlay', () => {
  let dir = ''
  const servers: Server[] = []
  let net: OverlayNet | null = null

  afterEach(async () => {
    setOverlayNet(null)
    setDevicesProxy(null)
    await net?.stop()
    for (const server of servers.splice(0)) server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('a set proxy wins, loopback is never proxied, the overlay only for its hosts; pinnedFetch goes through it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-net-dial-'))
    const identity = loadIdentity(join(dir, 'peer'))
    const tls = createHttpsServer({ key: identity.keyPem, cert: identity.certPem }, (req, res) => {
      res.end(JSON.stringify({ ok: true, path: req.url }))
    })
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', () => resolve()))
    servers.push(tls)
    const stub = await socksStub((tls.address() as AddressInfo).port)
    servers.push(stub.server)
    const secrets = new MemorySecrets()
    net = new OverlayNet({
      dir,
      secrets,
      binary: () => '/fake/agent-net',
      nodeName: () => 'Dial Box',
      onChange: () => undefined,
      spawn: (command, args, options) => spawn(process.execPath, [FAKE, ...args], { ...options, env: { ...options.env, FAKE_NET_SOCKS: stub.addr } }),
      interfaces: () => ({}),
    })
    // Off: nothing is proxied.
    expect(proxyFor('100.64.0.10')).toBeNull()
    net.save({ network: 'tailscale', authKey: KEY })
    net.apply(7787)
    await until('running', () => net?.status().state === 'running')
    setOverlayNet(net)
    const [stubHost, stubPort] = stub.addr.split(':')
    expect(proxyFor('100.64.0.10')).toEqual({ host: stubHost, port: Number(stubPort) })
    expect(proxyFor('[fd7a:115c:a1e0::10]')).toEqual({ host: stubHost, port: Number(stubPort) })
    expect(proxyFor('other.example.ts.net')).toEqual({ host: stubHost, port: Number(stubPort) })
    expect(proxyFor('192.168.1.20')).toBeNull()
    expect(proxyFor('127.0.0.1')).toBeNull()
    expect(proxyFor('localhost')).toBeNull()

    // The real pinnedFetch (replication's client) reaches the peer over the overlay, pin checked.
    const res = await pinnedFetch(identity.fp, 10_000)('https://100.64.0.10:7787/v1/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, path: '/v1/health' })
    expect(stub.targets).toEqual(['100.64.0.10:7787'])
    // A wrong pin is still refused through the overlay.
    await expect(pinnedFetch('not-the-pin', 10_000)('https://100.64.0.10:7787/v1/health')).rejects.toThrow()

    // A proxy the person set wins over the overlay; loopback still never goes through it.
    setDevicesProxy({ host: '127.0.0.1', port: 1 })
    expect(proxyFor('100.64.0.10')).toEqual({ host: '127.0.0.1', port: 1 })
    expect(proxyFor('192.168.1.20')).toEqual({ host: '127.0.0.1', port: 1 })
    expect(proxyFor('127.0.0.1')).toBeNull()
  })
})

describe('DevicesService with the overlay', () => {
  it('starts the helper when Devices is on and a network is picked, and advertises its address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-net-svc-'))
    const log = join(dir, 'fake.log')
    chmodSync(FAKE, 0o755)
    process.env['FAKE_NET_LOG'] = log
    const store = new Store(join(dir, 'agent.db'))
    const secrets = new Secrets(join(dir, 'secrets'), { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(p, 'utf8'), decryptString: (b) => b.toString('utf8') })
    const free = createServer()
    await new Promise<void>((resolve) => free.listen(0, '127.0.0.1', () => resolve()))
    const port = (free.address() as AddressInfo).port
    free.close()
    const service = new DevicesService({
      userData: dir,
      store,
      secrets,
      registry: new HandlerRegistry(),
      appVersion: '9.9.9',
      nodeName: () => 'Svc Box',
      platform: 'linux',
      ready: () => true,
      busy: () => false,
      rendererDir: join(dir, 'renderer'),
      emitWindow: () => undefined,
      sidecar: () => FAKE,
    })
    try {
      await service.start()
      await service.configure({ listen: '127.0.0.1', port })
      expect(service.status().network).toMatchObject({ mode: 'none', state: 'off' })
      let status = await service.setNetwork({ mode: 'tailscale', authKey: KEY })
      // Devices is still off: the helper waits for the server.
      expect(status.network?.state).toBe('off')
      expect(readLog(log)).toEqual([])
      await service.setEnabled(true)
      await until('running', () => service.status().network?.state === 'running')
      status = service.status()
      expect(status.urls).toContain(`https://100.64.0.9:${port}`)
      expect(status.urls).toContain(`https://svc-box.example.ts.net:${port}`)
      expect(status.network).toMatchObject({ hasKey: true, available: true, addresses: ['100.64.0.9', 'fd7a:115c:a1e0::9'] })
      expect(JSON.stringify(status)).not.toContain(KEY)
      const start = readLog(log).find((e) => e['type'] === 'start') as { args: string[] }
      expect(start.args).toEqual(expect.arrayContaining(['--forward', String(port), '--listen-port', String(port)]))
      // Its own device row carries the overlay address, so paired devices learn it.
      await until('row updated', () => {
        const row = (service.list().find((r) => r.id === service.identity.nodeId))
        return row !== undefined && row.urls.includes(`https://100.64.0.9:${port}`)
      })
      await service.setEnabled(false)
      await until('helper stopped', () => readLog(log).some((e) => e['type'] === 'stop'))
      expect(service.status().network?.state).toBe('off')
    } finally {
      delete process.env['FAKE_NET_LOG']
      await service.stop()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
