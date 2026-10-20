/**
 * Every `AgentApi` method over real IPC. Handlers validate their arguments, because the renderer
 * is untrusted: it may never make the main process read an arbitrary path or write a huge string.
 */
import {
  PROVIDERS,
  ProviderException,
  isEntityName,
  mimeForFile,
  providerFor,
  type AppInfo,
  type Attachment,
  type BrowserBounds,
  type BrowserState,
  type Decision,
  type EntityMap,
  type EntityName,
  type EnvironmentReport,
  type RowInput,
  type RunState,
  type Settings,
  type SystemInfo,
} from '@agent/core'
import { readFile, stat } from 'node:fs/promises'
import { arch as osArch, hostname as osHostname, platform as osPlatform } from 'node:os'

import { APP_NAME, LICENCES_URL } from './app-info'

import type { AccountService, SignInArgs } from './account'
import type { Store } from './db'
import type { HelperHost } from './runtime/helpers'
import type { Secrets } from './secrets'
import type { SettingsStore } from './settings'
import { CHANNELS, EVENTS } from '../shared/channels'

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void
}

export interface WindowControls {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): boolean
}

export interface ShellLike {
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): void
}

/** The OS pickers. Injected so the handlers can be tested without a display. */
export interface DialogLike {
  pickFiles(): Promise<Attachment[]>
  pickFolder(): Promise<string | null>
}

export type Broadcast = (channel: string, payload?: unknown) => void

/** The chat side the renderer can reach. Runner implements this; tests can pass a small fake. */
export interface ChatRunner {
  send(text: string, attachments?: Attachment[]): Promise<void>
  stop(): void
  state(): RunState
  answer(itemId: string, answer: string): Promise<void>
  decide(itemId: string, decision: Decision): Promise<void>
  /** Optional: only the real runner can drive an installed AI tool. */
  checkCli?(): Promise<{ ok: boolean; message: string }>
}

export interface RoutineService {
  runNow(id: string): Promise<void>
}

/** The browser side the renderer can reach. AgentBrowser implements this. */
export interface BrowserControl {
  setBounds(bounds: BrowserBounds): void
  state(): BrowserState
  /** Resolves when navigation settled; the string result is for the tools, not the renderer. */
  back(): Promise<unknown>
  reload(): Promise<void>
  selectTab(id: string): void
  closeTab(id: string): void
  takeOver(): void
  giveBack(): void
  openInSystem(): Promise<void>
}

export interface IpcDeps {
  store: Store
  settings: SettingsStore
  secrets: Secrets
  account: AccountService
  chat: ChatRunner
  routines?: RoutineService
  helpers?: HelperHost
  ipcMain: IpcMainLike
  windows: WindowControls
  browser?: BrowserControl
  broadcast?: Broadcast
  shell?: ShellLike
  dialogs?: DialogLike
  fetchImpl?: typeof fetch
  /** Filled by `index.ts` from Electron; tests fall back to this machine's own values. */
  systemInfo?: SystemInfo
  /** The session-cached environment scan. */
  environment?: { scan(options?: { refresh?: boolean }): Promise<EnvironmentReport> }
  appInfo?: () => AppInfo
  openLogsFolder?: () => void | Promise<void>
  openLicences?: () => void | Promise<void>
}

const NOT_IMPLEMENTED = 'not implemented yet'
const MAX_STRING = 4096
const MAX_KEY = 8192
const MAX_MESSAGE = 20_000
const MAX_ANSWER = 4_000
const MAX_ATTACHMENTS = 20
const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024
const MAX_BOUND = 10_000

const EMPTY_BROWSER: BrowserState = {
  url: '',
  title: '',
  tabs: [],
  visible: false,
  agentActive: true,
  needsUser: false,
  handoffReason: '',
}

export function registerIpc(deps: IpcDeps): () => void {
  const { store, settings, secrets, account, chat, ipcMain, windows } = deps
  const send: Broadcast = deps.broadcast ?? (() => undefined)
  // Only files the person picked or dropped may be read back for a thumbnail.
  const previewPaths = new Set<string>()

  const handle = (
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(channel, listener)
  }

  // ---- settings ----

  handle(CHANNELS.settings.get, async () => settings.get())

  handle(CHANNELS.settings.save, async (_event, patch) => {
    const object = requireObject(patch, 'settings')
    return settings.save(object as Partial<Settings>)
  })

  handle(CHANNELS.settings.providers, async () => PROVIDERS)

  handle(CHANNELS.settings.setApiKey, async (_event, key) => {
    const value = requireString(key, 'key', MAX_KEY).trim()
    if (value === '') secrets.delete('apiKey')
    else secrets.set('apiKey', value)
    settings.save({ hasKey: value !== '' })
  })

  handle(CHANNELS.settings.checkKey, async () => checkKey(deps))
  handle(CHANNELS.settings.checkCli, async () =>
    deps.chat.checkCli === undefined ? { ok: false, message: 'Not available in this build.' } : deps.chat.checkCli(),
  )

  handle(CHANNELS.settings.reset, async () => {
    await account.signOut()
    await store.clearAll()
    settings.reset()
    secrets.delete('apiKey')
    secrets.delete('syncToken')
  })

  // ---- account ----

  handle(CHANNELS.account.signIn, async (_event, rawArgs) => {
    const args = requireObject(rawArgs, 'sign-in details')
    const mode = args['mode']
    if (mode !== 'login' && mode !== 'register') throw new Error('mode must be login or register')
    const signIn: SignInArgs = {
      serverUrl: requireString(args['serverUrl'], 'server address', MAX_STRING),
      email: requireString(args['email'], 'email', MAX_STRING),
      password: requireString(args['password'], 'password', MAX_STRING),
      mode,
    }
    return account.signIn(signIn)
  })

  handle(CHANNELS.account.signOut, async () => {
    await account.signOut()
  })

  handle(CHANNELS.account.firstSync, async () => account.firstSync())
  handle(CHANNELS.account.syncNow, async () => account.syncNow())
  handle(CHANNELS.account.status, async () => account.status())

  // ---- data ----

  handle(CHANNELS.data.list, async (_event, rawEntity) => {
    return store.list(entityArg(rawEntity))
  })

  handle(CHANNELS.data.upsert, async (_event, rawEntity, rawRow) => {
    const entity = entityArg(rawEntity)
    const row = requireObject(rawRow, 'row')
    const saved = await store.upsert(entity, row as RowInput<EntityName>)
    account.nudge()
    return saved
  })

  handle(CHANNELS.data.remove, async (_event, rawEntity, rawId) => {
    const entity = entityArg(rawEntity)
    const id = requireString(rawId, 'id', MAX_STRING)
    await store.remove(entity, id)
    account.nudge()
  })

  // ---- chat ----

  handle(CHANNELS.chat.send, async (_event, rawText, rawAttachments) => {
    const text = requireString(rawText, 'message', MAX_MESSAGE)
    const attachments = requireAttachments(rawAttachments)
    await chat.send(text, attachments)
  })

  handle(CHANNELS.chat.stop, async () => {
    chat.stop()
  })

  handle(CHANNELS.chat.state, async () => chat.state())

  handle(CHANNELS.chat.answer, async (_event, rawId, rawAnswer) => {
    const id = requireString(rawId, 'card id', MAX_STRING)
    const answer = requireString(rawAnswer, 'answer', MAX_ANSWER)
    await chat.answer(id, answer)
  })

  handle(CHANNELS.chat.decide, async (_event, rawId, rawDecision) => {
    const id = requireString(rawId, 'card id', MAX_STRING)
    if (rawDecision !== 'approve' && rawDecision !== 'decline') {
      throw new Error('decision must be approve or decline')
    }
    await chat.decide(id, rawDecision)
  })

  // ---- routines ----

  handle(CHANNELS.routines.runNow, async (_event, rawId) => {
    const id = requireString(rawId, 'routine id', MAX_STRING)
    if (deps.routines === undefined) throw new Error('Routines are not ready yet')
    await deps.routines.runNow(id)
  })

  // ---- helpers ----

  handle(CHANNELS.helpers.stop, async (_event, rawId) => {
    const id = requireString(rawId, 'helper id', MAX_STRING)
    if (deps.helpers === undefined) return false
    return deps.helpers.stop(id)
  })

  handle(CHANNELS.helpers.stopAll, async () => {
    if (deps.helpers === undefined) return 0
    return deps.helpers.stopAll()
  })

  // ---- the agent's browser ----

  handle(CHANNELS.browser.setBounds, async (_event, rawBounds) => {
    deps.browser?.setBounds(boundsArg(rawBounds))
  })

  handle(CHANNELS.browser.state, async () => deps.browser?.state() ?? EMPTY_BROWSER)
  handle(CHANNELS.browser.back, async () => {
    await deps.browser?.back()
  })
  handle(CHANNELS.browser.reload, async () => {
    await deps.browser?.reload()
  })

  handle(CHANNELS.browser.selectTab, async (_event, rawId) => {
    deps.browser?.selectTab(requireString(rawId, 'tab id', MAX_STRING))
  })

  handle(CHANNELS.browser.closeTab, async (_event, rawId) => {
    deps.browser?.closeTab(requireString(rawId, 'tab id', MAX_STRING))
  })

  handle(CHANNELS.browser.takeOver, async () => {
    deps.browser?.takeOver()
  })

  handle(CHANNELS.browser.giveBack, async () => {
    deps.browser?.giveBack()
  })

  handle(CHANNELS.browser.openInSystem, async () => {
    await deps.browser?.openInSystem()
  })

  // ---- files ----

  handle(CHANNELS.files.pick, async () => {
    if (deps.dialogs === undefined) return notImplemented()
    const picked = await deps.dialogs.pickFiles()
    return picked.slice(0, MAX_ATTACHMENTS).map((attachment) => {
      const path = requireString(attachment.path, 'attachment path', MAX_STRING)
      previewPaths.add(path)
      return {
        path,
        name: requireString(attachment.name, 'attachment name', MAX_STRING),
        mime: requireString(attachment.mime, 'attachment type', MAX_STRING),
        ...(typeof attachment.size === 'number' ? { size: attachment.size } : {}),
      }
    })
  })

  handle(CHANNELS.files.register, async (_event, rawPaths) => {
    if (!Array.isArray(rawPaths)) throw new Error('paths must be a list')
    if (rawPaths.length > MAX_ATTACHMENTS) throw new Error('too many files')
    for (const rawPath of rawPaths) previewPaths.add(requireString(rawPath, 'path', MAX_STRING))
  })

  handle(CHANNELS.files.thumbnail, async (_event, rawPath) => {
    const path = requireString(rawPath, 'path', MAX_STRING)
    if (!previewPaths.has(path)) return null
    const mime = mimeForFile(path)
    if (!mime.startsWith('image/')) return null
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > MAX_THUMBNAIL_BYTES) return null
      const bytes = await readFile(path)
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  })

  handle(CHANNELS.files.pickFolder, async () => {
    if (deps.dialogs === undefined) return notImplemented()
    const folder = await deps.dialogs.pickFolder()
    if (folder === null) return null
    return requireString(folder, 'folder', MAX_STRING)
  })

  // ---- system ----

  handle(CHANNELS.system.info, async () => deps.systemInfo ?? thisMachine())

  handle(CHANNELS.environment.scan, async (_event, rawRefresh) => {
    if (deps.environment === undefined) return emptyEnvironment()
    return deps.environment.scan({ refresh: rawRefresh === true })
  })

  // ---- window ----

  handle(CHANNELS.window.minimize, async () => {
    windows.minimize()
  })
  handle(CHANNELS.window.toggleMaximize, async () => {
    windows.toggleMaximize()
  })
  handle(CHANNELS.window.close, async () => {
    windows.close()
  })
  handle(CHANNELS.window.isMaximized, async () => windows.isMaximized())

  // ---- shell ----

  handle(CHANNELS.shell.openExternal, async (_event, rawUrl) => {
    const url = requireString(rawUrl, 'url', MAX_STRING)
    const parsed = parseHttpUrl(url)
    await deps.shell?.openExternal(parsed)
  })

  handle(CHANNELS.shell.reveal, async (_event, rawPath) => {
    const path = requireString(rawPath, 'path', MAX_STRING)
    deps.shell?.showItemInFolder(path)
  })

  // ---- app identity ----

  handle(CHANNELS.app.info, async () => {
    return deps.appInfo?.() ?? fallbackAppInfo()
  })

  handle(CHANNELS.app.openLogsFolder, async () => {
    await deps.openLogsFolder?.()
  })

  handle(CHANNELS.app.openLicences, async () => {
    await deps.openLicences?.()
  })

  // ---- events out ----

  const offSettings = settings.onChange((next) => send(EVENTS.settings, next))
  const offStatus = account.onStatus((status) => send(EVENTS.accountStatus, status))
  const offProgress = account.onProgress((progress) => send(EVENTS.accountProgress, progress))
  const offData = store.onChange((entity) => send(EVENTS.data, entity))

  return () => {
    offSettings()
    offStatus()
    offProgress()
    offData()
  }
}

async function checkKey(deps: IpcDeps): Promise<{ ok: boolean; message: string }> {
  const current = deps.settings.get()
  const key = deps.secrets.get('apiKey')
  if (key === null || key.trim() === '') return { ok: false, message: 'Add an API key first.' }

  const info = PROVIDERS.find((provider) => provider.id === current.provider)
  const model = current.model.trim() || info?.defaultModel || ''
  if (model === '') return { ok: false, message: 'Choose a model first.' }
  if (current.provider === 'custom' && current.baseUrl.trim() === '') {
    return { ok: false, message: 'Add the server address for this provider.' }
  }

  try {
    const provider = providerFor({
      provider: current.provider,
      key,
      baseUrl: current.baseUrl.trim() || undefined,
      allowHttp: current.allowHttp,
      fetchImpl: deps.fetchImpl,
    })
    await provider.complete(
      'You are checking a connection. Reply with the single word OK.',
      [{ role: 'USER', blocks: [{ t: 'text', text: 'Reply with OK.' }] }],
      [],
      model,
      16,
    )
    return { ok: true, message: 'That key works.' }
  } catch (error) {
    if (error instanceof ProviderException) {
      if (error.status === 401) return { ok: false, message: 'That key was not accepted.' }
      if (error.status === 0) return { ok: false, message: 'Could not reach the provider.' }
      return { ok: false, message: error.message }
    }
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not check the key.',
    }
  }
}

function fallbackAppInfo(): AppInfo {
  return {
    name: APP_NAME,
    version: '0.0.0',
    platform: 'linux',
    electron: '0.0.0',
    logsPath: '',
    licencesUrl: LICENCES_URL,
  }
}

function notImplemented(): never {
  throw new Error(NOT_IMPLEMENTED)
}

function thisMachine(): SystemInfo {
  return {
    platform: osPlatform(),
    arch: osArch(),
    hostname: osHostname(),
    appVersion: '0.0.0',
  }
}

/** Before the scan is wired (tests, early boot) the UI still gets a truthful, empty shape. */
function emptyEnvironment(): EnvironmentReport {
  return {
    os: { platform: osPlatform(), release: '', arch: osArch(), hostname: osHostname() },
    shells: [],
    runtimes: [],
    aiTools: [],
    notes: [],
    scannedAt: 0,
  }
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text`)
  if (value.length > max) throw new Error(`${name} is too long`)
  return value
}

function requireAttachments(value: unknown): Attachment[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('attachments must be a list')
  if (value.length > MAX_ATTACHMENTS) throw new Error('too many attachments')
  return value.map((item) => {
    const row = requireObject(item, 'attachment')
    return {
      path: requireString(row['path'], 'attachment path', MAX_STRING),
      name: requireString(row['name'], 'attachment name', MAX_STRING),
      mime: requireString(row['mime'], 'attachment type', MAX_STRING),
      ...(typeof row['size'] === 'number' && Number.isFinite(row['size'])
        ? { size: row['size'] }
        : {}),
    }
  })
}

function boundsArg(value: unknown): BrowserBounds {
  const raw = requireObject(value, 'browser bounds')
  return {
    x: requireNumber(raw['x'], 'x', -MAX_BOUND, MAX_BOUND),
    y: requireNumber(raw['y'], 'y', -MAX_BOUND, MAX_BOUND),
    width: requireNumber(raw['width'], 'width', 0, MAX_BOUND),
    height: requireNumber(raw['height'], 'height', 0, MAX_BOUND),
    visible: raw['visible'] === true,
  }
}

function requireNumber(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`)
  }
  return value
}

function entityArg(value: unknown): EntityName {
  if (!isEntityName(value)) throw new Error('Unknown entity')
  return value
}

function parseHttpUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('That address is not a valid URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only web addresses can be opened')
  }
  return url.toString()
}

/** Kept exported for callers that want the concrete row type behind an entity name. */
export type RowFor<E extends EntityName> = EntityMap[E]
