/**
 * 26 Nov 2026: Windows Tailscale wedged in NoState while WSL's own Tailscale worked, and the main agent had to set
 * up socat relays in WSL and edit config files by hand. The app now does it itself when the person switches it on
 * (off by default), only while Windows Tailscale is down, and never in place of a working direct link.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { HandlerRegistry } from '../src/main/devices/registry'
import { DevicesService } from '../src/main/devices/service'
import { PROBE_SCRIPT, PY_FORWARDER, WslRelay, isOverlayHost, parseProbe, windowsTailscaleUp, wslPythonArgs, wslShellArgs, type ForwardMap, type Forwarder } from '../src/main/devices/wsl-relay'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const done of cleanups.splice(0).reverse()) await done()
})

const WSL_OUTPUT = 'ip=100.100.10.20\nmode=mirrored\ngw=172.20.0.1\npy=/usr/bin/python3\nsocat=/usr/bin/socat\n'
const DOWN = JSON.stringify({ BackendState: 'NoState' })
const UP = JSON.stringify({ BackendState: 'Running' })

/** A fake forwarder that "listens" on every map at once, or refuses the ports in `taken`. */
function fakeForward(started: ForwardMap[][], taken: Set<string> = new Set()): (maps: ForwardMap[]) => Forwarder {
  return (maps) => {
    started.push(maps)
    const lines = new Set<(line: string) => void>()
    queueMicrotask(() => {
      let next = 41_000
      for (const map of maps) {
        if (taken.has(map.listen)) for (const l of lines) l(`FAIL ${map.listen}=${map.target} 98`)
        else for (const l of lines) l(`LISTEN ${map.listen}=${map.target} ${map.listen.endsWith(':0') ? next++ : map.listen.split(':').pop()}`)
      }
      for (const l of lines) l('READY')
    })
    return { onLine: (l) => void lines.add(l), onExit: () => undefined, stop: () => undefined }
  }
}

describe('the relay itself', () => {
  it('reads WSL and Windows Tailscale the way their CLIs answer', () => {
    expect(parseProbe(WSL_OUTPUT)).toEqual({ ip: '100.100.10.20', mode: 'mirrored', gateway: '172.20.0.1', python: true, socat: true })
    expect(parseProbe('ip=192.168.1.5\nmode=nat\n').ip).toBe('')
    expect(windowsTailscaleUp(UP)).toBe(true)
    expect(windowsTailscaleUp(DOWN)).toBe(false)
    expect(windowsTailscaleUp(null)).toBe(false)
    expect(windowsTailscaleUp('not json')).toBe(false)
    expect(isOverlayHost('100.100.10.30')).toBe(true)
    expect(isOverlayHost('[fd7a:115c:a1e0::1234]')).toBe(true)
    expect(isOverlayHost('192.168.50.36')).toBe(false)
  })

  it('is off by default, does nothing off Windows, and is not used while Windows Tailscale is up', async () => {
    const started: ForwardMap[][] = []
    const linux = new WslRelay({ platform: 'linux', onChange: () => undefined, run: async () => DOWN, forward: fakeForward(started) })
    linux.apply(true, 7787, [])
    await linux.check()
    expect(linux.status().available).toBe(false)
    expect(linux.inboundUrl()).toBe('')

    const up = new WslRelay({ platform: 'win32', onChange: () => undefined, run: async (file) => (file.includes('tailscale') ? UP : WSL_OUTPUT), forward: fakeForward(started) })
    expect(up.status()).toMatchObject({ on: false, state: 'off' })
    up.apply(true, 7787, [])
    await up.check()
    expect(up.status().state).toBe('not-needed')
    expect(up.inboundUrl()).toBe('')
    expect(started).toHaveLength(0)
    up.stop()
  })

  it('while Windows Tailscale is down: relays in through WSL’s address and out to each paired device, then stops when it comes back', async () => {
    const started: ForwardMap[][] = []
    let windows = DOWN
    const relay = new WslRelay({ platform: 'win32', onChange: () => undefined, run: async (file) => (file.includes('tailscale') ? windows : WSL_OUTPUT), forward: fakeForward(started) })
    relay.apply(true, 7787, [{ id: 'dev_srv', name: 'impetix', urls: ['https://100.100.10.30:7787'] }, { id: 'dev_phone', name: 'Phone', urls: [] }])
    await relay.check()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(started[0]).toEqual([
      { listen: '100.100.10.20:7788', target: '127.0.0.1:7787' },
      { listen: '127.0.0.1:0', target: '100.100.10.30:7787' },
    ])
    expect(relay.status().state).toBe('running')
    expect(relay.inboundUrl()).toBe('https://100.100.10.20:7788')
    expect(relay.peerUrls('dev_srv')).toEqual(['https://127.0.0.1:41000'])
    expect(relay.status().line).toContain('https://100.100.10.20:7788')
    windows = UP
    await relay.check()
    expect(relay.status().state).toBe('not-needed')
    expect(relay.inboundUrl()).toBe('')
    expect(relay.peerUrls('dev_srv')).toEqual([])
    relay.stop()
  })

  it('takes the next port when the first is in use (a relay set up by hand), and says when WSL has no Tailscale', async () => {
    const started: ForwardMap[][] = []
    const relay = new WslRelay({ platform: 'win32', onChange: () => undefined, run: async (file) => (file.includes('tailscale') ? DOWN : WSL_OUTPUT), forward: fakeForward(started, new Set(['100.100.10.20:7788'])) })
    relay.apply(true, 7787, [])
    await relay.check()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(relay.inboundUrl()).toBe('https://100.100.10.20:7789')
    relay.stop()

    const none = new WslRelay({ platform: 'win32', onChange: () => undefined, run: async (file) => (file.includes('tailscale') ? DOWN : 'ip=\nmode=nat\n'), forward: fakeForward([]) })
    none.apply(true, 7787, [])
    await none.check()
    expect(none.status()).toMatchObject({ state: 'unavailable' })
    expect(none.status().line).toContain('no Tailscale address')
    none.stop()
  })
})

describe('in the devices service', () => {
  it('publishes the relay address LAST in this computer’s row and status, and only while it runs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wsl-relay-service-'))
    const store = new Store(join(dir, 'agent.db'))
    const data = new Map<string, string>()
    let windows = DOWN
    const service = new DevicesService({
      userData: dir,
      store,
      secrets: { get: (n) => data.get(n) ?? null, set: (n, v) => void data.set(n, v), delete: (n) => void data.delete(n) },
      registry: new HandlerRegistry(),
      appVersion: '1.0.0',
      nodeName: () => 'PC',
      platform: 'win32',
      ready: () => true,
      busy: () => false,
      rendererDir: join(dir, 'none'),
      emitWindow: () => undefined,
      wslRelay: { run: async (file) => (file.includes('tailscale') ? windows : WSL_OUTPUT), forward: fakeForward([]) },
    })
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => service.stop())
    const port = 20000 + Math.floor(Math.random() * 30000)
    await service.configure({ listen: '127.0.0.1', port, extraUrls: ['https://pc.example:7787'] })
    await service.start()
    await service.setEnabled(true)
    expect(service.status().wslRelay).toMatchObject({ available: true, on: false })
    await service.setWslRelay(true)
    await service.wslRelay.check()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const relayUrl = `https://100.100.10.20:${port + 1}`
    const urls = service.status().urls
    expect(urls.at(-1)).toBe(relayUrl)
    expect(urls[0]).toBe('https://pc.example:7787')
    const row = await store.get('device', service.status().nodeId)
    expect(row?.urls.at(-1)).toBe(relayUrl)
    windows = UP
    await service.wslRelay.check()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.status().urls).not.toContain(relayUrl)
    expect((await store.get('device', service.status().nodeId))?.urls).not.toContain(relayUrl)
    await service.setWslRelay(false)
    expect(service.status().wslRelay).toMatchObject({ on: false, state: 'off' })
  })
})

describe('the real forwarder (python3, as WSL runs it)', () => {
  it('the WSL probe script runs through its base64 wrapper and prints every key', async () => {
    const args = wslShellArgs(PROBE_SCRIPT)
    expect(args.slice(0, 3)).toEqual(['-e', 'sh', '-c'])
    expect(args.every((arg) => !/["'\n\r]/.test(arg))).toBe(true)
    const out = await new Promise<string>((resolve) => {
      let text = ''
      const child = spawn(args[1]!, args.slice(2), { stdio: ['ignore', 'pipe', 'ignore'] })
      child.stdout.on('data', (chunk: Buffer) => (text += chunk.toString()))
      child.once('exit', () => resolve(text))
    })
    for (const key of ['ip', 'mode', 'gw', 'py', 'socat']) expect(out).toMatch(new RegExp(`^${key}=`, 'm'))
  })

  const hasPython = (): Promise<boolean> =>
    new Promise((resolve) => {
      const child = spawn('python3', ['-c', 'print(1)'], { stdio: 'ignore' })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
    })

  it('moves bytes both ways, reports the port it picked, and exits when its stdin closes (the app went away)', async () => {
    if (!(await hasPython())) return
    const echo: Server = createServer((socket) => socket.pipe(socket))
    await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => echo.close(() => resolve())))
    const target = (echo.address() as { port: number }).port
    // Exactly what goes after `wsl.exe -e`: only base64 and plain words cross the Windows command line.
    const args = wslPythonArgs(PY_FORWARDER, [`127.0.0.1:0=127.0.0.1:${target}`])
    expect(args[0]).toBe('-e')
    expect(args.every((arg) => !/["\n\r]/.test(arg))).toBe(true)
    const child = spawn(args[1]!, args.slice(2), { stdio: ['pipe', 'pipe', 'ignore'] })
    cleanups.push(() => void child.kill('SIGKILL'))
    let out = ''
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString()
        const hit = out.match(/LISTEN \S+ (\d+)/)
        if (hit !== null && out.includes('READY')) resolve(Number(hit[1]))
      })
      child.once('exit', () => reject(new Error(`forwarder exited: ${out}`)))
    })
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => socket.write('hello through WSL'))
      socket.once('data', (chunk) => {
        resolve(chunk.toString())
        socket.end()
      })
      socket.once('error', reject)
    })
    expect(reply).toBe('hello through WSL')
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
    child.stdin.end()
    expect(await exited).toBe(0)
  }, 15_000)
})
