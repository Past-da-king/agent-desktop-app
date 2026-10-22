/**
 * Local files for connections, under the app's userData folder. Nothing here is a secret: the
 * Composio key lives in the secrets module only.
 *
 *   connected-apps.json  { userId, rules }   our Composio user id and the rules per account
 *   learned-apps.json    [LearnedApp, ...]   sites the agent mapped and the tools it saved
 *
 * Learned apps are deliberately not a synced entity yet; they stay on this computer, as on the phone
 * (reference connections/Learned.kt keeps them in local settings).
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { DEFAULT_ACCOUNT_RULES, type AccountRules, type AppRule, type JsonObject } from '@agent/core'

const RULES: readonly AppRule[] = ['allow', 'ask', 'never']

export function isRule(value: unknown): value is AppRule {
  return typeof value === 'string' && (RULES as readonly string[]).includes(value)
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(temp, path)
}

/** Our Composio user id (one per install, so connections survive restarts) and each account's rules. */
export class ConnectedAppsFile {
  private userIdValue: string
  private rules: Record<string, AccountRules>

  constructor(private readonly path: string) {
    const raw = readJson(path)
    const object = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const id = object['userId']
    this.userIdValue = typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : ''
    this.rules = {}
    const rules = object['rules']
    if (rules !== null && typeof rules === 'object') {
      for (const [account, value] of Object.entries(rules as Record<string, unknown>)) {
        if (value === null || typeof value !== 'object') continue
        const rule = value as Record<string, unknown>
        this.rules[account] = {
          read: isRule(rule['read']) ? rule['read'] : DEFAULT_ACCOUNT_RULES.read,
          change: isRule(rule['change']) ? rule['change'] : DEFAULT_ACCOUNT_RULES.change,
        }
      }
    }
  }

  userId(): string {
    if (this.userIdValue === '') {
      this.userIdValue = `agent-desktop-${randomBytes(8).toString('hex')}`
      this.persist()
    }
    return this.userIdValue
  }

  /** Every account's rules (devices/bundle.ts). */
  allRules(): Record<string, AccountRules> {
    return Object.fromEntries(Object.entries(this.rules).map(([id, rule]) => [id, { ...rule }]))
  }

  replaceRules(rules: Record<string, AccountRules>): void {
    this.rules = {}
    for (const [id, rule] of Object.entries(rules)) {
      this.rules[id] = { read: isRule(rule?.read) ? rule.read : DEFAULT_ACCOUNT_RULES.read, change: isRule(rule?.change) ? rule.change : DEFAULT_ACCOUNT_RULES.change }
    }
    this.persist()
  }

  /** The same Composio user on every brain, so the person's connections work wherever a turn runs. */
  setUserId(id: string): void {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id) || id === this.userIdValue) return
    this.userIdValue = id
    this.persist()
  }

  rulesFor(accountId: string | null): AccountRules {
    if (accountId === null) return { ...DEFAULT_ACCOUNT_RULES }
    return { ...(this.rules[accountId] ?? DEFAULT_ACCOUNT_RULES) }
  }

  setRules(accountId: string, rules: AccountRules): void {
    this.rules[accountId] = { read: rules.read, change: rules.change }
    this.persist()
  }

  forget(accountId: string): void {
    delete this.rules[accountId]
    this.persist()
  }

  private persist(): void {
    writeJson(this.path, { userId: this.userIdValue, rules: this.rules })
  }
}

// ---- learned apps ------------------------------------------------------------------------------

/** One thing a learned app can do: the body of an async function that sees `args`, run in the page. */
export interface LearnedTool {
  name: string
  description: string
  /** Input name -> { type, description }. */
  params: JsonObject
  required: string[]
  js: string
  readOnly: boolean
}

export interface LearnedApp {
  id: string
  name: string
  startUrl: string
  about: string
  tools: LearnedTool[]
  /** Its tools that change things run without asking each time. Only the person can turn this on. */
  trusted: boolean
  updatedAt: number
  /** The site's own icon, fetched once and kept (a data: URL), so the list shows it with no network call. */
  icon?: string
}

export const MAX_APPS = 30
export const MAX_TOOLS = 40
export const MAX_JS = 12_000

/** a-z, 0-9 and underscores: what an app id is made of. */
export function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24)
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function toTool(raw: unknown): LearnedTool | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['name'] !== 'string' || typeof o['js'] !== 'string') return null
  const params = o['params'] !== null && typeof o['params'] === 'object' && !Array.isArray(o['params']) ? (o['params'] as JsonObject) : {}
  const required = Array.isArray(o['required']) ? o['required'].filter((r): r is string => typeof r === 'string') : []
  return {
    name: o['name'],
    description: typeof o['description'] === 'string' ? o['description'] : '',
    params,
    required,
    js: o['js'],
    readOnly: o['readOnly'] !== false,
  }
}

function toApp(raw: unknown): LearnedApp | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['id'] !== 'string' || typeof o['startUrl'] !== 'string') return null
  const tools = Array.isArray(o['tools']) ? o['tools'].map(toTool).filter((t): t is LearnedTool => t !== null) : []
  return {
    id: o['id'],
    name: typeof o['name'] === 'string' ? o['name'] : o['id'],
    startUrl: o['startUrl'],
    about: typeof o['about'] === 'string' ? o['about'] : '',
    tools,
    trusted: o['trusted'] === true,
    updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : 0,
    ...(typeof o['icon'] === 'string' && o['icon'].startsWith('data:image/') ? { icon: o['icon'] } : {}),
  }
}

/** The apps the agent has learned, in learned-apps.json. */
export class LearnedStore {
  private list: LearnedApp[]
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    const raw = readJson(path)
    this.list = Array.isArray(raw) ? raw.map(toApp).filter((a): a is LearnedApp => a !== null) : []
  }

  apps(): LearnedApp[] {
    return this.list.map((app) => ({ ...app, tools: [...app.tools] }))
  }

  find(ref: string): LearnedApp | null {
    const trimmed = ref.trim()
    return (
      this.list.find((a) => a.id === trimmed) ??
      this.list.find((a) => a.name.toLowerCase() === trimmed.toLowerCase() || a.id === slugOf(trimmed)) ??
      null
    )
  }

  /** Saving over an app of the same id replaces its tools but keeps what the person decided about trust. */
  save(app: LearnedApp): void {
    const old = this.list.find((a) => a.id === app.id)
    const next = { ...app, trusted: old?.trusted ?? false, updatedAt: this.now(), ...(old?.icon === undefined ? {} : { icon: old.icon }) }
    this.list = [...this.list.filter((a) => a.id !== app.id), next]
    this.persist()
  }

  setIcon(id: string, icon: string): void {
    this.list = this.list.map((a) => (a.id === id ? { ...a, icon } : a))
    this.persist()
  }

  setTrusted(id: string, trusted: boolean): void {
    this.list = this.list.map((a) => (a.id === id ? { ...a, trusted } : a))
    this.persist()
  }

  remove(id: string): void {
    this.list = this.list.filter((a) => a.id !== id)
    this.persist()
  }

  /** Everything at once, from another of the person's devices (devices/bundle.ts). */
  replaceAll(list: LearnedApp[]): void {
    this.list = list.map(toApp).filter((a): a is LearnedApp => a !== null).slice(0, MAX_APPS)
    this.persist()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private persist(): void {
    writeJson(this.path, this.list)
    for (const listener of this.listeners) listener()
  }
}
