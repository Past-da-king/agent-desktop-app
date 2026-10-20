/**
 * The account and sync layer: registration/login against the sync service, the token in the
 * secrets module, and the long-poll engine running over the local database.
 *
 * It owns no UI and no Electron APIs, so the whole flow is tested in plain Node against the local
 * fake sync service.
 */
import {
  SyncClient,
  SyncEngine,
  SyncException,
  type Change,
  type EntityName,
  type SignInResult,
  type SyncProgress,
  type SyncStatus,
  type SyncStore,
} from '@agent/core'

import type { Secrets } from './secrets'
import type { SettingsStore } from './settings'

export interface SignInArgs {
  serverUrl: string
  email: string
  password: string
  mode: 'login' | 'register'
}

export interface AccountOptions {
  fetchImpl?: typeof fetch
  /** Long-poll window in seconds. Tests shorten it; production keeps the engine default (25). */
  pollWaitSeconds?: number
  /** Tests that only want an explicit firstSync pass can turn the background loop off. */
  autoStart?: boolean
  now?: () => number
}

type StatusListener = (status: SyncStatus) => void
type ProgressListener = (progress: SyncProgress) => void

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class AccountService {
  private readonly store: SyncStore
  private readonly settings: SettingsStore
  private readonly secrets: Secrets
  private readonly options: AccountOptions
  private readonly engine: SyncEngine
  private readonly statusListeners = new Set<StatusListener>()
  private readonly progressListeners = new Set<ProgressListener>()

  private client: SyncClient | null = null
  private collecting: Partial<Record<EntityName, number>> | null = null
  private disposed = false

  constructor(
    store: SyncStore,
    settings: SettingsStore,
    secrets: Secrets,
    options: AccountOptions = {},
  ) {
    this.store = store
    this.settings = settings
    this.secrets = secrets
    this.options = options

    this.engine = new SyncEngine(store, () => this.client, {
      onApplied: (changes) => this.handleApplied(changes),
      onStatus: (status) => this.emitStatus(status),
      pollWaitSeconds: options.pollWaitSeconds,
      now: options.now,
    })

    const token = secrets.get('syncToken')
    const url = settings.get().syncUrl.trim()
    if (token !== null && token !== '' && url !== '') {
      try {
        this.client = new SyncClient(url, token, options.fetchImpl, settings.get().allowHttp)
        this.engine.markSignedIn(true)
        if (options.autoStart !== false) this.engine.start()
      } catch {
        // An unusable saved address leaves the app offline rather than stopping it from opening.
        this.client = null
      }
    }
  }

  async signIn(args: SignInArgs): Promise<SignInResult> {
    const email = args.email.trim()
    const password = args.password
    const serverUrl = args.serverUrl.trim()

    if (!EMAIL_SHAPE.test(email)) return { ok: false, error: 'That email address does not look right.' }
    if (password.length < 6) return { ok: false, error: 'Use a password of at least 6 characters.' }
    if (serverUrl === '') return { ok: false, error: 'Add the address of your sync server.' }

    const allowHttp = this.settings.get().allowHttp
    try {
      const auth =
        args.mode === 'register'
          ? await SyncClient.register(serverUrl, email, password, this.options.fetchImpl, allowHttp)
          : await SyncClient.login(serverUrl, email, password, this.options.fetchImpl, allowHttp)

      if (auth.token === '') {
        return { ok: false, error: 'The sync server did not send a sign-in token.' }
      }

      this.secrets.set('syncToken', auth.token)
      this.settings.save({ syncUrl: serverUrl, syncEmail: email, signedIn: true })
      this.client = new SyncClient(serverUrl, auth.token, this.options.fetchImpl, allowHttp)
      this.engine.markSignedIn(true)
      this.engine.start()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: signInMessage(error) }
    }
  }

  async signOut(): Promise<void> {
    this.engine.stop()
    this.client = null
    this.secrets.delete('syncToken')
    this.settings.save({ signedIn: false, syncEmail: null })
    this.engine.markSignedIn(false)
  }

  /** One pass for the onboarding step, reporting how many rows of each kind arrived. */
  async firstSync(): Promise<SyncStatus> {
    if (this.client === null) {
      this.emitProgress({ phase: 'error', counts: {}, message: 'Sign in to sync first.' })
      return this.status()
    }
    const counts: Partial<Record<EntityName, number>> = {}
    this.collecting = counts
    this.emitProgress({ phase: 'connecting', counts: { ...counts } })
    this.emitProgress({ phase: 'pulling', counts: { ...counts } })
    try {
      const ok = await this.engine.syncOnce()
      const status = this.status()
      const progress: SyncProgress = { phase: ok ? 'done' : 'error', counts: { ...counts } }
      if (!ok) progress.message = status.error ?? 'Sync could not finish.'
      this.emitProgress(progress)
      return status
    } finally {
      this.collecting = null
    }
  }

  async syncNow(): Promise<SyncStatus> {
    await this.engine.syncOnce()
    return this.status()
  }

  status(): SyncStatus {
    return this.engine.status()
  }

  /** Called after a local write so it is pushed promptly. No-op while signed out. */
  nudge(): void {
    if (this.client !== null) this.engine.nudge()
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => {
      this.statusListeners.delete(listener)
    }
  }

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => {
      this.progressListeners.delete(listener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.engine.stop()
    this.statusListeners.clear()
    this.progressListeners.clear()
  }

  private handleApplied(changes: Change[]): void {
    if (this.collecting === null) return
    for (const change of changes) {
      this.collecting[change.entity] = (this.collecting[change.entity] ?? 0) + 1
    }
    this.emitProgress({ phase: 'pulling', counts: { ...this.collecting } })
  }

  private emitStatus(status: SyncStatus): void {
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch {
        // A UI listener failing must not stop sync.
      }
    }
  }

  private emitProgress(progress: SyncProgress): void {
    for (const listener of this.progressListeners) {
      try {
        listener(progress)
      } catch {
        // A UI listener failing must not stop sync.
      }
    }
  }
}

/** Plain words the onboarding screen can show as-is. */
function signInMessage(error: unknown): string {
  if (error instanceof SyncException) {
    if (error.status === 409) return 'There is already an account with that email. Try signing in.'
    if (error.status === 401) return 'That email and password do not match.'
    if (error.status === 0) {
      return 'Could not reach the sync server. Check the address, or use this computer only.'
    }
    return error.message || 'Sync sign-in failed.'
  }
  return 'Sync sign-in failed.'
}
