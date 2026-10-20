/**
 * Every `AgentApi` method over real IPC. Handlers validate their arguments, because the renderer
 * is untrusted: it may never make the main process read an arbitrary path or write a huge string.
 *
 * The chat, routine and file groups are deliberately not implemented yet (M6/M7/M8); they answer
 * "not implemented yet" instead of pretending to work.
 */
import {
  PROVIDERS,
  ProviderException,
  isEntityName,
  providerFor,
  type AppInfo,
  type EntityMap,
  type EntityName,
  type RowInput,
  type Settings,
} from '@agent/core'

import { APP_NAME, LICENCES_URL } from './app-info'

import type { AccountService, SignInArgs } from './account'
import type { Store } from './db'
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

export type Broadcast = (channel: string, payload?: unknown) => void

export interface IpcDeps {
  store: Store
  settings: SettingsStore
  secrets: Secrets
  account: AccountService
  ipcMain: IpcMainLike
  windows: WindowControls
  broadcast?: Broadcast
  shell?: ShellLike
  fetchImpl?: typeof fetch
  appInfo?: () => AppInfo
  openLogsFolder?: () => void | Promise<void>
  openLicences?: () => void | Promise<void>
}

const NOT_IMPLEMENTED = 'not implemented yet'
const MAX_STRING = 4096
const MAX_KEY = 8192

export function registerIpc(deps: IpcDeps): () => void {
  const { store, settings, secrets, account, ipcMain, windows } = deps
  const send: Broadcast = deps.broadcast ?? (() => undefined)

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

  // ---- not built yet ----

  handle(CHANNELS.chat.send, async () => notImplemented())
  handle(CHANNELS.chat.stop, async () => notImplemented())
  handle(CHANNELS.chat.state, async () => notImplemented())
  handle(CHANNELS.chat.answer, async () => notImplemented())
  handle(CHANNELS.chat.decide, async () => notImplemented())
  handle(CHANNELS.routines.runNow, async () => notImplemented())
  handle(CHANNELS.files.pick, async () => notImplemented())
  handle(CHANNELS.files.pickFolder, async () => notImplemented())

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
