/**
 * The state bundle (docs/devices-protocol.md s6): what a device needs that is not in synced rows.
 *
 *   GET /v1/bundle  ->  { version, changedAt, settings, profiles, projects, learnedApps, connectedApps, accounts,
 *                         secrets? }
 *
 * `secrets` (AI account keys, the Composio key and user id, the voice key, the mesh pass-hash table) is added ONLY
 * when the caller's device row has the role 'brain'. A screen never gets it. Nothing here logs a secret value.
 *
 * Changes: the BundleKeeper notices a local change (a key added, a profile renamed) by hashing the brain bundle,
 * stamps it with `changedAt`, and tells connected brains with the event `devices.bundle` { version }; they read the
 * bundle again. Replication pull answers also carry `bundle` (the version), so a brain that is not connected over
 * RPC still sees the change and reads it. The newest `changedAt` wins; applying keeps the sender's `changedAt`, so
 * two brains never bounce a bundle back and forth.
 */
import { createHash, randomBytes } from 'node:crypto'

import {
  keyNameFor,
  type AccountRules,
  type AgentProfileInfo,
  type AiAccount,
  type DeviceRow,
  type ProjectRow,
  type Settings,
} from '@agent/core'

import type { LearnedApp } from '../apps/store'
import type { DevicesHost, PassTable } from './types'

/** Settings that belong to the person, not to one machine (hotkeys, folders, start-up and sync stay local). */
export const SHARED_SETTINGS = [
  'userName',
  'agentName',
  'accent',
  'mascot',
  'theme',
  'notifications',
  'voiceName',
  'speakReplies',
  'dailyMemoryAt',
  'mode',
  'cli',
  'cliModel',
  'provider',
  'model',
  'baseUrl',
  'allowHttp',
  'ai',
  'devicesPreferred',
] as const satisfies ReadonlyArray<keyof Settings>

export type SharedSettings = Partial<Pick<Settings, (typeof SHARED_SETTINGS)[number]>>

export interface BundleSecrets {
  /** Secret name (apiKey, apiKey-<account>) -> key. */
  keys: Record<string, string>
  composioKey?: string
  composioUserId?: string
  geminiKey?: string
  /** deviceId -> sha256(pass) hex. */
  passes: Record<string, string>
}

export interface StateBundle {
  version: string
  changedAt: number
  settings: SharedSettings
  profiles: AgentProfileInfo[]
  projects: ProjectRow[]
  learnedApps: LearnedApp[]
  connectedApps: { rules: Record<string, AccountRules> }
  /** The AI accounts, never with keys (hasKey says whether this node has one). */
  accounts: AiAccount[]
  secrets?: BundleSecrets
}

/** Where the bundle's parts live on this node. Each is optional so a headless node can bring what it has. */
export interface BundleSources {
  settings: { get(): Settings; save(patch: Partial<Settings>): Settings; onChange?(listener: () => void): () => void }
  secrets: { get(name: string): string | null; set(name: string, value: string): void; delete(name: string): void }
  profiles?: { all(): AgentProfileInfo[]; replaceAll(list: AgentProfileInfo[]): void; onChange?(listener: () => void): () => void }
  learned?: { apps(): LearnedApp[]; replaceAll(list: LearnedApp[]): void; onChange?(listener: () => void): () => void }
  connected?: { allRules(): Record<string, AccountRules>; replaceRules(rules: Record<string, AccountRules>): void; userId(): string; setUserId(id: string): void }
  passes?: PassTable
  projects?: () => Promise<ProjectRow[]>
  /** Kept on this device only: the bundle's hash and changedAt. */
  local: { localValue(key: string): string | null; setLocalValue(key: string, value: string): void }
  now?: () => number
}

const COMPOSIO = 'composioKey'
const GEMINI = 'geminiKey'

export class BundleKeeper {
  private readonly listeners = new Set<(version: string) => void>()
  private readonly offs: Array<() => void> = []
  private applying = false

  constructor(private readonly sources: BundleSources) {}

  /** Watch the parts that can say when they change; secrets cannot, so call check() after a key is saved too. */
  watch(): void {
    const check = (): void => void this.check()
    for (const part of [this.sources.settings, this.sources.profiles, this.sources.learned]) {
      const off = part?.onChange?.(check)
      if (off !== undefined) this.offs.push(off)
    }
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off()
  }

  onChanged(listener: (version: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  version(): string {
    this.check()
    return this.versionOf(this.changedAt())
  }

  /** The bundle for a caller: secrets only for a brain. */
  async build(forBrain: boolean): Promise<StateBundle> {
    this.check()
    const body = this.content()
    const projects = this.sources.projects !== undefined ? await this.sources.projects() : []
    const changedAt = this.changedAt()
    const bundle: StateBundle = {
      version: this.versionOf(changedAt),
      changedAt,
      settings: body.settings,
      profiles: body.profiles,
      projects,
      learnedApps: body.learnedApps,
      connectedApps: body.connectedApps,
      accounts: body.accounts,
    }
    if (forBrain) bundle.secrets = body.secrets
    return bundle
  }

  /**
   * Notice a local change: when the content differs from what was last seen, stamp it now and tell listeners.
   * True when it changed.
   */
  check(): boolean {
    if (this.applying) return false
    const hash = this.hashOf(this.content())
    const seen = this.sources.local.localValue('bundle_hash')
    if (hash === seen) return false
    if (seen === null) {
      // The first look on this install is the baseline, not a change: changedAt 0, so any brain's bundle is newer.
      this.sources.local.setLocalValue('bundle_hash', hash)
      this.sources.local.setLocalValue('bundle_changed_at', '0')
      return false
    }
    this.sources.local.setLocalValue('bundle_hash', hash)
    this.sources.local.setLocalValue('bundle_changed_at', String(this.now()))
    const version = this.versionOf(this.changedAt())
    for (const listener of this.listeners) {
      try {
        listener(version)
      } catch {
        // A listener is a transport; one failing must not stop the others.
      }
    }
    return true
  }

  /**
   * Write a bundle from another node into this node's own stores. Only a newer one is applied (by changedAt), unless
   * `force` (joining a mesh: the brain we paired with wins). True when it was applied.
   */
  apply(bundle: StateBundle, force = false): boolean {
    this.check()
    if (!force && !(bundle.changedAt > this.changedAt())) return false
    this.applying = true
    try {
      this.write(bundle)
    } finally {
      this.applying = false
    }
    // What we now hold is the sender's bundle as of its changedAt: not a local change to send back.
    this.sources.local.setLocalValue('bundle_hash', this.hashOf(this.content()))
    this.sources.local.setLocalValue('bundle_changed_at', String(Math.max(bundle.changedAt, force ? this.changedAt() : 0)))
    return true
  }

  private write(bundle: StateBundle): void {
    const { settings, secrets, profiles, learned, connected, passes } = this.sources
    const incomingIds = new Set(bundle.accounts.map((account) => account.id))

    if (bundle.secrets !== undefined) {
      const s = bundle.secrets
      for (const [name, value] of Object.entries(s.keys)) {
        if (/^apiKey(-[A-Za-z0-9_-]+)?$/.test(name) && typeof value === 'string' && value !== '') secrets.set(name, value)
      }
      if (typeof s.composioKey === 'string' && s.composioKey !== '') secrets.set(COMPOSIO, s.composioKey)
      if (typeof s.geminiKey === 'string' && s.geminiKey !== '') secrets.set(GEMINI, s.geminiKey)
      if (typeof s.composioUserId === 'string' && s.composioUserId !== '') connected?.setUserId(s.composioUserId)
      passes?.replaceAll({ ...s.passes })
      // An account removed on the other brain takes its key with it.
      for (const account of settings.get().accounts) if (!incomingIds.has(account.id)) secrets.delete(keyNameFor(account.id))
    }

    const accounts = bundle.accounts.map((account) => ({ ...account, hasKey: account.kind === 'api' ? hasValue(secrets.get(keyNameFor(account.id))) : false }))
    const patch: Partial<Settings> = { ...pickShared(bundle.settings), accounts }
    if (bundle.secrets !== undefined) patch.hasVoiceKey = hasValue(secrets.get(GEMINI))
    settings.save(patch)
    profiles?.replaceAll(bundle.profiles)
    learned?.replaceAll(bundle.learnedApps)
    connected?.replaceRules(bundle.connectedApps.rules)
  }

  private content(): Omit<StateBundle, 'version' | 'changedAt' | 'projects'> & { secrets: BundleSecrets } {
    const current = this.sources.settings.get()
    const accounts = current.accounts.map((account) => ({ ...account }))
    const keys: Record<string, string> = {}
    for (const account of accounts) {
      const value = this.sources.secrets.get(keyNameFor(account.id))
      if (hasValue(value)) keys[keyNameFor(account.id)] = value
    }
    const legacy = this.sources.secrets.get('apiKey')
    if (hasValue(legacy)) keys['apiKey'] = legacy
    const secrets: BundleSecrets = { keys, passes: this.sources.passes?.all() ?? {} }
    const composio = this.sources.secrets.get(COMPOSIO)
    if (hasValue(composio)) secrets.composioKey = composio
    const gemini = this.sources.secrets.get(GEMINI)
    if (hasValue(gemini)) secrets.geminiKey = gemini
    const connected = this.sources.connected
    if (connected !== undefined) secrets.composioUserId = connected.userId()
    return {
      settings: pickShared(current),
      profiles: this.sources.profiles?.all() ?? [],
      learnedApps: this.sources.learned?.apps() ?? [],
      connectedApps: { rules: connected?.allRules() ?? {} },
      // hasKey is this node's own fact; leave it out of the hash so it never looks like a change.
      accounts: accounts.map((account) => ({ ...account, hasKey: false })),
      secrets,
    }
  }

  private changedAt(): number {
    const raw = Number(this.sources.local.localValue('bundle_changed_at') ?? '0')
    return Number.isFinite(raw) ? raw : 0
  }

  /** A version that says nothing about the content: when it changed, plus a few bytes of a salted hash. */
  private versionOf(changedAt: number): string {
    return `${changedAt}-${(this.sources.local.localValue('bundle_hash') ?? '').slice(0, 12)}`
  }

  private hashOf(content: unknown): string {
    let salt = this.sources.local.localValue('bundle_salt')
    if (salt === null) {
      salt = randomBytes(16).toString('hex')
      this.sources.local.setLocalValue('bundle_salt', salt)
    }
    return createHash('sha256').update(salt).update(stableJson(content)).digest('hex')
  }

  private now(): number {
    return this.sources.now?.() ?? Date.now()
  }
}

export interface BundleRouteDeps {
  keeper: BundleKeeper
  /** The device rows, to tell a brain from a screen and to find the brains to tell about a change. */
  devices: () => Promise<DeviceRow[]>
}

export function isBrainRow(row: DeviceRow | undefined): boolean {
  return row !== undefined && !row.revoked && row.roles.includes('brain')
}

/** GET /v1/bundle, and `devices.bundle` events to connected brains when the bundle changes. */
export function registerBundle(host: DevicesHost, deps: BundleRouteDeps): () => void {
  host.addRoute({
    method: 'GET',
    path: '/v1/bundle',
    auth: 'device',
    async handle(req) {
      const rows = await deps.devices()
      const caller = rows.find((row) => row.id === req.deviceId)
      return { status: 200, json: await deps.keeper.build(isBrainRow(caller)) }
    },
  })
  return deps.keeper.onChanged((version) => {
    void deps.devices().then((rows) => {
      for (const row of rows) {
        if (row.id === host.self().id || !isBrainRow(row) || !host.isConnected(row.id)) continue
        host.emit(row.id, 'devices.bundle', { version })
      }
    })
  })
}

/** Read a peer's bundle and apply it. False when it could not be read or was not newer. `force` right after pairing. */
export async function pullBundle(keeper: BundleKeeper, url: string, pass: string, fetchImpl: typeof fetch, force = false): Promise<boolean> {
  const res = await fetchImpl(`${url.replace(/\/+$/, '')}/v1/bundle`, { headers: { Authorization: `Bearer ${pass}` } })
  if (!res.ok) return false
  const parsed = parseBundle(await res.json())
  return parsed === null ? false : keeper.apply(parsed, force)
}

/** A bundle as read off the wire, or null when it is not one. Only known shapes go further. */
export function parseBundle(value: unknown): StateBundle | null {
  if (!isRecord(value)) return null
  if (typeof value['changedAt'] !== 'number' || !isRecord(value['settings'])) return null
  const list = <T>(key: string): T[] => (Array.isArray(value[key]) ? (value[key] as T[]) : [])
  const connected = isRecord(value['connectedApps']) && isRecord(value['connectedApps']['rules']) ? (value['connectedApps']['rules'] as Record<string, AccountRules>) : {}
  const bundle: StateBundle = {
    version: typeof value['version'] === 'string' ? value['version'] : '',
    changedAt: value['changedAt'],
    settings: pickShared(value['settings'] as Partial<Settings>),
    profiles: list<AgentProfileInfo>('profiles').filter((p) => isRecord(p) && typeof p.id === 'string'),
    projects: list<ProjectRow>('projects'),
    learnedApps: list<LearnedApp>('learnedApps').filter((a) => isRecord(a) && typeof a.id === 'string'),
    connectedApps: { rules: connected },
    accounts: list<AiAccount>('accounts').filter((a) => isRecord(a) && typeof a.id === 'string'),
  }
  const s = value['secrets']
  if (isRecord(s)) {
    const keys: Record<string, string> = {}
    if (isRecord(s['keys'])) for (const [k, v] of Object.entries(s['keys'])) if (typeof v === 'string') keys[k] = v
    const passes: Record<string, string> = {}
    if (isRecord(s['passes'])) for (const [k, v] of Object.entries(s['passes'])) if (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) passes[k] = v
    bundle.secrets = { keys, passes }
    if (typeof s['composioKey'] === 'string') bundle.secrets.composioKey = s['composioKey']
    if (typeof s['composioUserId'] === 'string') bundle.secrets.composioUserId = s['composioUserId']
    if (typeof s['geminiKey'] === 'string') bundle.secrets.geminiKey = s['geminiKey']
  }
  return bundle
}

function pickShared(from: Partial<Settings>): SharedSettings {
  const out: Record<string, unknown> = {}
  for (const key of SHARED_SETTINGS) if (from[key] !== undefined) out[key] = from[key]
  return out as SharedSettings
}

function hasValue(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
