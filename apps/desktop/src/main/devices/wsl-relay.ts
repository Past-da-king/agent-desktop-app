/**
 * Reach this Windows computer through WSL when Tailscale on Windows is down (26 Nov 2026).
 *
 * Windows Tailscale can wedge ("NoState", starting forever) while the Tailscale inside WSL keeps working. Then the
 * person's other devices cannot reach the app on its Windows overlay address, and the app cannot reach theirs. With
 * this switched on (Settings > Devices, off by default), and only while Windows Tailscale is not running:
 *  - inbound: a small forwarder inside WSL listens on WSL's own overlay address and passes connections to the app's
 *    Devices port; that address goes LAST in this computer's advertised addresses, so a working direct address is
 *    always tried first and nothing is replaced;
 *  - outbound: for each paired device with an overlay address, a forwarder on 127.0.0.1 inside WSL (which Windows
 *    reaches through WSL's localhost forwarding) passes connections on to it. Those addresses stay on this computer
 *    (they mean nothing elsewhere) and are tried after the device's own addresses.
 * The TLS link and its certificate pin go through untouched: the forwarder only moves bytes.
 *
 * The forwarder is Python 3's standard library (in every Ubuntu WSL), with socat as a fallback, started with
 * `wsl.exe -e`. It exits when the app does (its stdin closes). Nothing is written to WSL or to a config file.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export type WslRelayState = 'off' | 'not-needed' | 'starting' | 'running' | 'unavailable' | 'error'

export interface WslRelayStatus {
  /** This computer can do it at all (Windows with WSL). */
  available: boolean
  /** The person switched it on. */
  on: boolean
  state: WslRelayState
  /** One plain line for Settings > Devices. */
  line: string
  /** The address other devices can use through WSL, or ''. */
  url: string
}

export interface RelayPeer {
  id: string
  name: string
  urls: string[]
}

/** What the relay found inside WSL. */
export interface WslProbe {
  /** WSL's own overlay IPv4, '' when it has none. */
  ip: string
  /** 'mirrored' when WSL shares Windows' loopback, else NAT (Windows is reached at the gateway). */
  mode: string
  gateway: string
  python: boolean
  socat: boolean
}

export interface ForwardMap {
  /** host:port inside WSL */
  listen: string
  /** host:port it passes to */
  target: string
}

/** A running forwarder: one line per listener it opened (LISTEN <listen>=<target> <port>) and READY. */
export interface Forwarder {
  onLine(listener: (line: string) => void): void
  onExit(listener: () => void): void
  stop(): void
}

export interface WslRelayDeps {
  platform: string
  /** Runs a short command and gives back its output; null when it failed or timed out. */
  run?: (file: string, args: string[], timeoutMs: number) => Promise<string | null>
  /** Starts a forwarder for these maps. */
  forward?: (maps: ForwardMap[], tool: 'python' | 'socat') => Forwarder
  log?: (line: string, detail?: Record<string, unknown>) => void
  /** Something a status line or an address depends on changed. */
  onChange: () => void
  now?: () => number
}

/** How often Windows Tailscale and WSL are looked at again while the relay is switched on. */
export const RELAY_CHECK_MS = 60_000
/** How long one look may take: a wedged Windows Tailscale can hang its own CLI. */
const LOOK_MS = 8_000

/** The overlay ranges a Tailscale-style network uses: 100.64.0.0/10 and fd7a:115c:a1e0::/48. */
export function isOverlayHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase()
  const parts = bare.split('.').map(Number)
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a = 0, b = 0] = parts
    return a === 100 && b >= 64 && b <= 127
  }
  return bare.startsWith('fd7a:115c:a1e0:')
}

function hostPort(url: string): { host: string; port: number } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:') return null
    return { host: parsed.hostname, port: parsed.port === '' ? 443 : Number(parsed.port) }
  } catch {
    return null
  }
}

/** Parses the probe script's output (key=value lines). */
export function parseProbe(text: string): WslProbe {
  const value = (key: string): string => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
  const ip = value('ip')
  return {
    ip: /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && isOverlayHost(ip) ? ip : '',
    mode: value('mode').toLowerCase(),
    gateway: /^\d{1,3}(\.\d{1,3}){3}$/.test(value('gw')) ? value('gw') : '',
    python: value('py') !== '',
    socat: value('socat') !== '',
  }
}

/** True when `tailscale status --json` says Windows Tailscale is up. A missing, failing or hung CLI is "not up". */
export function windowsTailscaleUp(json: string | null): boolean {
  if (json === null) return false
  try {
    const value = JSON.parse(json) as { BackendState?: unknown; Self?: { Online?: unknown } }
    return value.BackendState === 'Running'
  } catch {
    return false
  }
}

export const PROBE_SCRIPT = [
  'ip=$(tailscale ip -4 2>/dev/null | head -n1)',
  '[ -z "$ip" ] && ip=$(ip -4 -o addr show tailscale0 2>/dev/null | awk \'{print $4}\' | cut -d/ -f1 | head -n1)',
  'echo "ip=$ip"',
  'echo "mode=$(wslinfo --networking-mode 2>/dev/null)"',
  'echo "gw=$(ip route show default 2>/dev/null | awk \'{print $3; exit}\')"',
  'echo "py=$(command -v python3)"',
  'echo "socat=$(command -v socat)"',
].join('; ')

/** The forwarder, Python 3 standard library only. Arguments: listenHost:port=targetHost:port ... */
export const PY_FORWARDER = String.raw`
import asyncio, os, sys, threading
def watch():
    try:
        while sys.stdin.buffer.read(1):
            pass
    finally:
        os._exit(0)
threading.Thread(target=watch, daemon=True).start()
async def pipe(r, w):
    try:
        while True:
            d = await r.read(65536)
            if not d:
                break
            w.write(d)
            await w.drain()
    except Exception:
        pass
    finally:
        try:
            w.close()
        except Exception:
            pass
def split(hp):
    h, p = hp.rsplit(':', 1)
    return h.strip('[]'), int(p)
async def main():
    kept = []
    for spec in sys.argv[1:]:
        l, t = spec.split('=', 1)
        lh, lp = split(l)
        th, tp = split(t)
        async def handle(r, w, th=th, tp=tp):
            try:
                tr, tw = await asyncio.wait_for(asyncio.open_connection(th, tp), 10)
            except Exception:
                w.close()
                return
            await asyncio.gather(pipe(r, tw), pipe(tr, w))
        try:
            s = await asyncio.start_server(handle, lh, lp, reuse_address=True)
        except OSError as e:
            print('FAIL', spec, e.errno, flush=True)
            continue
        kept.append(s)
        print('LISTEN', spec, s.sockets[0].getsockname()[1], flush=True)
    print('READY', flush=True)
    await asyncio.Event().wait()
asyncio.run(main())
`

/**
 * What crosses wsl.exe's command line: plain letters only. Windows quoting of an argument with quotes or newlines in
 * it is not something to trust a relay to, so the script travels base64-encoded and is decoded inside WSL.
 */
export function wslShellArgs(script: string): string[] {
  return ['-e', 'sh', '-c', `echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d | sh`]
}

export function wslPythonArgs(code: string, args: string[]): string[] {
  const boot = `import base64;exec(compile(base64.b64decode('${Buffer.from(code, 'utf8').toString('base64')}').decode(),'agent-relay','exec'))`
  return ['-e', 'python3', '-u', '-c', boot, ...args]
}

/** `wsl.exe` on this Windows: System32, else on PATH. */
function wslExe(): string {
  const root = process.env['SystemRoot'] ?? 'C:\\Windows'
  const file = join(root, 'System32', 'wsl.exe')
  return existsSync(file) ? file : 'wsl.exe'
}

function tailscaleExe(): string {
  const file = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe')
  return existsSync(file) ? file : 'tailscale.exe'
}

async function runShort(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    let child: ChildProcess
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 65_536) out += chunk.toString('utf8')
    })
    child.once('error', () => finish(null))
    child.once('exit', (code) => finish(code === 0 ? out : null))
  })
}

function startForwarder(maps: ForwardMap[], tool: 'python' | 'socat'): Forwarder {
  const lines = new Set<(line: string) => void>()
  const exits = new Set<() => void>()
  const children: ChildProcess[] = []
  const emit = (line: string): void => {
    for (const listener of lines) listener(line)
  }
  let alive = 0
  const watch = (child: ChildProcess, map: ForwardMap | null): void => {
    alive += 1
    let buffer = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, at).trim())
        buffer = buffer.slice(at + 1)
      }
    })
    // socat says nothing when it listens: a fixed port is taken as listening once it runs.
    if (map !== null) child.once('spawn', () => emit(`LISTEN ${map.listen}=${map.target} ${map.listen.split(':').pop() ?? ''}`))
    const gone = (): void => {
      alive -= 1
      if (alive === 0) for (const listener of exits) listener()
    }
    child.once('exit', gone)
    child.once('error', () => undefined)
    children.push(child)
  }
  const stdio: ['pipe', 'pipe', 'ignore'] = ['pipe', 'pipe', 'ignore']
  if (tool === 'python') {
    watch(spawn(wslExe(), wslPythonArgs(PY_FORWARDER, maps.map((m) => `${m.listen}=${m.target}`)), { windowsHide: true, stdio }), null)
  } else {
    // socat cannot report a port it picked: only fixed ports, one process each.
    for (const map of maps.filter((m) => !m.listen.endsWith(':0'))) {
      const [lh, lp] = [map.listen.slice(0, map.listen.lastIndexOf(':')), map.listen.slice(map.listen.lastIndexOf(':') + 1)]
      watch(spawn(wslExe(), ['-e', 'socat', `TCP-LISTEN:${lp},bind=${lh},reuseaddr,fork`, `TCP:${map.target}`], { windowsHide: true, stdio }), map)
    }
    queueMicrotask(() => emit('READY'))
  }
  return {
    onLine: (listener) => void lines.add(listener),
    onExit: (listener) => void exits.add(listener),
    stop: () => {
      for (const child of children) {
        try {
          child.stdin?.end()
        } catch {
          // already gone
        }
        child.kill()
      }
    },
  }
}

interface Wanted {
  port: number
  peers: RelayPeer[]
}

export class WslRelay {
  private on = false
  private state: WslRelayState = 'off'
  private line = 'Off.'
  private probe: WslProbe | null = null
  private forwarder: Forwarder | null = null
  private mapsKey = ''
  private inbound = ''
  /** Local forward per peer id: https://127.0.0.1:<port> */
  private readonly outbound = new Map<string, string>()
  private wanted: Wanted = { port: 0, peers: [] }
  private timer: ReturnType<typeof setInterval> | null = null
  private checking: Promise<void> | null = null
  private inboundBase = 0
  private failures = 0
  private readonly run: NonNullable<WslRelayDeps['run']>
  private readonly forward: NonNullable<WslRelayDeps['forward']>

  constructor(private readonly deps: WslRelayDeps) {
    this.run = deps.run ?? runShort
    this.forward = deps.forward ?? startForwarder
  }

  get available(): boolean {
    return this.deps.platform === 'win32'
  }

  status(): WslRelayStatus {
    return { available: this.available, on: this.on, state: this.state, line: this.line, url: this.inbound }
  }

  /** The address to publish last in this computer's row, or ''. */
  inboundUrl(): string {
    return this.state === 'running' ? this.inbound : ''
  }

  /** This computer's own extra addresses for a paired device (never published). */
  peerUrls(id: string): string[] {
    if (this.state !== 'running') return []
    const url = this.outbound.get(id)
    return url === undefined ? [] : [url]
  }

  /**
   * Switched on or off, with the Devices port and the paired devices. Idempotent: call it whenever any of them may
   * have changed. Looks at Windows Tailscale and WSL in the background.
   */
  apply(on: boolean, port: number, peers: RelayPeer[]): void {
    const wasOn = this.on
    this.on = on && this.available
    this.wanted = { port, peers: peers.map((peer) => ({ ...peer, urls: [...peer.urls] })) }
    if (!this.on) {
      this.halt(this.available ? 'off' : 'unavailable', this.available ? 'Off.' : 'Only on Windows with WSL.')
      if (this.timer !== null) clearInterval(this.timer)
      this.timer = null
      if (wasOn) this.deps.onChange()
      return
    }
    if (this.timer === null) {
      this.timer = setInterval(() => void this.check(), RELAY_CHECK_MS)
      this.timer.unref?.()
    }
    if (!wasOn) {
      this.set('starting', 'Checking Tailscale on Windows and in WSL...')
      void this.check()
    } else if (this.state === 'running') this.ensureForwarder()
  }

  /** Looks again now (tests, and when a link fails). */
  check(): Promise<void> {
    if (this.checking !== null) return this.checking
    this.checking = this.look().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  /** Stops every forwarder (the app is closing or Devices stops); apply() starts again. */
  stop(): void {
    this.on = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.halt('off', 'Off.')
  }

  private async look(): Promise<void> {
    if (!this.on) return
    const windowsUp = windowsTailscaleUp(await this.run(tailscaleExe(), ['status', '--json'], LOOK_MS))
    if (!this.on) return
    if (windowsUp) {
      this.halt('not-needed', 'Not needed now: Tailscale on Windows is up, so devices reach this computer directly.')
      return
    }
    const text = await this.run(wslExe(), wslShellArgs(PROBE_SCRIPT), LOOK_MS)
    if (!this.on) return
    const probe = text === null ? null : parseProbe(text)
    if (probe === null) {
      this.halt('unavailable', 'Tailscale on Windows is down, and WSL did not answer.')
      return
    }
    if (probe.ip === '') {
      this.halt('unavailable', 'Tailscale on Windows is down, and WSL has no Tailscale address of its own.')
      return
    }
    if (!probe.python && !probe.socat) {
      this.halt('unavailable', 'Tailscale on Windows is down; WSL has neither python3 nor socat to relay with.')
      return
    }
    this.probe = probe
    this.ensureForwarder()
  }

  /** The maps the relay should run now. */
  private maps(): ForwardMap[] {
    const probe = this.probe
    if (probe === null || this.wanted.port <= 0) return []
    if (this.inboundBase === 0) this.inboundBase = this.wanted.port + 1
    // Mirrored networking shares Windows' loopback; NAT reaches Windows at the gateway (the app listens there too).
    const windows = probe.mode === 'mirrored' || probe.gateway === '' ? '127.0.0.1' : probe.gateway
    const maps: ForwardMap[] = [{ listen: `${probe.ip}:${this.inboundBase}`, target: `${windows}:${this.wanted.port}` }]
    const python = probe.python
    for (const peer of this.wanted.peers) {
      const overlay = peer.urls.map(hostPort).find((hp): hp is { host: string; port: number } => hp !== null && isOverlayHost(hp.host))
      if (overlay === undefined) continue
      const host = overlay.host.includes(':') ? `[${overlay.host.replace(/^\[|\]$/g, '')}]` : overlay.host
      // Python reports the port it picked; socat needs a fixed one.
      const local = python ? 0 : this.inboundBase + 1 + maps.length
      maps.push({ listen: `127.0.0.1:${local}`, target: `${host}:${overlay.port}` })
    }
    return maps
  }

  private ensureForwarder(): void {
    const maps = this.maps()
    const probe = this.probe
    if (probe === null || maps.length === 0) return
    const key = JSON.stringify(maps)
    if (this.forwarder !== null && key === this.mapsKey) return
    this.forwarder?.stop()
    this.forwarder = null
    this.mapsKey = key
    const peersByTarget = new Map<string, string>()
    for (const peer of this.wanted.peers) {
      const overlay = peer.urls.map(hostPort).find((hp) => hp !== null && isOverlayHost(hp.host))
      if (overlay !== undefined && overlay !== null) {
        const host = overlay.host.includes(':') ? `[${overlay.host.replace(/^\[|\]$/g, '')}]` : overlay.host
        peersByTarget.set(`${host}:${overlay.port}`, peer.id)
      }
    }
    if (this.state !== 'running') this.set('starting', 'Starting the relay in WSL...')
    const forwarder = this.forward(maps, probe.python ? 'python' : 'socat')
    this.forwarder = forwarder
    let inboundFailed = false
    forwarder.onLine((line) => {
      if (this.forwarder !== forwarder) return
      const listen = line.match(/^LISTEN (\S+)=(\S+) (\d+)$/)
      if (listen !== null) {
        const [, from = '', to = '', port = ''] = listen
        if (from.startsWith(`${probe.ip}:`)) this.inbound = `https://${probe.ip}:${port}`
        else {
          const id = peersByTarget.get(to)
          if (id !== undefined) this.outbound.set(id, `https://127.0.0.1:${port}`)
        }
        return
      }
      const failed = line.match(/^FAIL (\S+)=/)
      if (failed !== null && (failed[1] ?? '').startsWith(`${probe.ip}:`)) inboundFailed = true
      if (line === 'READY') {
        if (inboundFailed || this.inbound === '') {
          // The port is taken (perhaps a relay the person set up by hand): the next one.
          this.inboundBase += 1
          if (this.inboundBase > this.wanted.port + 20) {
            this.halt('error', 'Tailscale on Windows is down; no free port in WSL for the relay.')
            return
          }
          this.mapsKey = ''
          this.forwarder?.stop()
          this.forwarder = null
          this.inbound = ''
          this.ensureForwarder()
          return
        }
        this.failures = 0
        const reached = [...this.outbound.keys()].length
        this.set(
          'running',
          `On: Tailscale on Windows is down, so devices reach this computer through WSL at ${this.inbound}` +
            (reached > 0 ? `, and it reaches ${reached === 1 ? '1 device' : `${reached} devices`} through WSL.` : '.'),
        )
      }
    })
    forwarder.onExit(() => {
      if (this.forwarder !== forwarder) return
      this.forwarder = null
      this.mapsKey = ''
      this.inbound = ''
      this.outbound.clear()
      this.failures += 1
      this.deps.log?.('WSL relay stopped', { failures: this.failures })
      if (!this.on) return
      this.set('error', 'The relay in WSL stopped; trying again.')
      // Back off: a WSL that keeps dying must not be restarted in a loop.
      const delay = Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5))
      setTimeout(() => {
        if (this.on && this.forwarder === null) void this.check()
      }, delay).unref?.()
    })
  }

  private halt(state: WslRelayState, line: string): void {
    this.forwarder?.stop()
    this.forwarder = null
    this.mapsKey = ''
    const hadAddress = this.inbound !== '' || this.outbound.size > 0
    this.inbound = ''
    this.outbound.clear()
    this.set(state, line, hadAddress)
  }

  private set(state: WslRelayState, line: string, force = false): void {
    if (!force && state === this.state && line === this.line) return
    const before = this.state
    this.state = state
    this.line = line
    if (before !== state) this.deps.log?.('WSL relay', { state, line })
    this.deps.onChange()
  }
}
