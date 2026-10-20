/**
 * Connected apps for the main process: the Composio key (secrets only), the accounts and their rules,
 * connecting in the person's browser, and the learned apps list. Connections and the agent's apps_*
 * tools both go through this one service.
 */
import {
  DEFAULT_ACCOUNT_RULES,
  type AccountRules,
  type AppsStatus,
  type ConnectedAccount,
  type LearnedAppInfo,
} from '@agent/core'

import { appName } from './catalog'
import { backendFor, keyKind, type AppAccount, type ComposioBackend } from './composio'
import { AppGuard } from './guard'
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
  openExternal: (url: string) => Promise<void>
  fetchImpl?: typeof fetch
  /** How often to look while waiting for a sign-in, and for how long. Tests shorten both. */
  pollMs?: number
  waitMs?: number
}

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
  private cached: { key: string; backend: ComposioBackend } | null = null
  private readonly listeners = new Set<() => void>()
  private readonly connecting = new Set<string>()

  constructor(private readonly deps: AppsServiceDeps) {
    this.guard = new AppGuard({
      rulesFor: (id) => deps.file.rulesFor(id),
      accountsFor: (apps) => this.activeAccounts(apps),
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
    this.changed()
  }

  rulesFor(accountId: string | null): AccountRules {
    return accountId === null ? { ...DEFAULT_ACCOUNT_RULES } : this.deps.file.rulesFor(accountId)
  }

  setRules(accountId: string, rules: AccountRules): void {
    this.deps.file.setRules(accountId, rules)
    this.changed()
  }

  learnedApps(): LearnedAppInfo[] {
    return this.deps.learned.apps().map((app) => ({
      id: app.id,
      name: app.name,
      startUrl: app.startUrl,
      host: hostOf(app.startUrl),
      about: app.about,
      trusted: app.trusted,
      updatedAt: app.updatedAt,
      tools: app.tools.map((t) => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
    }))
  }

  removeLearned(id: string): void {
    this.deps.learned.remove(id)
  }

  setTrusted(id: string, trusted: boolean): void {
    this.deps.learned.setTrusted(id, trusted)
  }
}
