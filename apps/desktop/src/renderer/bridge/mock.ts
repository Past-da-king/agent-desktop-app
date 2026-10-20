import { DEFAULT_SETTINGS } from '@agent/core'
import type {
  AgentApi,
  ChatEvent,
  EntityMap,
  EntityName,
  RouteTarget,
  RunState,
  Settings,
  SyncProgress,
  SyncStatus,
  Unsubscribe,
} from '@agent/core'

const settingsListeners = new Set<(settings: Settings) => void>()

let settings: Settings = { ...DEFAULT_SETTINGS }

function notifySettings(): void {
  const snapshot = { ...settings }
  for (const listener of settingsListeners) listener(snapshot)
}

function status(): SyncStatus {
  return {
    signedIn: false,
    syncing: false,
    lastSyncedAt: null,
    error: null,
    pendingPush: 0,
  }
}

const runState: RunState = { running: false, waiting: [] }

export const mockAgent: AgentApi = {
  platform: 'web',
  version: '0.0.0',

  settings: {
    async get() {
      return { ...settings }
    },
    async save(patch) {
      settings = { ...settings, ...patch }
      notifySettings()
      return { ...settings }
    },
    async providers() {
      return []
    },
    async setApiKey() {
      return undefined
    },
    async checkKey() {
      return { ok: false, message: 'Add an API key to check a model.' }
    },
    async reset() {
      settings = { ...DEFAULT_SETTINGS }
      notifySettings()
    },
    onChanged(callback: (next: Settings) => void): Unsubscribe {
      settingsListeners.add(callback)
      return () => {
        settingsListeners.delete(callback)
      }
    },
  },

  account: {
    async signIn() {
      return { ok: false, error: 'Not available in the browser preview.' }
    },
    async signOut() {
      return undefined
    },
    async firstSync() {
      return status()
    },
    async syncNow() {
      return status()
    },
    async status() {
      return status()
    },
    onStatus(_callback: (next: SyncStatus) => void): Unsubscribe {
      return () => undefined
    },
    onProgress(_callback: (progress: SyncProgress) => void): Unsubscribe {
      return () => undefined
    },
  },

  data: {
    async list<E extends EntityName>(): Promise<Array<EntityMap[E]>> {
      return []
    },
    async upsert<E extends EntityName>(): Promise<EntityMap[E]> {
      throw new Error('Not available in the browser preview.')
    },
    async remove() {
      return undefined
    },
    onChanged(_callback: (entity: EntityName) => void): Unsubscribe {
      return () => undefined
    },
  },

  chat: {
    async send() {
      return undefined
    },
    async stop() {
      return undefined
    },
    async state() {
      return runState
    },
    async answer() {
      return undefined
    },
    async decide() {
      return undefined
    },
    onEvent(_callback: (event: ChatEvent) => void): Unsubscribe {
      return () => undefined
    },
  },

  routines: {
    async runNow() {
      return undefined
    },
  },

  window: {
    minimize() {
      return undefined
    },
    toggleMaximize() {
      return undefined
    },
    close() {
      return undefined
    },
    async isMaximized() {
      return false
    },
    onMaximizeChange(_callback: (maximized: boolean) => void): Unsubscribe {
      return () => undefined
    },
    onQuickAsk(_callback: () => void): Unsubscribe {
      return () => undefined
    },
    onRoute(_callback: (target: RouteTarget) => void): Unsubscribe {
      return () => undefined
    },
  },

  files: {
    async pick() {
      return []
    },
    pathsFor() {
      return []
    },
    async pickFolder() {
      return null
    },
  },

  shell: {
    async openExternal() {
      return undefined
    },
    async reveal() {
      return undefined
    },
  },
}
