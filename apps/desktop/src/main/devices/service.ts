/**
 * Devices on this computer: the node identity, the server (switched on in Settings > Devices), pairing, the device
 * rows, the routes of protocol s5 that belong to the node itself, /v1/file and the web UI at /app/. Everything
 * else (replication, the bundle, device commands, turn leases) plugs in through `host()` (DevicesHost).
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { join, normalize, resolve, sep } from 'node:path'
import { readFile } from 'node:fs/promises'

import type { DeviceRow, DevicesStatus, PairingOfferInfo } from '@agent/core'

import { DEVICES_CHANNELS, DEVICES_EVENTS } from '../../shared/devices-channels'
import { qrMatrix } from '../../shared/qr'
import { DevicesConfigFile, advertisedUrls, normaliseUrl, type DevicesConfig } from './config'
import { cleanRoles, platformOf } from './facts'
import { loadIdentity, type NodeIdentity } from './identity'
import { OverlayNet, setOverlayNet } from './net'
import { originFrom, setLocalOrigin } from './origin'
import { formatShortCode, handlePair, pairUri, PairingOffers } from './pairing'
import { SecretPassTable, hashPass, newPass, type SecretsLike } from './passes'
import { DEFAULT_SHARE, SHARE_GROUPS, type DeviceToolHost, type ShareGroup } from './device-tool-host'
import type { FirewallState, WindowsFirewall } from './firewall'
import { Uplink, type UplinkTarget } from './uplink'
import { callAllowed } from './rpc'
import { wireOf, type HandlerRegistry } from './registry'
import { DevicesServer, contentTypeFor } from './server'
import type { BrainRef, DeviceFacts, DeviceKind, DeviceRecord, DeviceRole, DevicesHost, DeviceToolResult, RouteReply, RouteRequest } from './types'

const SEEN_EVERY_MS = 60_000
const COOKIE_DAYS = 400

/** The bits of the Store this service uses (main/db.ts). */
export interface DeviceStoreLike {
  list(entity: 'device'): Promise<DeviceRow[]>
  list(entity: 'chat_item'): Promise<Array<{ text: string; meta: string }>>
  list(entity: 'project'): Promise<Array<{ path: string }>>
  get(entity: 'device', id: string): Promise<DeviceRow | null>
  upsert(entity: 'device', row: Partial<DeviceRow>): Promise<DeviceRow>
  onChange(listener: (change: { entity: string }) => void): () => void
}

export interface IpcHandleLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface DevicesServiceDeps {
  /** `<userData>`; the node keeps its files in `<userData>/devices`. */
  userData: string
  store: DeviceStoreLike
  secrets: SecretsLike
  registry: HandlerRegistry
  appVersion: string
  /** This computer's name (Settings device name). */
  nodeName: () => string
  platform: string
  /** The node can run turns now (an AI account is set up). */
  ready: () => boolean
  /** A turn is running. */
  busy: () => boolean
  /** The built renderer (out/renderer), served at /app/. */
  rendererDir: string
  /** Tells this computer's own windows (Settings > Devices) that something changed. */
  emitWindow: (channel: string, payload: unknown) => void
  log?: (message: string, detail?: Record<string, unknown>) => void
  now?: () => number
  /** What this node is (the headless node is a 'server' with no screen). Default: a desktop that opens links and files. */
  kind?: DeviceKind
  canOpenLinks?: boolean
  canReceiveFiles?: boolean
  /** Where the overlay network helper is (devices/net.ts findSidecar), or null when this build has none. */
  sidecar?: () => string | null
  /**
   * Roles of a device this node trusts before its row has arrived: the brain it paired with. A joining node that
   * cannot open connections out (a firewall, a userspace VPN) only ever hears from that brain, and the brain's first
   * replication push brings the rows; without this its pass is refused for want of the row it carries. A row, once
   * here, always wins (revoked stays revoked).
   */
  knownPeer?: (deviceId: string) => DeviceRole[] | null
  /** This node's own tools for other devices (protocol s11). Without it the node offers none. */
  deviceTools?: DeviceToolHost
  /** Windows Firewall check and the one-prompt "Allow connections" (Windows only). */
  firewall?: WindowsFirewall
  /** Device commands other than "tool" that reach this node over its link to the answering brain. */
  openUrl?: (url: string) => Promise<void>
  notify?: (title: string, body: string) => void
}

const SELF_PASS = 'devicesSelfPass'

function toRecord(row: DeviceRow): DeviceRecord {
  const { createdAt: _createdAt, ...rest } = row
  return rest
}

function sortDevices(rows: DeviceRow[]): DeviceRow[] {
  const brain = (row: DeviceRow): number => (row.roles.includes('brain') ? 0 : 1)
  return [...rows].sort((a, b) => brain(a) - brain(b) || a.priority - b.priority || a.pairedAt - b.pairedAt)
}

/** "3F2A 9C01 77DE 0B41": the start of the fingerprint as hex in groups, to compare by eye on both screens. */
export function fingerprintWords(fp: string): string {
  const hex = Buffer.from(fp, 'base64url').toString('hex').slice(0, 16).toUpperCase()
  return (hex.match(/.{1,4}/g) ?? []).join(' ')
}

/** True when `child` is `parent` or inside it (both already real paths). */
export function isInside(child: string, parent: string): boolean {
  const a = process.platform === 'win32' ? child.toLowerCase() : child
  const b = process.platform === 'win32' ? parent.toLowerCase() : parent
  if (a === b) return true
  return a.startsWith(b.endsWith(sep) ? b : b + sep)
}

function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

export class DevicesService {
  private ident: NodeIdentity | null = null
  private srv: DevicesServer | null = null
  private readonly switchListeners = new Set<(on: boolean) => void>()
  private readonly config: DevicesConfigFile
  private readonly passes: SecretPassTable
  private readonly offers: PairingOffers
  private readonly uplink: Uplink
  private firewallState: FirewallState = 'unknown'
  private firewallAt = 0
  private rows = new Map<string, DeviceRow>()
  private readonly seenAt = new Map<string, number>()
  private error = ''
  private readonly now: () => number
  private readonly dir: string
  private allowedCache = new Map<string, number>()
  private offStore: (() => void) | null = null
  private ipv6 = true
  /** The optional overlay network (protocol s10); does nothing until the person picks one. */
  readonly net: OverlayNet
  private netWrite: Promise<void> = Promise.resolve()

  constructor(private readonly deps: DevicesServiceDeps) {
    this.now = deps.now ?? Date.now
    this.dir = join(deps.userData, 'devices')
    this.config = new DevicesConfigFile(join(this.dir, 'config.json'))
    this.net = new OverlayNet({
      dir: this.dir,
      secrets: deps.secrets,
      binary: deps.sidecar ?? (() => null),
      nodeName: () => deps.nodeName(),
      log: deps.log,
      // New overlay addresses go into this node's own row, so paired devices learn them.
      onChange: () => {
        this.netWrite = this.netWrite.then(() => this.writeSelf()).catch(() => undefined)
        this.changed()
      },
    })
    this.passes = new SecretPassTable(deps.secrets)
    this.offers = new PairingOffers(this.now)
    this.uplink = new Uplink({
      target: () => this.uplinkTarget(),
      pass: () => this.selfPass(),
      facts: () => this.selfFacts(),
      runTool: (command) => this.runTool(command),
      other: (command) => this.otherCommand(command),
      log: deps.log,
      onState: () => this.changed(),
    })
  }

  /**
   * Who this node is. Made the first time something needs it (Devices switched on, or a part that plugs in asks
   * for the host), so an app that never uses Devices writes nothing for it.
   */
  get identity(): NodeIdentity {
    if (this.ident === null) this.ident = loadIdentity(this.dir)
    return this.ident
  }

  private get server(): DevicesServer {
    if (this.srv === null) {
      this.srv = new DevicesServer({
        keyPem: this.identity.keyPem,
        certPem: this.identity.certPem,
        deviceForPass: (pass) => this.passes.deviceFor(pass),
        rolesOf: (id) => {
          const row = this.rows.get(id)
          if (row === undefined) return this.deps.knownPeer?.(id) ?? null
          return row.revoked ? null : row.roles
        },
        self: () => ({ id: this.identity.nodeId, facts: this.selfFacts() }),
        callRpc: (session, method, args) => callAllowed(this.deps.registry, this.server.added(), session, method, args),
        onConnections: () => this.changed(),
        onSeen: (id) => this.seen(id),
        onHello: (id, facts) => void this.hello(id, facts),
        log: this.deps.log,
      })
      this.mountRoutes()
    }
    return this.srv
  }

  private get enabled(): boolean {
    return this.config.get().enabled
  }

  /** For the parts that plug in (replication, bundle, device commands). Available whether or not it listens. */
  host(): DevicesHost {
    return this.server
  }

  /** The brain this node is serving its tools to right now, or null. */
  servingTo(): string | null {
    return this.uplink.target
  }

  /** Checks the link to the answering brain now instead of at the next 15 s check. */
  uplinkNow(): Promise<void> {
    return this.uplink.tick()
  }

  passTable(): SecretPassTable {
    return this.passes
  }

  /** Whether Devices is switched on (the headless node always is). */
  isEnabled(): boolean {
    return this.enabled
  }

  /** This node's own pass (its hash is in the mesh's pass table), for its links to other nodes. */
  ownPass(): string {
    return this.selfPass()
  }

  /** Hears Devices being switched on or off (devices/attach.ts starts and stops replication with it). */
  onSwitch(listener: (on: boolean) => void): () => void {
    this.switchListeners.add(listener)
    return () => this.switchListeners.delete(listener)
  }

  /** Reads the device rows, writes this node's own, and listens when Devices is on. */
  async start(): Promise<void> {
    await this.reloadRows()
    this.offStore = this.deps.store.onChange((change) => {
      if (change.entity === 'device') void this.reloadRows().then(() => this.uplink.tick())
    })
    if (this.enabled) {
      await this.switchOn()
      for (const listener of this.switchListeners) listener(true)
    }
    setOverlayNet(this.net)
    this.applyNet()
  }

  async stop(): Promise<void> {
    this.offStore?.()
    this.offStore = null
    setOverlayNet(null)
    await this.net.stop()
    this.uplink.stop()
    await this.srv?.stop()
  }

  /** A main-process event (index.ts broadcast): passed on to connected devices that may hear it. */
  broadcast(channel: string, payload: unknown): void {
    this.srv?.broadcast(channel, payload)
  }

  /** Runs a tool command on this node (protocol s11); the brain-side router may call it for this node itself. */
  runTool(command: unknown): Promise<DeviceToolResult> {
    if (!this.enabled) return Promise.resolve({ ok: false, error: 'Devices is off on this computer.' })
    if (this.deps.deviceTools === undefined) return Promise.resolve({ ok: false, error: 'This device shares no tools.' })
    return this.deps.deviceTools.run(command)
  }

  private async otherCommand(command: Record<string, unknown>): Promise<{ ok: boolean; note: string }> {
    const kind = command['kind']
    const url = command['url']
    if (kind === 'open_url' && typeof url === 'string' && /^https?:\/\//i.test(url) && this.deps.openUrl !== undefined) {
      await this.deps.openUrl(url)
      return { ok: true, note: 'Opened' }
    }
    if (kind === 'notify' && this.deps.notify !== undefined) {
      const title = typeof command['title'] === 'string' ? command['title'].slice(0, 120) : 'Your agent'
      const body = typeof command['body'] === 'string' ? command['body'].slice(0, 500) : ''
      this.deps.notify(title, body)
      return { ok: true, note: 'Shown' }
    }
    return { ok: false, note: 'This device does not do that.' }
  }

  private async switchOn(): Promise<void> {
    await this.listen()
    this.selfPass()
    await this.writeSelf()
    this.uplink.start()
    void this.checkFirewall(true)
  }

  /** This node's own pass, for its link to another brain; its hash sits in the mesh's pass table like any device's. */
  private selfPass(): string {
    let pass = this.deps.secrets.get(SELF_PASS)
    if (pass === null || pass === '') {
      pass = newPass()
      this.deps.secrets.set(SELF_PASS, pass)
    }
    const hash = hashPass(pass)
    if (this.passes.all()[this.identity.nodeId] !== hash) this.passes.set(this.identity.nodeId, hash)
    return pass
  }

  /** The brain this node serves its tools to: the first brain in the order, when that is not this node. */
  private uplinkTarget(): UplinkTarget | null {
    if (!this.enabled) return null
    const first = this.list().find((row) => row.roles.includes('brain') && !row.revoked)
    if (first === undefined || first.id === this.identity.nodeId || first.fp === '' || first.urls.length === 0) return null
    return { id: first.id, urls: first.urls, fp: first.fp }
  }

  /** The person's switches for which of this node's tools other devices may use. */
  shareGroups(): Record<ShareGroup, boolean> {
    return { ...DEFAULT_SHARE, ...this.config.get().shareGroups }
  }

  async setShareGroup(group: string, on: boolean): Promise<DevicesStatus> {
    const found = SHARE_GROUPS.find((g) => g === group)
    if (found === undefined) throw new Error('Unknown group')
    this.config.save({ shareGroups: { ...this.shareGroups(), [found]: on } })
    if (this.enabled) await this.writeSelf()
    this.uplink.refresh()
    this.changed()
    return this.status()
  }

  /** Re-reads Windows Firewall at most every 30 s (it runs netsh). */
  private async checkFirewall(force = false): Promise<void> {
    const firewall = this.deps.firewall
    if (firewall === undefined || !firewall.needed || !this.enabled) return
    if (!force && this.now() - this.firewallAt < 30_000) return
    this.firewallAt = this.now()
    const state = await firewall.state(this.config.get().port)
    if (state !== this.firewallState) {
      this.firewallState = state
      this.changed()
    }
  }

  /** The one UAC prompt that lets other devices in, then a fresh look at the rules. */
  async allowFirewall(): Promise<DevicesStatus> {
    const firewall = this.deps.firewall
    if (firewall !== undefined && firewall.needed) {
      await firewall.allow(this.config.get().port)
      await this.checkFirewall(true)
    }
    return this.status()
  }

  /** A device said hello: keep its latest facts and tools on its row at once (others pick it by its tools). */
  private async hello(id: string, facts: DeviceFacts): Promise<void> {
    const row = this.rows.get(id)
    if (row === undefined || row.revoked) return
    this.seenAt.set(id, this.now())
    const { tools, ...rest } = facts
    await this.saveRow({ ...row, name: facts.name, urls: facts.urls, facts: rest, tools: tools ?? [], lastSeen: this.now() }).catch(() => undefined)
  }

  selfFacts(): DeviceFacts {
    return {
      name: this.deps.nodeName(),
      kind: this.deps.kind ?? 'desktop',
      platform: platformOf(this.deps.platform),
      appVersion: this.deps.appVersion,
      screen: { width: 0, height: 0 },
      canOpenLinks: this.deps.canOpenLinks ?? true,
      canReceiveFiles: this.deps.canReceiveFiles ?? true,
      fingerprint: this.identity.fp,
      urls: this.urls(),
      tools: this.deps.deviceTools?.catalogue() ?? [],
    }
  }

  // ---- Settings > Devices ----

  /** `viewer`: the device asking (a wire caller), else this node. */
  status(viewer?: string): DevicesStatus {
    const config = this.config.get()
    // Devices never switched on: no identity is made just to show Settings.
    const id = config.enabled || this.ident !== null ? this.identity : null
    const running = this.srv?.running ?? false
    if (config.enabled) void this.checkFirewall()
    return {
      enabled: config.enabled,
      running,
      port: running ? (this.srv?.port() ?? config.port) : config.port,
      urls: id === null ? [] : this.urls(),
      extraUrls: config.extraUrls,
      nodeId: id?.nodeId ?? '',
      viewer: viewer ?? id?.nodeId ?? '',
      nodeName: this.deps.nodeName(),
      fp: id?.fp ?? '',
      fpWords: id === null ? '' : fingerprintWords(id.fp),
      connected: this.srv?.connectedIds() ?? [],
      error: this.error,
      network: this.net.status(),
      shareGroups: this.shareGroups(),
      firewall: this.deps.firewall?.needed === true && config.enabled ? this.firewallState : 'not-needed',
      servingTo: this.uplink.target ?? '',
    }
  }

  async setEnabled(on: boolean): Promise<DevicesStatus> {
    this.config.save({ enabled: on })
    if (on) await this.switchOn()
    else {
      this.offers.cancel()
      this.uplink.stop()
      await this.srv?.stop()
      this.error = ''
      setLocalOrigin(null)
    }
    this.applyNet()
    for (const listener of this.switchListeners) listener(on)
    this.changed()
    return this.status()
  }

  async setExtraUrls(urls: string[]): Promise<DevicesStatus> {
    const port = this.config.get().port
    const clean = urls.map((url) => normaliseUrl(url, port)).filter((url): url is string => url !== null)
    this.config.save({ extraUrls: clean })
    if (this.enabled) await this.writeSelf()
    this.changed()
    return this.status()
  }

  /** Changes port or listen address (tests and the headless node); restarts the server when it runs. */
  async configure(patch: Partial<DevicesConfig>): Promise<DevicesStatus> {
    this.config.save(patch)
    if (this.srv?.running === true) {
      await this.srv.stop()
      await this.listen()
    }
    this.applyNet()
    return this.status()
  }

  /** Settings > Devices > Network (protocol s10). The key goes to the secrets module only. */
  async setNetwork(raw: unknown): Promise<DevicesStatus> {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const mode = value['mode'] === 'tailscale' || value['mode'] === 'headscale' ? value['mode'] : 'none'
    const key = value['authKey']
    this.net.save({
      network: mode,
      controlUrl: typeof value['controlUrl'] === 'string' ? value['controlUrl'] : undefined,
      authKey: key === null ? null : typeof key === 'string' ? key : undefined,
    })
    this.applyNet()
    await this.writeSelf()
    this.changed()
    return this.status()
  }

  offer(): PairingOfferInfo {
    const offer = this.offers.create()
    const urls = this.urls()
    const uri = pairUri({
      meshId: this.identity.meshId,
      nodeId: this.identity.nodeId,
      name: this.deps.nodeName(),
      urls,
      fp: this.identity.fp,
      secret: offer.secret,
    })
    this.changed()
    return { uri, shortCode: formatShortCode(offer.shortCode), expiresAt: offer.expiresAt, urls, qr: qrMatrix(uri) }
  }

  cancelOffer(): void {
    this.offers.cancel()
  }

  list(): DeviceRow[] {
    return sortDevices([...this.rows.values()])
  }

  async setRoles(id: string, raw: unknown): Promise<void> {
    const row = this.rows.get(id)
    if (row === undefined || row.revoked) throw new Error('That device is not paired.')
    if (id === this.identity.nodeId) throw new Error('This computer always answers and acts as itself.')
    const roles = cleanRoles(raw)
    if (roles.length === 0) throw new Error('A device needs at least one role.')
    const becameBrain = roles.includes('brain') && !row.roles.includes('brain')
    const priority = becameBrain ? this.nextPriorityNow() : row.priority
    await this.saveRow({ ...row, roles, priority })
  }

  async move(id: string, direction: 'up' | 'down'): Promise<void> {
    const brains = this.list().filter((row) => row.roles.includes('brain') && !row.revoked)
    const at = brains.findIndex((row) => row.id === id)
    if (at < 0) throw new Error('Only devices that answer can be put in order.')
    const to = direction === 'up' ? at - 1 : at + 1
    if (to < 0 || to >= brains.length) return
    const moved = brains[at]
    const other = brains[to]
    if (moved === undefined || other === undefined) return
    brains[at] = other
    brains[to] = moved
    for (let i = 0; i < brains.length; i += 1) {
      const row = brains[i]
      if (row !== undefined && row.priority !== i) await this.saveRow({ ...row, priority: i })
    }
  }

  async revoke(id: string): Promise<void> {
    if (id === this.identity.nodeId) throw new Error('This computer cannot take itself out.')
    const row = this.rows.get(id)
    if (row === undefined) throw new Error('That device is not paired.')
    this.passes.remove(id)
    await this.saveRow({ ...row, revoked: true })
    this.srv?.closeDevice(id)
    this.changed()
  }

  registerIpc(ipc: IpcHandleLike): void {
    const id = (raw: unknown): string => {
      if (typeof raw !== 'string' || raw === '' || raw.length > 100) throw new Error('Invalid device id')
      return raw
    }
    ipc.handle(DEVICES_CHANNELS.status, async (event) => this.status(wireOf(event)?.deviceId))
    ipc.handle(DEVICES_CHANNELS.setEnabled, async (_event, on) => this.setEnabled(on === true))
    ipc.handle(DEVICES_CHANNELS.setExtraUrls, async (_event, raw) =>
      this.setExtraUrls(Array.isArray(raw) ? raw.filter((u): u is string => typeof u === 'string').slice(0, 12) : []),
    )
    ipc.handle(DEVICES_CHANNELS.setNetwork, async (_event, raw) => this.setNetwork(raw))
    ipc.handle(DEVICES_CHANNELS.offer, async () => {
      if (this.srv?.running !== true) throw new Error('Switch on "Let my other devices connect" first.')
      return this.offer()
    })
    ipc.handle(DEVICES_CHANNELS.cancelOffer, async () => this.cancelOffer())
    ipc.handle(DEVICES_CHANNELS.list, async () => this.list())
    ipc.handle(DEVICES_CHANNELS.setRoles, async (_event, raw, roles) => this.setRoles(id(raw), roles))
    ipc.handle(DEVICES_CHANNELS.move, async (_event, raw, direction) => this.move(id(raw), direction === 'up' ? 'up' : 'down'))
    ipc.handle(DEVICES_CHANNELS.revoke, async (_event, raw) => this.revoke(id(raw)))
    ipc.handle(DEVICES_CHANNELS.setShareGroup, async (_event, group, on) => this.setShareGroup(String(group), on === true))
    ipc.handle(DEVICES_CHANNELS.allowFirewall, async () => this.allowFirewall())
  }

  // ---- inside ----

  /** What this node advertises right now (no IPv6 addresses when it could only listen on IPv4). */
  private urls(): string[] {
    const port = this.srv?.running === true ? this.srv.port() : this.config.get().port
    // The overlay addresses go first while the overlay is up: they reach this node from anywhere, where interface
    // addresses only work on the same network (devices try urls in order, with a parallel probe).
    const out = this.net.urls(port)
    for (const url of advertisedUrls(this.config.get(), undefined, this.ipv6)) if (!out.includes(url)) out.push(url)
    return out
  }

  /** The overlay follows the server: it forwards to the server's port while that listens. */
  private applyNet(): void {
    this.net.apply(this.srv?.running === true ? this.srv.port() : null)
  }

  private async listen(): Promise<void> {
    const config = this.config.get()
    try {
      // "Every address" means IPv6 too: '::' takes both on a dual-stack system. Without IPv6, IPv4 only.
      if (config.listen === '0.0.0.0') {
        try {
          await this.server.start('::', config.port)
          this.ipv6 = true
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL' && code !== 'EINVAL') throw error
          await this.server.start('0.0.0.0', config.port)
          this.ipv6 = false
        }
      } else {
        await this.server.start(config.listen, config.port)
        this.ipv6 = config.listen.includes(':')
      }
      this.error = ''
      this.deps.log?.('Devices server listening', { port: this.server.port() })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      this.error =
        code === 'EADDRINUSE'
          ? `Port ${config.port} is already in use on this computer. Close what uses it, or choose another port.`
          : 'The devices server could not start on this computer.'
      this.deps.log?.('Devices server failed', { code: code ?? '', message: error instanceof Error ? error.message : '' })
    }
  }

  private changed(): void {
    this.deps.emitWindow(DEVICES_EVENTS.changed, null)
    this.srv?.emit(null, DEVICES_EVENTS.changed, null)
  }

  private async reloadRows(): Promise<void> {
    const rows = await this.deps.store.list('device')
    this.rows = new Map(rows.map((row) => [row.id, row]))
  }

  private async saveRow(record: DeviceRecord | DeviceRow): Promise<void> {
    const saved = await this.deps.store.upsert('device', record)
    this.rows.set(saved.id, saved)
  }

  private nextPriorityNow(): number {
    let max = -1
    for (const row of this.rows.values()) if (row.roles.includes('brain') && !row.revoked) max = Math.max(max, row.priority)
    return max + 1
  }

  /** This node's own row: always a brain and hands; its place in the brain order is the person's. */
  private async writeSelf(): Promise<void> {
    const { tools, ...facts } = this.selfFacts()
    const existing = this.rows.get(this.identity.nodeId)
    const priority = existing?.priority ?? this.nextPriorityNow()
    const record: DeviceRecord = {
      id: this.identity.nodeId,
      name: facts.name,
      kind: facts.kind,
      platform: facts.platform,
      roles: ['brain', 'hands'],
      priority,
      urls: facts.urls,
      fp: this.identity.fp,
      facts,
      pairedAt: existing?.pairedAt ?? this.now(),
      lastSeen: this.now(),
      revoked: false,
      tools: tools ?? [],
    }
    const same = existing !== undefined && JSON.stringify(toRecord({ ...existing, lastSeen: 0 })) === JSON.stringify({ ...record, lastSeen: 0 })
    if (!same) await this.saveRow(record)
    setLocalOrigin(originFrom(this.identity.nodeId, facts))
  }

  private seen(id: string): void {
    const at = this.now()
    if (at - (this.seenAt.get(id) ?? 0) < SEEN_EVERY_MS) return
    this.seenAt.set(id, at)
    const row = this.rows.get(id)
    if (row === undefined || row.revoked) return
    const facts = this.srv?.factsOf(id) ?? null
    let patch: DeviceRow = { ...row, lastSeen: at }
    if (facts !== null) {
      const { tools: _tools, ...plain } = facts
      patch = { ...patch, facts: plain, name: facts.name, urls: facts.urls }
    }
    void this.saveRow(patch).catch(() => undefined)
  }

  private brains(): BrainRef[] {
    return this.list()
      .filter((row) => row.roles.includes('brain') && !row.revoked)
      .map((row) => ({ id: row.id, name: row.name, urls: row.urls, fp: row.fp, priority: row.priority }))
  }

  /** Whether a device may fetch this file (protocol s5: named in a chat, the attachments folder, a project folder). */
  async fileAllowed(raw: string): Promise<string | null> {
    if (raw === '' || raw.length > 4096 || raw.includes('\0')) return null
    const target = real(resolve(normalize(raw)))
    if (target === null || !statSync(target).isFile()) return null
    const cached = this.allowedCache.get(target)
    if (cached !== undefined && this.now() - cached < 10 * 60_000) return target
    const folders = [join(this.deps.userData, 'attachments'), join(this.deps.userData, 'voice-notes')]
    for (const project of await this.deps.store.list('project')) if (typeof project.path === 'string' && project.path.trim() !== '') folders.push(project.path)
    let ok = folders.some((folder) => {
      const root = real(folder)
      return root !== null && isInside(target, root)
    })
    if (!ok) {
      const forms = new Set([raw, target, JSON.stringify(raw).slice(1, -1), JSON.stringify(target).slice(1, -1)])
      const rows = await this.deps.store.list('chat_item')
      ok = rows.some((row) => [...forms].some((form) => row.text.includes(form) || row.meta.includes(form)))
    }
    if (ok) this.allowedCache.set(target, this.now())
    return ok ? target : null
  }

  private mountRoutes(): void {
    const host = this.server
    host.addRoute({
      method: 'GET',
      path: '/v1/health',
      auth: 'none',
      handle: async () => ({
        status: 200,
        json: {
          id: this.identity.nodeId,
          name: this.deps.nodeName(),
          version: this.deps.appVersion,
          roles: ['brain', 'hands'],
          ready: this.deps.ready(),
          busy: this.deps.busy(),
          meshId: this.identity.meshId,
        },
      }),
    })
    host.addRoute({
      method: 'POST',
      path: '/v1/pair',
      auth: 'none',
      handle: async (req) => {
        const answer = await handlePair(req.body, {
          offers: this.offers,
          passes: this.passes,
          meshId: this.identity.meshId,
          node: { id: this.identity.nodeId, name: this.deps.nodeName() },
          saveDevice: (row) => this.saveRow(row),
          brains: async () => this.brains(),
          nextPriority: async () => this.nextPriorityNow(),
          now: this.now,
        })
        if (answer.status === 200) {
          this.deps.log?.('Device paired')
          this.changed()
        }
        return answer
      },
    })
    host.addRoute({
      method: 'GET',
      path: '/v1/devices',
      auth: 'device',
      handle: async () => ({ status: 200, json: { devices: this.list(), answering: this.identity.nodeId, connected: this.server.connectedIds() } }),
    })
    host.addRoute({
      method: 'POST',
      path: '/v1/devices/:id/revoke',
      auth: 'node',
      handle: async (req) => {
        const id = req.params['id'] ?? ''
        if (!this.rows.has(id)) return { status: 404, json: { error: 'That device is not paired.' } }
        if (id === this.identity.nodeId) return { status: 400, json: { error: 'A node cannot be taken out from itself.' } }
        await this.revoke(id)
        return { status: 200, json: { ok: true } }
      },
    })
    host.addRoute({
      method: 'GET',
      path: '/v1/file',
      auth: 'device',
      handle: async (req) => {
        const path = req.query.get('path') ?? ''
        const allowed = await this.fileAllowed(path)
        if (allowed === null) return { status: 404, json: { error: 'That file is not shared with your devices.' } }
        return { status: 200, file: allowed, contentType: contentTypeFor(allowed), headers: { 'Cache-Control': 'private, max-age=300' } }
      },
    })
    const toApp = async (): Promise<RouteReply> => ({ status: 302, text: '', headers: { Location: '/app/' } })
    host.addRoute({ method: 'GET', path: '/', auth: 'none', handle: toApp })
    host.addRoute({ method: 'GET', path: '/app', auth: 'none', handle: toApp })
    host.addRoute({ method: 'GET', path: '/app/*', auth: 'none', handle: (req) => this.serveApp(req) })
  }

  /** The web UI. A paired device's WebView carries the pass as a cookie; `?k=<pass>` sets that cookie once. */
  private async serveApp(req: RouteRequest): Promise<RouteReply> {
    const fromQuery = req.query.get('k') ?? ''
    if (fromQuery !== '') {
      const id = this.passes.deviceFor(fromQuery)
      const row = id === null ? undefined : this.rows.get(id)
      if (row === undefined || row.revoked) return this.signedOutPage(401)
      const cookie = `agent_pass=${fromQuery}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_DAYS * 86400}`
      return { status: 302, text: '', headers: { Location: '/app/', 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } }
    }
    if (this.server.deviceFor(req.headers) === null) return this.signedOutPage(401)
    const rest = req.params['*'] ?? ''
    const root = resolve(this.deps.rendererDir)
    const file = resolve(root, rest === '' ? 'index.html' : rest)
    if (!isInside(file, root) || !existsSync(file) || !statSync(file).isFile()) {
      // A path inside the app the router owns (no file): the app itself.
      if (rest.includes('.')) return { status: 404, json: { error: 'Not found.' } }
      return this.indexPage()
    }
    if (file.endsWith('index.html')) return this.indexPage()
    return { status: 200, file, contentType: contentTypeFor(file), headers: { 'Cache-Control': 'private, max-age=86400' } }
  }

  private async indexPage(): Promise<RouteReply> {
    let html: string
    try {
      html = await readFile(join(this.deps.rendererDir, 'index.html'), 'utf8')
    } catch {
      return { status: 503, text: 'The app is not built on this computer.', contentType: 'text/plain; charset=utf-8' }
    }
    // The page knows it is the remote window: bridge/index.ts picks the remote bridge on this tag.
    const tagged = html.replace('<head>', '<head>\n    <meta name="agent-remote" content="1" />')
    return { status: 200, text: tagged, contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-cache' } }
  }

  private signedOutPage(status: number): RouteReply {
    const html =
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>Agent</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;' +
      'background:#f6f5f2;color:#1d1b18}main{max-width:360px;padding:24px}h1{font-size:20px;margin:0 0 8px}' +
      '@media (prefers-color-scheme:dark){body{background:#141312;color:#ecebe8}}</style></head><body><main>' +
      '<h1>This device is not linked yet</h1><p>Open Settings, then Devices, on the computer and choose Add a device. ' +
      'Then scan the code with the Agent app on this device.</p></main></body></html>'
    return { status, text: html, contentType: 'text/html; charset=utf-8', headers: { 'Cache-Control': 'no-store' } }
  }
}

let current: DevicesService | null = null

export function setDevicesService(service: DevicesService | null): void {
  current = service
}

/** The node server for the parts that plug in (workstream B): null before the app has started its services. */
export function getDevicesHost(): DevicesHost | null {
  return current?.host() ?? null
}

export function getDevicesService(): DevicesService | null {
  return current
}

export type { DeviceRole }
