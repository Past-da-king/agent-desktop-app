import { DEFAULT_SETTINGS, PROVIDERS } from '@agent/core'
import type {
  AgentApi,
  ChatEvent,
  ChatItem,
  Decision,
  EntityMap,
  EntityName,
  HotkeyStatus,
  RowInput,
  RunState,
  Settings,
  SignInResult,
  SyncProgress,
  SyncStatus,
  SystemInfo,
  Unsubscribe,
} from '@agent/core'

import { readMode, seedFor, type DemoMode } from './seed'

type RowStore = { [E in EntityName]: Array<EntityMap[E]> }

const mode: DemoMode =
  typeof window === 'undefined' ? 'fresh' : readMode(window.location.search)

const seed = seedFor(mode)
const MODE_KEY = `agent.mock.settings.${mode}`

function copy<T>(value: T): T {
  return structuredClone(value)
}

function readStoredSettings(fallback: Settings): Settings {
  try {
    const raw = window.localStorage.getItem(MODE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback
    const source = parsed as Record<string, unknown>
    const next = { ...fallback } as unknown as Record<string, unknown>
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (key in source) next[key] = source[key]
    }
    return next as unknown as Settings
  } catch {
    return fallback
  }
}

function writeStoredSettings(value: Settings): void {
  try {
    window.localStorage.setItem(MODE_KEY, JSON.stringify(value))
  } catch {
    // Private mode and locked-down browsers may refuse storage. The mock still works in memory.
  }
}

let settings: Settings = readStoredSettings(seed.settings)
let rows: RowStore = copy(seed.rows)
let apiKey = ''
let running = false
let agentTimer: ReturnType<typeof setTimeout> | null = null
let activityTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null

const settingsListeners = new Set<(next: Settings) => void>()
const dataListeners = new Set<(entity: EntityName) => void>()
const statusListeners = new Set<(next: SyncStatus) => void>()
const progressListeners = new Set<(next: SyncProgress) => void>()
const chatListeners = new Set<(event: ChatEvent) => void>()

let syncStatus: SyncStatus = {
  signedIn: settings.signedIn,
  syncing: false,
  lastSyncedAt: settings.signedIn ? Date.now() - 2000 : null,
  error: null,
  pendingPush: 0,
}

function emitSettings(): void {
  const snapshot = { ...settings, grantedFolders: [...settings.grantedFolders] }
  for (const listener of settingsListeners) listener(snapshot)
}

function emitData(entity: EntityName): void {
  for (const listener of dataListeners) listener(entity)
}

function emitStatus(next?: Partial<SyncStatus>): void {
  if (next) syncStatus = { ...syncStatus, ...next }
  const snapshot = { ...syncStatus }
  for (const listener of statusListeners) listener(snapshot)
}

function emitProgress(progress: SyncProgress): void {
  const snapshot = { ...progress, counts: { ...progress.counts } }
  for (const listener of progressListeners) listener(snapshot)
}

function emitChat(event: ChatEvent): void {
  for (const listener of chatListeners) listener(event)
}

function saveSettings(patch: Partial<Settings>): Settings {
  settings = { ...settings, ...patch, grantedFolders: [...(patch.grantedFolders ?? settings.grantedFolders)] }
  writeStoredSettings(settings)
  emitSettings()
  return { ...settings, grantedFolders: [...settings.grantedFolders] }
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // A card with unreadable meta is shown as an ordinary row rather than crashing the chat.
  }
  return {}
}

function waitingIds(): string[] {
  return rows.chat_item
    .filter((item) => {
      if (item.kind !== 'question' && item.kind !== 'approval') return false
      const meta = parseMeta(item.meta)
      if (item.kind === 'question') return typeof meta['answer'] !== 'string' || meta['answer'] === ''
      const decision = meta['decision']
      return decision !== 'approve' && decision !== 'decline'
    })
    .map((item) => item.id)
}

function newId(prefix: string): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}-${suffix}`
}

function upsertRow<E extends EntityName>(entity: E, input: RowInput<E>): EntityMap[E] {
  const list = rows[entity] as Array<EntityMap[E]>
  const raw = input as Partial<EntityMap[E]> & { id?: string }
  const now = Date.now()
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : newId(entity)
  const index = list.findIndex((row) => row.id === id)
  const base: EntityMap[E] =
    index >= 0 && list[index] !== undefined
      ? copy(list[index] as EntityMap[E])
      : ({ id, createdAt: now } as unknown as EntityMap[E])
  const next = { ...base, ...raw, id } as EntityMap[E]
  const record = next as unknown as Record<string, unknown>
  if (entity === 'task' || entity === 'memory') {
    if (typeof record['updatedAt'] !== 'number') record['updatedAt'] = now
  }
  if (index >= 0) list[index] = next
  else list.push(next)
  rows[entity] = list as RowStore[E]
  emitData(entity)
  return copy(next)
}

function patchCard(id: string, patch: Record<string, unknown>): void {
  const index = rows.chat_item.findIndex((item) => item.id === id)
  const current = rows.chat_item[index]
  if (index < 0 || !current) return
  const meta = { ...parseMeta(current.meta), ...patch }
  rows.chat_item[index] = { ...current, meta: JSON.stringify(meta) }
  emitData('chat_item')
  emitChat({ type: 'chat_changed' })
}

function insertChat(item: Omit<ChatItem, 'id' | 'createdAt'> & { createdAt?: number }): ChatItem {
  const row: ChatItem = {
    id: newId('chat'),
    createdAt: item.createdAt ?? Date.now(),
    kind: item.kind,
    text: item.text,
    meta: item.meta,
  }
  rows.chat_item.push(row)
  emitData('chat_item')
  emitChat({ type: 'chat_changed' })
  return copy(row)
}

function clearChatTimers(): void {
  if (agentTimer) clearTimeout(agentTimer)
  if (activityTimer) clearTimeout(activityTimer)
  agentTimer = null
  activityTimer = null
}

function signInError(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That email address does not look right.'
  if (password.length < 6) return 'Use a password of at least 6 characters.'
  return null
}

const runState: RunState = { running: false, waiting: [] }

export const mockAgent: AgentApi = {
  platform: 'web',
  version: '0.0.0',

  settings: {
    async get() {
      return copy(settings)
    },
    async save(patch) {
      return saveSettings(patch)
    },
    async providers() {
      return copy(PROVIDERS)
    },
    async setApiKey(key) {
      apiKey = key.trim()
      saveSettings({ hasKey: apiKey !== '' })
    },
    async checkKey() {
      if (apiKey === '' && !settings.hasKey) {
        return { ok: false, message: 'Paste your key first.' }
      }
      await delay(600)
      saveSettings({ hasKey: true })
      return { ok: true, message: 'Key works.' }
    },
    async reset() {
      rows = {
        chat_item: [],
        turn: [],
        memory: [],
        goal: [],
        task: [],
        trigger: [],
      }
      settings = { ...DEFAULT_SETTINGS, deviceName: 'This computer' }
      apiKey = ''
      try {
        window.localStorage.removeItem(MODE_KEY)
      } catch {
        // Nothing to clear.
      }
      syncStatus = { signedIn: false, syncing: false, lastSyncedAt: null, error: null, pendingPush: 0 }
      for (const entity of Object.keys(rows) as EntityName[]) emitData(entity)
      emitSettings()
      emitStatus()
    },
    onChanged(callback: (next: Settings) => void): Unsubscribe {
      settingsListeners.add(callback)
      return () => {
        settingsListeners.delete(callback)
      }
    },
  },

  account: {
    async signIn(args): Promise<SignInResult> {
      const email = args.email.trim()
      const problem = signInError(email, args.password)
      if (problem) return { ok: false, error: problem }
      await delay(500)
      saveSettings({
        signedIn: true,
        syncEmail: email,
        syncUrl: args.serverUrl.trim(),
      })
      syncStatus = {
        signedIn: true,
        syncing: false,
        lastSyncedAt: Date.now(),
        error: null,
        pendingPush: 0,
      }
      emitStatus()
      return { ok: true }
    },
    async signOut() {
      saveSettings({ signedIn: false, syncEmail: null })
      syncStatus = { signedIn: false, syncing: false, lastSyncedAt: null, error: null, pendingPush: 0 }
      emitStatus()
    },
    async firstSync() {
      if (syncTimer) clearTimeout(syncTimer)
      emitProgress({ phase: 'connecting', counts: {} })
      emitStatus({ syncing: true, error: null })
      return new Promise<SyncStatus>((resolve) => {
        const counts: SyncProgress['counts'] = { memory: 128, task: 9, goal: 3, trigger: 4, chat_item: 12 }
        emitProgress({ phase: 'pulling', counts: { memory: 0 } })
        let step = 0
        const tick = (): void => {
          step += 1
          const partial: SyncProgress['counts'] = {}
          const entries = Object.entries(counts) as Array<[EntityName, number]>
          entries.slice(0, step).forEach(([entity, count]) => {
            partial[entity] = count
          })
          emitProgress({ phase: 'pulling', counts: partial })
          if (step < entries.length) {
            syncTimer = setTimeout(tick, 320)
            return
          }
          syncTimer = null
          syncStatus = {
            signedIn: true,
            syncing: false,
            lastSyncedAt: Date.now(),
            error: null,
            pendingPush: 0,
          }
          emitStatus()
          emitProgress({ phase: 'done', counts })
          resolve({ ...syncStatus })
        }
        syncTimer = setTimeout(tick, 360)
      })
    },
    async syncNow() {
      emitStatus({ syncing: true, error: null })
      await delay(700)
      syncStatus = {
        ...syncStatus,
        signedIn: settings.signedIn,
        syncing: false,
        lastSyncedAt: Date.now(),
        error: null,
      }
      emitStatus()
      return { ...syncStatus }
    },
    async status() {
      return { ...syncStatus }
    },
    onStatus(callback: (next: SyncStatus) => void): Unsubscribe {
      statusListeners.add(callback)
      return () => {
        statusListeners.delete(callback)
      }
    },
    onProgress(callback: (progress: SyncProgress) => void): Unsubscribe {
      progressListeners.add(callback)
      return () => {
        progressListeners.delete(callback)
      }
    },
  },

  data: {
    async list<E extends EntityName>(entity: E): Promise<Array<EntityMap[E]>> {
      return copy(rows[entity] as Array<EntityMap[E]>)
    },
    async upsert<E extends EntityName>(entity: E, row: RowInput<E>): Promise<EntityMap[E]> {
      return upsertRow(entity, row)
    },
    async remove(entity, id) {
      const list = rows[entity] as Array<{ id: string }>
      const index = list.findIndex((row) => row.id === id)
      if (index >= 0) {
        list.splice(index, 1)
        emitData(entity)
      }
    },
    onChanged(callback: (entity: EntityName) => void): Unsubscribe {
      dataListeners.add(callback)
      return () => {
        dataListeners.delete(callback)
      }
    },
  },

  chat: {
    async send(text, attachments) {
      const value = text.trim()
      if (value === '') return
      insertChat({ kind: 'user', text: value, meta: JSON.stringify({ attachments: attachments ?? [] }) })
      running = true
      runState.running = true
      emitChat({ type: 'run_started' })
      emitChat({ type: 'thinking', step: 1 })
      clearChatTimers()
      activityTimer = setTimeout(() => {
        insertChat({
          kind: 'activity',
          text: 'Searched memory, 1 found',
          meta: JSON.stringify({ tool: 'memory_search', status: 'done', summary: 'Searched memory, 1 found' }),
        })
      }, 300)
      agentTimer = setTimeout(() => {
        insertChat({
          kind: 'agent',
          text: "Got it. I've added that to the current goal and I'll tell you as soon as it's done. Anything that spends money still waits for your OK.",
          meta: '{}',
        })
        running = false
        runState.running = false
        agentTimer = null
        activityTimer = null
        emitChat({ type: 'run_finished' })
      }, 800)
    },
    async stop() {
      if (!running) return
      clearChatTimers()
      running = false
      runState.running = false
      insertChat({ kind: 'notice', text: 'Stopped', meta: '{}' })
      emitChat({ type: 'run_finished' })
    },
    async state() {
      runState.running = running
      runState.waiting = waitingIds()
      return { ...runState, waiting: [...runState.waiting] }
    },
    async answer(itemId, answer) {
      patchCard(itemId, { answer })
    },
    async decide(itemId, decision: Decision) {
      patchCard(itemId, { decision })
    },
    onEvent(callback: (event: ChatEvent) => void): Unsubscribe {
      chatListeners.add(callback)
      return () => {
        chatListeners.delete(callback)
      }
    },
  },

  routines: {
    async runNow(id) {
      const index = rows.trigger.findIndex((row) => row.id === id)
      const current = rows.trigger[index]
      if (index < 0 || !current) return
      await delay(300)
      rows.trigger[index] = {
        ...current,
        lastRunAt: Date.now(),
        lastResult: 'Run finished, 3 things found',
      }
      emitData('trigger')
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
    onHotkeyStatus(_callback: (status: HotkeyStatus) => void): Unsubscribe {
      return () => undefined
    },
  },

  files: {
    async pick() {
      // Example files so the attach button, the 20 MB rule and image thumbnails all show in the browser preview.
      return [
        {
          path: 'C:\\Users\\You\\Pictures\\whiteboard.png',
          name: 'whiteboard.png',
          mime: 'image/png',
          size: 240_000,
        },
        {
          path: 'C:\\Users\\You\\Documents\\brief.pdf',
          name: 'brief.pdf',
          mime: 'application/pdf',
          size: 820_000,
        },
      ]
    },
    pathsFor(files: File[]) {
      return files.map((file) => `C:\\Users\\You\\Downloads\\${file.name}`)
    },
    async pickFolder() {
      return 'C:\\Users\\You\\Documents'
    },
    async thumbnail(path) {
      if (!/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path)) return null
      const raw = path.split(/[\\/]/).pop() ?? 'image'
      const name = raw.replace(/[<>&"]/g, '').slice(0, 24)
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">` +
        `<rect width="96" height="96" rx="16" fill="#E4E0FF"/>` +
        `<rect x="16" y="22" width="64" height="42" rx="8" fill="#4A3FD1"/>` +
        `<text x="48" y="82" font-family="Roboto,sans-serif" font-size="11" fill="#1C1466" text-anchor="middle">${name}</text>` +
        `</svg>`
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
    },
  },

  system: {
    async info(): Promise<SystemInfo> {
      return {
        platform: 'web',
        arch: 'x64',
        hostname: 'This computer',
        appVersion: '0.0.0',
      }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
