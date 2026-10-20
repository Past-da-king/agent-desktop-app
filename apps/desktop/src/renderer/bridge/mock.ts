import { DEFAULT_SETTINGS } from '@agent/core'
import type {
  AgentApi,
  BrowserBounds,
  BrowserState,
  ChatEvent,
  EntityMap,
  EntityName,
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

const browserListeners = new Set<(state: BrowserState) => void>()
const mockBrowser: BrowserState = {
  url: 'https://skyhop.example/flights',
  title: 'SkyHop flights',
  tabs: [
    {
      id: 'mock-tab-1',
      title: 'SkyHop flights',
      url: 'https://skyhop.example/flights',
      active: true,
    },
  ],
  visible: false,
  agentActive: true,
  needsUser: false,
  handoffReason: '',
}

function notifyBrowser(): void {
  const snapshot: BrowserState = {
    ...mockBrowser,
    tabs: mockBrowser.tabs.map((tab) => ({ ...tab })),
  }
  for (const listener of browserListeners) listener(snapshot)
}

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

  browser: {
    async setBounds(bounds: BrowserBounds) {
      mockBrowser.visible = bounds.visible
      notifyBrowser()
    },
    async state() {
      return { ...mockBrowser, tabs: mockBrowser.tabs.map((tab) => ({ ...tab })) }
    },
    async back() {
      return undefined
    },
    async reload() {
      return undefined
    },
    async selectTab(id: string) {
      const chosen = mockBrowser.tabs.find((tab) => tab.id === id)
      if (chosen === undefined) return
      mockBrowser.tabs = mockBrowser.tabs.map((tab) => ({ ...tab, active: tab.id === id }))
      mockBrowser.url = chosen.url
      mockBrowser.title = chosen.title
      notifyBrowser()
    },
    async closeTab(id: string) {
      mockBrowser.tabs = mockBrowser.tabs.filter((tab) => tab.id !== id)
      const active = mockBrowser.tabs.find((tab) => tab.active) ?? mockBrowser.tabs[0]
      mockBrowser.tabs = mockBrowser.tabs.map((tab) => ({ ...tab, active: tab.id === active?.id }))
      mockBrowser.url = active?.url ?? ''
      mockBrowser.title = active?.title ?? ''
      notifyBrowser()
    },
    async takeOver() {
      mockBrowser.agentActive = false
      mockBrowser.handoffReason = ''
      mockBrowser.needsUser = false
      notifyBrowser()
    },
    async giveBack() {
      mockBrowser.agentActive = true
      mockBrowser.handoffReason = ''
      mockBrowser.needsUser = false
      notifyBrowser()
    },
    async openInSystem() {
      return undefined
    },
    onState(callback: (state: BrowserState) => void): Unsubscribe {
      browserListeners.add(callback)
      return () => {
        browserListeners.delete(callback)
      }
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
