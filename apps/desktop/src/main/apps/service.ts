/**
 * Connected apps for the main process: the Composio key (secrets only), the accounts and their rules,
 * connecting in the person's browser, and the learned apps list. Connections and the agent's apps_*
 * tools both go through this one service.
 */
import {
  DEFAULT_ACCOUNT_RULES,
  type AccountRules,
  type AgentProfileInfo,
  type AppChoice,
  type AppsStatus,
  type ProfileAccount,
  type ConnectedAccount,
  type LearnedAppInfo,
} from '@agent/core'

import { appName, POPULAR_APPS } from './catalog'
import { backendFor, keyKind, logoFor, type AppAccount, type ComposioBackend } from './composio'
import { AppGuard } from './guard'
import { ProfileStore } from './profiles'
import { hostOf, type ConnectedAppsFile, type LearnedStore } from './store'

export const COMPOSIO_SECRET = 'composioKey'
export const NO_KEY =
  'No apps can be connected yet: there is no Composio key. Ask the person to add their own free Composio key in Connections, then try again.'

export interface SecretsLike {
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): void
}

export interface AppsServiceDeps {
  secrets: SecretsLike
  file: ConnectedAppsFile
  learned: LearnedStore
  /** Profiles (profiles.json). Without one, an in-memory store with only General is used. */
  profiles?: ProfileStore
  openExternal: (url: string) => Promise<void>
  fetchImpl?: typeof fetch
  /** How often to look while waiting for a sign-in, and for how long. Tests shorten both. */
  pollMs?: number
  waitMs?: number
}

const CATALOG_MS = 6 * 60 * 60_000
const POLL_MS = 4_000
const WAIT_MS = 5 * 60_000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export class AppsService {
  readonly guard: AppGuard
  readonly profiles: ProfileStore
  private cached: { key: string; backend: ComposioBackend } | null = null
  private readonly listeners = new Set<() => void>()
  private readonly connecting = new Set<string>()
  /** Composio's toolkit list for the current key, kept for six hours. */
  private toolkitCache: { key: string; at: number; list: AppChoice[] } | null = null

  constructor(private readonly deps: AppsServiceDeps) {
    this.profiles = deps.profiles ?? new ProfileStore(null)
    this.guard = new AppGuard({
      rulesFor: (id) => deps.file.rulesFor(id),
      accountsFor: (apps) => this.activeAccounts(apps),
      profileOf: (ctx) => this.profileOf(ctx.profile),
    })
    deps.learned.onChange(() => this.changed())
  }

  /** The backend for the stored key, or null when there is none. */
  backend(): ComposioBackend | null {
    const key = (this.deps.secrets.get(COMPOSIO_SECRET) ?? '').trim()
    if (key === '') return null
    if (this.cached?.key !== key) {
      this.cached = { key, backend: backendFor(key, this.deps.file.userId(), this.deps.fetchImpl) }
    }
    return this.cached.backend
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of this.listeners) listener()
  }

  async setKey(raw: string): Promise<{ ok: boolean; message: string }> {
    const key = raw.trim()
    if (key === '') {
      this.deps.secrets.delete(COMPOSIO_SECRET)
      this.cached = null
      this.changed()
      return { ok: true, message: 'Composio key removed. Connected apps are off until you add one.' }
    }
    const backend = backendFor(key, this.deps.file.userId(), this.deps.fetchImpl)
    let problem: string | null
    try {
      problem = await backend.verify()
    } catch (cause) {
      problem = `Could not reach Composio (${cause instanceof Error ? cause.message : String(cause)}).`
    }
    if (problem !== null) return { ok: false, message: problem }
    this.deps.secrets.set(COMPOSIO_SECRET, key)
    this.cached = { key, backend }
    this.changed()
    return { ok: true, message: 'Composio key saved. You can connect apps now.' }
  }

  async accounts(apps?: string[]): Promise<AppAccount[]> {
    const backend = this.backend()
    if (backend === null) return []
    return backend.accounts(apps)
  }

  async activeAccounts(apps: string[]): Promise<AppAccount[]> {
    return (await this.accounts(apps)).filter((a) => a.status === 'ACTIVE')
  }

  async status(): Promise<AppsStatus> {
    const key = (this.deps.secrets.get(COMPOSIO_SECRET) ?? '').trim()
    const base: AppsStatus = { hasKey: key !== '', keyKind: keyKind(key), accounts: [], connecting: [...this.connecting], message: '' }
    if (key === '') return base
    try {
      const accounts = await this.accounts()
      base.accounts = accounts.map(
        (a): ConnectedAccount => ({
          id: a.id,
          app: a.app,
          appName: appName(a.app),
          label: a.label,
          status: a.status === 'ACTIVE' ? 'active' : a.status === 'FAILED' || a.status === 'EXPIRED' ? 'failed' : 'pending',
          rules: this.deps.file.rulesFor(a.id),
          logo: this.logoOf(a.app),
        }),
      )
    } catch (cause) {
      base.message = `Could not read your connected apps: ${cause instanceof Error ? cause.message : String(cause)}`
    }
    return base
  }

  /**
   * Opens the sign-in for an app in the person's own browser. The returned `wait` resolves when
   * Composio reports a new active account ('connected'), after five minutes ('timeout') or on abort.
   */
  async begin(app: string): Promise<{ wait(signal?: AbortSignal): Promise<'connected' | 'timeout' | 'stopped'> }> {
    const backend = this.backend()
    if (backend === null) throw new Error(NO_KEY)
    const before = new Set((await backend.accounts([app])).filter((a) => a.status === 'ACTIVE').map((a) => a.id))
    const link = await backend.connectLink(app)
    await this.deps.openExternal(link)
    this.connecting.add(app)
    this.changed()
    const wait = async (signal?: AbortSignal): Promise<'connected' | 'timeout' | 'stopped'> => {
      const deadline = Date.now() + (this.deps.waitMs ?? WAIT_MS)
      try {
        while (Date.now() < deadline) {
          await sleep(this.deps.pollMs ?? POLL_MS, signal)
          if (signal?.aborted === true) return 'stopped'
          let now: AppAccount[] = []
          try {
            now = await backend.accounts([app])
          } catch {
            continue
          }
          if (now.some((a) => a.status === 'ACTIVE' && !before.has(a.id))) return 'connected'
        }
        return 'timeout'
      } finally {
        this.connecting.delete(app)
        this.changed()
      }
    }
    return { wait }
  }

  /** From Connections: open the sign-in and return at once; the page updates when it is done. */
  async connect(app: string): Promise<{ ok: boolean; message: string }> {
    if (this.backend() === null) return { ok: false, message: 'Add your Composio key first.' }
    if (this.connecting.has(app)) return { ok: true, message: `Still waiting for you to sign in to ${appName(app)}.` }
    try {
      const started = await this.begin(app)
      void started.wait().catch(() => undefined)
      return { ok: true, message: `Sign in to ${appName(app)} in your browser. This page updates when it is connected.` }
    } catch (cause) {
      return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  async disconnect(accountId: string): Promise<void> {
    const backend = this.backend()
    if (backend === null) return
    const account = (await backend.accounts()).find((a) => a.id === accountId)
    if (account === undefined) return
    await backend.disconnect(account)
    this.deps.file.forget(accountId)
    this.profiles.forgetAccount(accountId)
    this.changed()
  }

  /**
   * Every app Composio offers, popular ones first, with logos. Without a key, or with a Connect key
   * (which cannot list toolkits), the popular list with Composio's logo for each.
   */
  async catalog(): Promise<AppChoice[]> {
    const popular = POPULAR_APPS.map((app) => ({ ...app, logo: logoFor(app.slug) }))
    const key = (this.deps.secrets.get(COMPOSIO_SECRET) ?? '').trim()
    const backend = this.backend()
    if (backend === null || backend.toolkits === undefined) return popular
    if (this.toolkitCache?.key === key && Date.now() - this.toolkitCache.at < CATALOG_MS) return this.toolkitCache.list
    let all: AppChoice[] | null = null
    try {
      all = await backend.toolkits()
    } catch {
      all = null
    }
    if (all === null || all.length === 0) return this.toolkitCache?.list ?? popular
    // Popular apps first (with our plain one-line descriptions), then everything else as Composio sorts it.
    const bySlug = new Map(all.map((app) => [app.slug, app]))
    const first = POPULAR_APPS.filter((app) => bySlug.has(app.slug)).map((app) => ({ ...bySlug.get(app.slug), ...app, logo: bySlug.get(app.slug)?.logo ?? logoFor(app.slug) }))
    const firstSlugs = new Set(first.map((app) => app.slug))
    const list = [...first, ...all.filter((app) => !firstSlugs.has(app.slug))]
    this.toolkitCache = { key, at: Date.now(), list }
    return list
  }

  /**
   * Apps matching what the person typed, from all of Composio: its own search with a Connect key, the full
   * toolkit list otherwise. Never only the popular list.
   */
  async searchApps(query: string): Promise<AppChoice[]> {
    const q = query.trim().toLowerCase()
    if (q === '') return []
    const backend = this.backend()
    if (backend?.searchApps !== undefined) {
      try {
        return await backend.searchApps(q)
      } catch {
        return []
      }
    }
    const all = await this.catalog()
    return all.filter((app) => `${app.slug} ${app.name} ${app.line}`.toLowerCase().includes(q)).slice(0, 60)
  }

  private logoOf(app: string): string {
    return this.toolkitCache?.list.find((choice) => choice.slug === app)?.logo ?? logoFor(app)
  }

  /** The profile a helper works in (by its id from ToolContext.profile), or null for the main agent. */
  profileOf(profileId: string | undefined): AgentProfileInfo | null {
    if (profileId === undefined || profileId === '') return null
    // A helper whose profile was deleted mid-job falls back to General: none of the person's accounts.
    return this.profiles.find(profileId) ?? this.profiles.general()
  }

  /** Connected accounts by id, as a profile remembers them. Unknown ids are left out. */
  async accountRefs(ids: string[]): Promise<ProfileAccount[]> {
    if (ids.length === 0) return []
    const all = await this.accounts()
    return ids
      .map((id) => all.find((a) => a.id === id))
      .filter((a): a is AppAccount => a !== undefined)
      .map((a) => ({ id: a.id, app: a.app, label: a.label }))
  }

  rulesFor(accountId: string | null): AccountRules {
    return accountId === null ? { ...DEFAULT_ACCOUNT_RULES } : this.deps.file.rulesFor(accountId)
  }

  setRules(accountId: string, rules: AccountRules): void {
    this.deps.file.setRules(accountId, rules)
    this.changed()
  }

  learnedApps(): LearnedAppInfo[] {
    const apps = this.deps.learned.apps()
    for (const app of apps) if (app.icon === undefined) void this.fetchIcon(app.id, app.startUrl)
    return apps.map((app) => ({
      id: app.id,
      name: app.name,
      startUrl: app.startUrl,
      host: hostOf(app.startUrl),
      about: app.about,
      trusted: app.trusted,
      updatedAt: app.updatedAt,
      tools: app.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
      ...(app.icon === undefined ? {} : { icon: app.icon }),
    }))
  }

  private readonly iconTries = new Set<string>()

  /** The site's favicon, fetched once (its own /favicon.ico, else the icon search engines show) and saved. */
  private async fetchIcon(id: string, startUrl: string): Promise<void> {
    const host = hostOf(startUrl)
    if (host === '' || this.iconTries.has(id)) return
    this.iconTries.add(id)
    const fetcher = this.deps.fetchImpl ?? fetch
    for (const url of [`https://${host}/favicon.ico`, `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`]) {
      try {
        const res = await fetcher(url, { signal: AbortSignal.timeout(8000) })
        const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? ''
        if (!res.ok || !type.startsWith('image/')) continue
        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.length < 64 || bytes.length > 200_000) continue
        this.deps.learned.setIcon(id, `data:${type};base64,${bytes.toString('base64')}`)
        return
      } catch {
        // Try the next place; with no icon the list shows a lettered tile.
      }
    }
  }

  removeLearned(id: string): void {
    this.deps.learned.remove(id)
    this.profiles.forgetLearned(id)
  }

  setTrusted(id: string, trusted: boolean): void {
    this.deps.learned.setTrusted(id, trusted)
  }
}
