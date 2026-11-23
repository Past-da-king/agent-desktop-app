/**
 * One sign-in home per plan account.
 *
 * A plan account (Claude, ChatGPT) is a login. The engines keep that login in a folder: Claude in CLAUDE_CONFIG_DIR
 * (default ~/.claude), Codex in CODEX_HOME (default ~/.codex). Before 23 Nov 2026 every plan account of a kind shared
 * the one folder, so a second ChatGPT account was "signed in" the moment it was added and could never be a different
 * person. Now every account has its own folder under the app's data (<root>/<account id>/), and this file is the ONE
 * place that decides which folder an account uses and sets those variables for an engine.
 *
 * Migration in place: on the first run with accounts, the first account of each kind keeps the computer's own login
 * folder (recorded in the homes file as shared), so nobody signs in again. Every account added later, and every
 * second account of a kind that already existed, gets a fresh empty home.
 *
 * Nothing here returns or logs a token. Identity (email, plan) is read from the id token's public claims and from the
 * engine's own status; usage from the numbers the plan reports.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

import type { AiAccount, AiUsageWindow } from '@agent/core'

export type PlanKind = 'claude' | 'codex'

/** The variable each engine reads its sign-in folder from. Only engineHomeEnv sets them. */
export const HOME_VARS: Record<PlanKind, string> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }

/** The folder an engine uses when nothing says otherwise: the computer's own login. */
export function sharedHome(cli: PlanKind, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const set = env[HOME_VARS[cli]]?.trim() ?? ''
  if (set !== '') return set
  return join(home, cli === 'claude' ? '.claude' : '.codex')
}

export interface HomeEntry {
  cli: PlanKind
  /** The sign-in folder. */
  dir: string
  /** True: the computer's own login (kept for the first account of each kind so nobody signs in again). */
  shared: boolean
}

interface HomesFile {
  version: 1
  /** Set once there were accounts to migrate; until then nothing is claimed. */
  migrated: boolean
  entries: Record<string, HomeEntry>
}

export interface AccountHomesOptions {
  /** Where the homes file lives (a local file, never synced). */
  file: string
  /** Where fresh homes are made: <root>/<account id>. */
  root: string
  accounts: () => AiAccount[]
  env?: NodeJS.ProcessEnv
  home?: string
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_') || '_'
}

export class AccountHomes {
  private readonly env: NodeJS.ProcessEnv
  private readonly home: string
  private data: HomesFile | null = null

  constructor(private readonly options: AccountHomesOptions) {
    this.env = options.env ?? process.env
    this.home = options.home ?? homedir()
  }

  private load(): HomesFile {
    if (this.data !== null) return this.data
    try {
      const parsed = JSON.parse(readFileSync(this.options.file, 'utf8')) as Partial<HomesFile>
      if (parsed !== null && typeof parsed === 'object' && parsed.entries !== undefined && typeof parsed.entries === 'object') {
        this.data = { version: 1, migrated: parsed.migrated === true, entries: parsed.entries as Record<string, HomeEntry> }
        return this.data
      }
    } catch {
      // No file yet.
    }
    this.data = { version: 1, migrated: false, entries: {} }
    return this.data
  }

  private save(): void {
    if (this.data === null) return
    mkdirSync(dirname(this.options.file), { recursive: true })
    const temp = `${this.options.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.data, null, 1), { mode: 0o600 })
    renameSync(temp, this.options.file)
  }

  private freshDir(id: string): string {
    return join(this.options.root, safeId(id))
  }

  /**
   * Gives every plan account without a home one: the computer's own login for the first of each kind (only in the
   * run that migrates), a fresh folder otherwise. Cheap and idempotent: called before every lookup.
   */
  migrate(): void {
    const data = this.load()
    const plans = this.options.accounts().filter((account): account is AiAccount & { kind: PlanKind } => account.kind !== 'api')
    let changed = false
    if (!data.migrated && plans.length > 0) {
      for (const cli of ['claude', 'codex'] as const) {
        const first = plans.find((account) => account.kind === cli && data.entries[account.id] === undefined)
        if (first !== undefined && !Object.values(data.entries).some((entry) => entry.shared && entry.cli === cli)) {
          data.entries[first.id] = { cli, dir: sharedHome(cli, this.env, this.home), shared: true }
        }
      }
      data.migrated = true
      changed = true
    }
    for (const account of plans) {
      if (data.entries[account.id] === undefined) {
        data.entries[account.id] = { cli: account.kind, dir: this.freshDir(account.id), shared: false }
        changed = true
      }
    }
    if (changed) this.save()
  }

  /**
   * The home an account signs in to and runs from, made on disk. No account id (an older caller): the computer's own
   * login, as before. So does an id the list does not hold.
   */
  resolve(accountId: string | undefined, cli: PlanKind): HomeEntry {
    const wanted = (accountId ?? '').trim()
    if (wanted === '') return { cli, dir: sharedHome(cli, this.env, this.home), shared: true }
    this.migrate()
    const data = this.load()
    let entry = data.entries[wanted]
    // An id the accounts list does not hold (a turn for an account this computer does not know) is not an account
    // with a home of its own: it runs as before, on the computer's own login, and nothing is recorded for it.
    if (entry === undefined && !this.options.accounts().some((account) => account.id === wanted)) {
      return { cli, dir: sharedHome(cli, this.env, this.home), shared: true }
    }
    if (entry === undefined || entry.cli !== cli) {
      entry = { cli, dir: this.freshDir(wanted), shared: false }
      data.entries[wanted] = entry
      this.save()
    }
    if (!entry.shared) mkdirSync(entry.dir, { recursive: true })
    return entry
  }

  /** Every recorded home (for tests and the status screen). */
  entries(): Record<string, HomeEntry> {
    this.migrate()
    return { ...this.load().entries }
  }

  /** An account was removed: its record goes, and its own folder (never the computer's shared login). */
  forget(accountId: string): void {
    const data = this.load()
    const entry = data.entries[accountId]
    if (entry === undefined) return
    delete data.entries[accountId]
    this.save()
    if (!entry.shared && inside(resolve(entry.dir), resolve(this.options.root))) rmSync(entry.dir, { recursive: true, force: true })
  }
}

function inside(path: string, root: string): boolean {
  return path !== root && path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * The environment an engine starts with for one account's home. The ONLY place CLAUDE_CONFIG_DIR and CODEX_HOME are
 * set: the account's own folder, and never the other tool's variable or a stray value from the app's environment.
 * The computer's own login keeps the engine's default (variable unset) unless the environment already named one, so
 * the first account behaves exactly as it did before.
 */
export function engineHomeEnv(entry: Pick<HomeEntry, 'cli' | 'dir' | 'shared'>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (typeof value === 'string') env[key] = value
  const name = HOME_VARS[entry.cli]
  if (entry.shared) {
    if ((base[name]?.trim() ?? '') === '') delete env[name]
  } else {
    env[name] = entry.dir
  }
  return env
}

// ---- who is signed in ----------------------------------------------------------------------------------------------

export interface Identity {
  signedIn: boolean
  email: string
  plan: string
}

const NONE: Identity = { signedIn: false, email: '', plan: '' }

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** A JWT's public claims. Never verified (a local read of the person's own file), never returned beyond email and plan. */
function jwtClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string') return {}
  const part = token.split('.')[1]
  if (part === undefined) return {}
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
  max: 'Max',
  max_5x: 'Max 5x',
  max_20x: 'Max 20x',
  claude_max: 'Max',
  claude_pro: 'Pro',
}

export function planName(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  const key = raw.trim().toLowerCase()
  return PLAN_NAMES[key] ?? key.charAt(0).toUpperCase() + key.slice(1)
}

/** Codex: the account in <home>/auth.json (id token claims: email and plan). */
export function codexIdentity(dir: string): Identity {
  const parsed = readJson(join(dir, 'auth.json'))
  if (parsed === null || typeof parsed !== 'object') return NONE
  const tokens = (parsed as { tokens?: { id_token?: unknown; access_token?: unknown } }).tokens
  if (tokens === undefined || tokens === null || typeof tokens.access_token !== 'string' || tokens.access_token === '') return NONE
  const claims = jwtClaims(tokens.id_token)
  const auth = (claims['https://api.openai.com/auth'] ?? {}) as { chatgpt_plan_type?: unknown }
  const email = typeof claims['email'] === 'string' ? claims['email'] : ''
  return { signedIn: true, email, plan: planName(auth.chatgpt_plan_type) }
}

/** Claude: <home>/.credentials.json holds the login; the account's email is in the config next to it. */
export function claudeIdentity(dir: string, shared: boolean, home: string = homedir()): Identity {
  const creds = readJson(join(dir, '.credentials.json'))
  const oauth = creds !== null && typeof creds === 'object' ? (creds as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth : undefined
  const signedIn = oauth !== undefined && oauth !== null && typeof oauth['accessToken'] === 'string' && oauth['accessToken'] !== ''
  if (!signedIn) return NONE
  // Claude keeps the account's name in .claude.json: inside the folder when CLAUDE_CONFIG_DIR is set, beside it
  // (~/.claude.json) for the computer's own login.
  const files = shared ? [join(dir, '.claude.json'), join(home, '.claude.json')] : [join(dir, '.claude.json')]
  let email = ''
  for (const file of files) {
    const config = readJson(file)
    const account = config !== null && typeof config === 'object' ? (config as { oauthAccount?: { emailAddress?: unknown } }).oauthAccount : undefined
    if (account !== undefined && account !== null && typeof account.emailAddress === 'string') {
      email = account.emailAddress
      break
    }
  }
  return { signedIn: true, email, plan: planName(oauth['subscriptionType']) }
}

/** What `claude auth status` (JSON) said, for the email and plan when the files do not have them. */
export function identityFromStatus(output: string): { email: string; plan: string } {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end <= start) return { email: '', plan: '' }
  try {
    const o = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>
    return { email: typeof o['email'] === 'string' ? o['email'] : '', plan: planName(o['subscriptionType']) }
  } catch {
    return { email: '', plan: '' }
  }
}

export function identityOf(entry: HomeEntry, home: string = homedir()): Identity {
  return entry.cli === 'codex' ? codexIdentity(entry.dir) : claudeIdentity(entry.dir, entry.shared, home)
}

// ---- usage ---------------------------------------------------------------------------------------------------------

export function windowLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Limit'
  if (minutes === 300) return '5 hours'
  if (minutes === 10080) return 'Weekly'
  if (minutes % 1440 === 0) return `${minutes / 1440} days`
  if (minutes % 60 === 0) return `${minutes / 60} hours`
  return `${minutes} min`
}

function newestFiles(dir: string, limit: number): string[] {
  const found: Array<{ file: string; at: number }> = []
  const walk = (folder: string, depth: number): void => {
    let names: string[] = []
    try {
      names = readdirSync(folder)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(folder, name)
      let info
      try {
        info = statSync(path)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (depth < 4) walk(path, depth + 1)
      } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) found.push({ file: path, at: info.mtimeMs })
    }
  }
  walk(dir, 0)
  return found.sort((a, b) => b.at - a.at).slice(0, limit).map((each) => each.file)
}

/**
 * Codex: the plan's limits as the engine last saw them, from the newest session file in that home (the token_count
 * events carry rate_limits: used_percent, window_minutes and resets_at in seconds). Empty when no turn has run yet.
 */
export function codexUsage(dir: string): { windows: AiUsageWindow[]; at: number } {
  for (const file of newestFiles(join(dir, 'sessions'), 3)) {
    let text = ''
    let mtime = 0
    try {
      const info = statSync(file)
      mtime = info.mtimeMs
      text = readFileSync(file).subarray(Math.max(0, info.size - 400_000)).toString('utf8')
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]
      if (line === undefined || !line.includes('rate_limits')) continue
      try {
        const event = JSON.parse(line) as { timestamp?: unknown; payload?: { type?: string; rate_limits?: Record<string, unknown> | null } }
        const limits = event.payload?.rate_limits
        if (event.payload?.type !== 'token_count' || limits === undefined || limits === null) continue
        const at = typeof event.timestamp === 'string' && Number.isFinite(Date.parse(event.timestamp)) ? Date.parse(event.timestamp) : mtime
        const windows: AiUsageWindow[] = []
        for (const key of ['primary', 'secondary']) {
          const w = limits[key] as { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown; resets_in_seconds?: unknown } | null | undefined
          if (w === undefined || w === null || typeof w.used_percent !== 'number') continue
          const resets = typeof w.resets_at === 'number' ? w.resets_at * 1000 : typeof w.resets_in_seconds === 'number' ? at + w.resets_in_seconds * 1000 : null
          windows.push({ label: windowLabel(Number(w.window_minutes ?? 0)), usedPercent: Math.round(w.used_percent * 10) / 10, resetsAt: resets })
        }
        if (windows.length > 0) return { windows, at }
      } catch {
        // A cut line at the start of the slice.
      }
    }
  }
  return { windows: [], at: 0 }
}

/** Usage the Claude engine reported during turns (its rate_limit_event), kept per account in one local file. */
export interface UsageRecord {
  windows: AiUsageWindow[]
  at: number
  /** Epoch ms until which the plan said it is at its limit; 0 = not limited. */
  limitedUntil: number
}

export class UsageStore {
  private data: Record<string, UsageRecord> | null = null

  constructor(private readonly file: string) {}

  private load(): Record<string, UsageRecord> {
    if (this.data !== null) return this.data
    const parsed = readJson(this.file)
    this.data = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, UsageRecord>) : {}
    return this.data
  }

  get(id: string): UsageRecord | null {
    return this.load()[id] ?? null
  }

  set(id: string, patch: Partial<UsageRecord>): void {
    const data = this.load()
    const current = data[id] ?? { windows: [], at: 0, limitedUntil: 0 }
    data[id] = { ...current, ...patch }
    this.write(data)
  }

  forget(id: string): void {
    const data = this.load()
    if (data[id] === undefined) return
    delete data[id]
    this.write(data)
  }

  private write(data: Record<string, UsageRecord>): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(data), { mode: 0o600 })
    } catch {
      // Usage is a courtesy: never fail a turn over it.
    }
  }
}

/** The Claude engine's rate limit report as a usage window, or null when it carries no number. */
export function claudeLimitWindow(info: { rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown; status?: unknown }): AiUsageWindow | null {
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : ''
  const labels: Record<string, string> = { five_hour: '5 hours', seven_day: 'Weekly', seven_day_opus: 'Weekly Opus', seven_day_sonnet: 'Weekly Sonnet', overage: 'Extra usage' }
  const label = labels[type] ?? (type === '' ? 'Limit' : type.replace(/_/g, ' '))
  let used: number | null = typeof info.utilization === 'number' ? (info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null
  if (used === null && info.status === 'rejected') used = 100
  if (used === null) return null
  const resets = typeof info.resetsAt === 'number' ? (info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt) : null
  return { label, usedPercent: Math.round(used * 10) / 10, resetsAt: resets }
}

/**
 * Claude: the plan's usage as `/usage` in Claude Code shows it, asked of the same endpoint with this account's own
 * access token (read here, sent only to Anthropic, never returned or logged). Empty when the endpoint does not answer.
 */
export async function claudeUsageFromApi(dir: string, fetchImpl: typeof fetch = fetch): Promise<AiUsageWindow[]> {
  const creds = readJson(join(dir, '.credentials.json'))
  const oauth = creds !== null && typeof creds === 'object' ? (creds as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth : undefined
  const token = oauth?.accessToken
  if (typeof token !== 'string' || token === '') return []
  try {
    const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) return []
    const body = (await response.json()) as Record<string, { utilization?: unknown; resets_at?: unknown } | null>
    const labels: Array<[string, string]> = [
      ['five_hour', '5 hours'],
      ['seven_day', 'Weekly'],
      ['seven_day_opus', 'Weekly Opus'],
      ['seven_day_sonnet', 'Weekly Sonnet'],
    ]
    const windows: AiUsageWindow[] = []
    for (const [key, label] of labels) {
      const w = body[key]
      if (w === undefined || w === null || typeof w.utilization !== 'number') continue
      const resets = typeof w.resets_at === 'string' && Number.isFinite(Date.parse(w.resets_at)) ? Date.parse(w.resets_at) : null
      windows.push({ label, usedPercent: Math.round(w.utilization * 10) / 10, resetsAt: resets })
    }
    return windows
  } catch {
    return []
  }
}
