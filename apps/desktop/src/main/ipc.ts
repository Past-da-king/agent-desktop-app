/**
 * Every `AgentApi` method over real IPC. Handlers validate their arguments, because the renderer
 * is untrusted: it may never make the main process read an arbitrary path or write a huge string.
 */
import {
  PROVIDERS,
  ProviderException,
  isEntityName,
  MAX_ATTACHMENT_BYTES,
  mimeForFile,
  providerFor,
  type AppInfo,
  type Attachment,
  type BrowserBounds,
  type BrowserState,
  type BrowserViewMode,
  type ChatRunInfo,
  type Decision,
  type EntityMap,
  type EntityName,
  type EnvironmentReport,
  type ProfileAccount,
  type ProfileColor,
  type RowInput,
  type RunState,
  type Settings,
  type SystemInfo,
  accountsOf,
  type AiAccount,
  type AiAccountDraft,
  type ChatBrain,
  type ProviderId,
} from '@agent/core'
import { readFile, stat } from 'node:fs/promises'
import { arch as osArch, hostname as osHostname, platform as osPlatform } from 'node:os'

import { APP_NAME, LICENCES_URL } from './app-info'

import type { AccountService, SignInArgs } from './account'
import { POPULAR_APPS } from './apps/catalog'
import type { AppsService } from './apps/service'
import { isProfileColor } from './apps/profiles'
import { asWriter } from './memory/history'
import { isIconImage } from '../shared/project-icon'
import { lightRow } from '../shared/light-row'
import { parseRouteTarget } from '../shared/route-target'
import { picksFrom } from './settings'
import type { AccountStore } from './accounts'
import { listPeople, type PeopleSource } from './browser/people'
import { isRule } from './apps/store'
import { HelperFeed } from './devices/helper-feed'
import type { Store } from './db'
import { guardRoutineWrite } from './memory/routine'
import { listModels } from './models'
import type { HelperHost } from './runtime/helpers'
import type { Secrets } from './secrets'
import type { SettingsStore } from './settings'
import { CHANNELS, EVENTS } from '../shared/channels'
import { messageOrigin } from './devices/origin'
import type { MessageOrigin } from './devices/types'

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
  /** `origin`: the device the message came from (devices/origin.ts), kept on the user row as meta.origin. */
  send(text: string, attachments?: Attachment[], chat?: string, origin?: MessageOrigin): Promise<void>
  stop(chat?: string): void
  state(chat?: string): RunState
  /** Several chats at once: every chat with something going on. */
  states?(): ChatRunInfo[]
  /** A new chat with the history up to this message. */
  branch?(itemId: string): Promise<string>
  answer(itemId: string, answer: string): Promise<void>
  decide(itemId: string, decision: Decision): Promise<void>
  /** A button tap on an agent card, heard by the agent quietly. */
  tap(itemId: string, label: string, message: string): Promise<void>
  /** Optional: only the real runner can drive an installed AI tool. */
  checkCli?(accountId?: string): Promise<{ ok: boolean; message: string }>
  cliLogin?(accountId?: string): Promise<{ ok: boolean; message: string }>
  planModels?(accountId?: string): Promise<Array<{ id: string; label: string; line: string }>>
  /** What a chat thinks with, for the picker in its header. */
  chatBrain?(chat: string): Promise<ChatBrain>
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
  /** Optional so older fakes keep compiling; AgentBrowser has it. */
  setViewMode?(mode: BrowserViewMode): Promise<void>
  setExpanded?(on: boolean): void
  frame?(): Promise<string | null>
  personOpen?(address: string): Promise<void>
  personNewTab?(): void
  /** A <webview> in the main window is attached for a tab; `senderId` is the asking renderer's webContents id. */
  attachGuest?(tabId: string, guestId: number, senderId: number | null): boolean
  openDevTools?(): void
  /** The person's Fix this site: forget what was learned for the site and reload as this computer's own browser. */
  fixSite?(): Promise<string>
  setMuted?(on: boolean): void
  personPartition?(): string
  usePersonPartition?(partition: string): void
  signOutPartition?(partition: string): Promise<void>
  /** Google accounts signed in to a partition (Google's own ListAccounts), [] when none. */
  googleAccounts?(partition: string): Promise<string[]>
}

export interface IpcDeps {
  store: Store
  /** The AI accounts (main/accounts.ts). Absent in a build without them: the old single choice only. */
  accounts?: AccountStore
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
  /** Connected apps and learned apps. Without it, Connections shows no key and no learned apps. */
  apps?: AppsService
  /** Pasted things without a file (screenshots, long text) and files copied in the file manager. */
  pasted?: PastedFiles
}

/** Saves pasted bytes as an attachment, and reads the files on the system clipboard. */
export interface PastedFiles {
  save(name: string, mime: string, bytes: Uint8Array): Promise<Attachment>
  clipboardFiles(): Promise<Attachment[]>
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
  handle(CHANNELS.settings.listModels, async () => {
    const current = deps.settings.get()
    if (current.mode === 'subscription') {
      const models = (await deps.chat.planModels?.()) ?? []
      const name = current.cli === 'codex' ? 'ChatGPT' : 'Claude'
      return models.length > 0
        ? { ok: true, models, message: `${models.length} models on your ${name} plan.` }
        : { ok: false, models: [], message: `Could not get the models from your ${name} plan yet. Send one message first, then try again.` }
    }
    const key = deps.secrets.get('apiKey')
    if (key === null || key.trim() === '') return { ok: false, models: [], message: 'Add an API key first.' }
    return listModels({
      provider: current.provider,
      key,
      ...(current.baseUrl.trim() === '' ? {} : { baseUrl: current.baseUrl.trim() }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
  })
  // ---- AI accounts (main/accounts.ts) ----
  const accountsStore = (): AccountStore => {
    if (deps.accounts === undefined) throw new Error('Not available in this build.')
    return deps.accounts
  }
  const accountDraft = (raw: unknown): AiAccountDraft => {
    const o = requireObject(raw, 'account')
    const out: AiAccountDraft = {}
    if (typeof o['label'] === 'string') out.label = requireString(o['label'], 'label', 60)
    if (o['kind'] === 'claude' || o['kind'] === 'codex' || o['kind'] === 'api') out.kind = o['kind']
    if (typeof o['provider'] === 'string') {
      if (!PROVIDERS.some((p) => p.id === o['provider'])) throw new Error('Unknown provider')
      out.provider = o['provider'] as ProviderId
    }
    if (typeof o['baseUrl'] === 'string') out.baseUrl = requireString(o['baseUrl'], 'server address', MAX_STRING)
    if (typeof o['model'] === 'string') out.model = requireString(o['model'], 'model', 200)
    if (typeof o['allowHttp'] === 'boolean') out.allowHttp = o['allowHttp']
    return out
  }
  const accountId = (raw: unknown): string => requireString(raw, 'account', 64)
  handle(CHANNELS.settings.accounts.add, async (_event, raw) => accountsStore().add(accountDraft(raw)))
  handle(CHANNELS.settings.accounts.update, async (_event, rawId, raw) => accountsStore().update(accountId(rawId), accountDraft(raw)))
  handle(CHANNELS.settings.accounts.remove, async (_event, rawId) => {
    accountsStore().remove(accountId(rawId))
  })
  handle(CHANNELS.settings.accounts.setKey, async (_event, rawId, rawKey) => {
    accountsStore().setKey(accountId(rawId), requireString(rawKey, 'key', MAX_KEY))
  })
  handle(CHANNELS.settings.accounts.check, async (_event, rawId) => {
    const id = accountId(rawId)
    const account = accountsStore().find(id)
    if (account === null) throw new Error('No such account')
    if (account.kind !== 'api') {
      return deps.chat.checkCli === undefined ? { ok: false, message: 'Not available in this build.' } : deps.chat.checkCli(id)
    }
    return checkAccountKey(deps, account, accountsStore().key(id))
  })
  handle(CHANNELS.settings.accounts.listModels, async (_event, rawId) => {
    const id = accountId(rawId)
    const account = accountsStore().find(id)
    if (account === null) throw new Error('No such account')
    if (account.kind !== 'api') {
      const models = (await deps.chat.planModels?.(id)) ?? []
      const name = account.kind === 'codex' ? 'ChatGPT' : 'Claude'
      return models.length > 0
        ? { ok: true, models, message: `${models.length} models on your ${name} plan.` }
        : { ok: false, models: [], message: `Could not get the models from your ${name} plan yet. Send one message first, then try again.` }
    }
    const key = accountsStore().key(id)
    if (key === '') return { ok: false, models: [], message: 'Add an API key first.' }
    return listModels({
      provider: account.provider ?? 'anthropic',
      key,
      ...((account.baseUrl ?? '').trim() === '' ? {} : { baseUrl: (account.baseUrl ?? '').trim() }),
      ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
    })
  })
  handle(CHANNELS.settings.accounts.signIn, async (_event, rawId) => {
    const id = accountId(rawId)
    if (accountsStore().find(id) === null) throw new Error('No such account')
    return deps.chat.cliLogin === undefined ? { ok: false, message: 'Not available in this build.' } : deps.chat.cliLogin(id)
  })
  handle(CHANNELS.settings.accounts.chatBrain, async (_event, rawChat) => {
    const chat = requireString(rawChat, 'chat', 64)
    if (deps.chat.chatBrain === undefined) {
      const none = { account: '', model: '' }
      return { main: { wanted: none, using: none, deferred: false }, helpers: { wanted: none, using: none, deferred: false } }
    }
    return deps.chat.chatBrain(chat)
  })

  handle(CHANNELS.settings.cliLogin, async () =>
    deps.chat.cliLogin === undefined ? { ok: false, message: 'Not available in this build.' } : deps.chat.cliLogin(),
  )
  handle(CHANNELS.settings.checkCli, async () =>
    deps.chat.checkCli === undefined ? { ok: false, message: 'Not available in this build.' } : deps.chat.checkCli(),
  )

  handle(CHANNELS.settings.reset, async () => {
    await account.signOut()
    await store.clearAll()
    settings.reset()
    secrets.delete('apiKey')
    secrets.delete('syncToken')
    secrets.delete('geminiKey')
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
    const entity = entityArg(rawEntity)
    // Listed rows travel light (a run's long output stays behind); data.get has the whole row.
    return (await store.list(entity)).map((row) => lightRow(entity, row))
  })

  handle(CHANNELS.data.get, async (_event, rawEntity, rawId) => {
    return store.get(entityArg(rawEntity), requireString(rawId, 'id', MAX_STRING))
  })

  handle(CHANNELS.data.upsert, async (_event, rawEntity, rawRow) => {
    const entity = entityArg(rawEntity)
    let row = requireObject(rawRow, 'row')
    if (entity === 'trigger') row = await guardRoutineWrite(store, row)
    if (entity === 'project') row = withSafeIcon(withKnownPicks(row, deps))
    // A memory page changed in the window is the person's own edit (memory/history.ts).
    const saved = await asWriter('you', undefined, () => store.upsert(entity, row as RowInput<EntityName>))
    account.nudge()
    return saved
  })

  handle(CHANNELS.data.remove, async (_event, rawEntity, rawId) => {
    const entity = entityArg(rawEntity)
    const id = requireString(rawId, 'id', MAX_STRING)
    await asWriter('you', undefined, () => store.remove(entity, id))
    account.nudge()
  })

  // ---- chat ----

  handle(CHANNELS.chat.send, async (event, rawText, rawAttachments, rawChat) => {
    const text = requireString(rawText, 'message', MAX_MESSAGE)
    const attachments = requireAttachments(rawAttachments)
    const target = optionalChat(rawChat)
    const origin = messageOrigin(event)
    if (origin !== undefined) await chat.send(text, attachments, target, origin)
    else if (target === undefined) await chat.send(text, attachments)
    else await chat.send(text, attachments, target)
  })

  handle(CHANNELS.chat.stop, async (_event, rawChat) => {
    const target = optionalChat(rawChat)
    if (target === undefined) chat.stop()
    else chat.stop(target)
  })

  handle(CHANNELS.chat.state, async (_event, rawChat) => {
    const target = optionalChat(rawChat)
    return target === undefined ? chat.state() : chat.state(target)
  })

  handle(CHANNELS.chat.states, async () => chat.states?.() ?? [])

  handle(CHANNELS.chat.branch, async (_event, rawId) => {
    const id = requireString(rawId, 'message id', MAX_STRING)
    if (chat.branch === undefined) return notImplemented()
    return chat.branch(id)
  })

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

  handle(CHANNELS.chat.tap, async (_event, rawId, rawLabel, rawMessage) => {
    const id = requireString(rawId, 'message id', MAX_STRING)
    const label = requireString(rawLabel, 'button label', MAX_STRING)
    const message = requireString(rawMessage, 'tap', MAX_ANSWER)
    await chat.tap(id, label, message)
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

  // The helper cards a linked device shows: the same model as the side panel, built here and sent on each change.
  const helperFeed = new HelperFeed({
    store,
    emit: (snapshot) => send(EVENTS.helperCards, snapshot),
    running: (id) => (chat.states?.() ?? []).some((info) => info.chat === id && info.running),
  })
  handle(CHANNELS.helpers.cards, async () => helperFeed.snapshot())

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

  handle(CHANNELS.browser.setView, async (_event, rawMode) => {
    const mode = requireString(rawMode, 'view', 16)
    if (mode !== 'desktop' && mode !== 'tablet' && mode !== 'phone' && mode !== 'fit') {
      throw new Error('view must be desktop, tablet, phone or fit')
    }
    await deps.browser?.setViewMode?.(mode)
  })
  handle(CHANNELS.browser.frame, async () => (await deps.browser?.frame?.()) ?? null)
  handle(CHANNELS.browser.go, async (_event, rawAddress) => {
    if (typeof rawAddress !== 'string' || rawAddress.length > 4000) throw new Error('address must be text')
    await deps.browser?.personOpen?.(rawAddress)
  })
  handle(CHANNELS.browser.newTab, async () => {
    deps.browser?.personNewTab?.()
  })
  handle(CHANNELS.browser.devtools, async () => {
    deps.browser?.openDevTools?.()
  })
  handle(CHANNELS.browser.fixSite, async () => (await deps.browser?.fixSite?.()) ?? 'The browser is not running.')
  handle(CHANNELS.browser.setMuted, async (_event, rawOn) => {
    if (typeof rawOn !== 'boolean') throw new Error('muted must be true or false')
    deps.browser?.setMuted?.(rawOn)
  })
  const people = (): PeopleSource => ({
    profiles: () => deps.apps?.profiles.all() ?? [],
    personPartition: () => deps.browser?.personPartition?.() ?? '',
    googleAccounts: async (partition) => (await deps.browser?.googleAccounts?.(partition)) ?? [],
  })
  const knownPerson = async (rawId: unknown): Promise<string> => {
    const id = requireString(rawId, 'profile', 64)
    const listed = await listPeople({ ...people(), googleAccounts: async () => [] })
    const person = listed.find((p) => p.id === id)
    if (person === undefined) throw new Error('No such browser profile')
    return person.partition
  }
  handle(CHANNELS.browser.people, async () => listPeople(people()))
  handle(CHANNELS.browser.usePerson, async (_event, rawId) => {
    deps.browser?.usePersonPartition?.(await knownPerson(rawId))
  })
  handle(CHANNELS.browser.signOut, async (_event, rawId) => {
    await deps.browser?.signOutPartition?.(await knownPerson(rawId))
  })
  handle(CHANNELS.browser.setExpanded, async (_event, rawOn) => {
    if (typeof rawOn !== 'boolean') throw new Error('expanded must be true or false')
    deps.browser?.setExpanded?.(rawOn)
  })
  handle(CHANNELS.browser.openInSystem, async () => {
    await deps.browser?.openInSystem()
  })
  handle(CHANNELS.browser.attach, async (event, rawTab, rawGuest) => {
    const tabId = requireString(rawTab, 'tab id', MAX_STRING)
    if (typeof rawGuest !== 'number' || !Number.isInteger(rawGuest) || rawGuest <= 0) throw new Error('guest must be a webContents id')
    const sender = (event as { sender?: { id?: unknown } } | null)?.sender?.id
    return deps.browser?.attachGuest?.(tabId, rawGuest, typeof sender === 'number' ? sender : null) ?? false
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

  handle(CHANNELS.files.savePasted, async (_event, rawName, rawMime, rawBytes) => {
    if (deps.pasted === undefined) return notImplemented()
    const name = requireString(rawName, 'file name', MAX_STRING)
    const mime = requireString(rawMime, 'file type', MAX_STRING)
    if (!(rawBytes instanceof Uint8Array)) throw new Error('pasted bytes must be binary')
    if (rawBytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('pasted file is too big')
    const saved = await deps.pasted.save(name, mime, rawBytes)
    previewPaths.add(saved.path)
    return saved
  })

  handle(CHANNELS.files.clipboardFiles, async () => {
    if (deps.pasted === undefined) return []
    const files = (await deps.pasted.clipboardFiles()).slice(0, MAX_ATTACHMENTS)
    for (const file of files) previewPaths.add(file.path)
    return files
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
  // Puts a view on screen as a tap does (renderer state/keys.ts routeTo): a chat in full, a helper's view, Back. The
  // window's own buttons do it in the renderer; this is the same for the agent (app_action window.show).
  handle(CHANNELS.window.show, async (_event, rawTarget) => {
    const target = parseRouteTarget(rawTarget)
    if (target === null) return false
    send(EVENTS.route, target)
    return true
  })

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

  // ---- connected apps and learned apps ----

  handle(CHANNELS.apps.status, async () =>
    deps.apps === undefined
      ? { hasKey: false, keyKind: '', accounts: [], connecting: [], message: '' }
      : deps.apps.status(),
  )

  handle(CHANNELS.apps.setKey, async (_event, rawKey) => {
    const key = requireString(rawKey, 'key', MAX_KEY)
    if (deps.apps === undefined) return { ok: false, message: 'Not available in this build.' }
    return deps.apps.setKey(key)
  })

  handle(CHANNELS.apps.catalog, async () => (deps.apps === undefined ? POPULAR_APPS : deps.apps.catalog()))
  handle(CHANNELS.apps.search, async (_event, rawQuery) => {
    if (typeof rawQuery !== 'string' || rawQuery.length > 200) throw new Error('query must be text')
    return deps.apps === undefined ? [] : deps.apps.searchApps(rawQuery)
  })

  handle(CHANNELS.apps.connect, async (_event, rawApp) => {
    const app = requireString(rawApp, 'app', 64).trim().toLowerCase()
    if (!/^[a-z0-9_]{2,60}$/.test(app)) throw new Error('Invalid app')
    if (deps.apps === undefined) return { ok: false, message: 'Not available in this build.' }
    return deps.apps.connect(app)
  })

  handle(CHANNELS.apps.disconnect, async (_event, rawId) => {
    const id = requireString(rawId, 'accountId', 200)
    await deps.apps?.disconnect(id)
  })

  handle(CHANNELS.apps.setRules, async (_event, rawId, rawRules) => {
    const id = requireString(rawId, 'accountId', 200)
    const rules = requireObject(rawRules, 'rules') as Record<string, unknown>
    const read = rules['read']
    const change = rules['change']
    if (!isRule(read) || !isRule(change)) throw new Error('Invalid rules')
    deps.apps?.setRules(id, { read, change })
  })

  handle(CHANNELS.apps.learned, async () => deps.apps?.learnedApps() ?? [])

  handle(CHANNELS.apps.removeLearned, async (_event, rawId) => {
    deps.apps?.removeLearned(requireString(rawId, 'id', 64))
  })

  handle(CHANNELS.apps.setTrusted, async (_event, rawId, rawOn) => {
    if (typeof rawOn !== 'boolean') throw new Error('Invalid trusted')
    deps.apps?.setTrusted(requireString(rawId, 'id', 64), rawOn)
  })

  // ---- profiles (profiles.json under userData; see apps/profiles.ts) ----

  const profileDraft = async (raw: unknown, partial: boolean): Promise<{
    name?: string
    color?: ProfileColor
    accounts?: ProfileAccount[]
    learned?: string[]
    browser?: string
  }> => {
    const draft = requireObject(raw, 'profile') as Record<string, unknown>
    const out: { name?: string; color?: ProfileColor; accounts?: ProfileAccount[]; learned?: string[]; browser?: string } = {}
    if (draft['name'] !== undefined || !partial) out.name = requireString(draft['name'], 'name', 200)
    if (draft['color'] !== undefined) {
      if (!isProfileColor(draft['color'])) throw new Error('Invalid colour')
      out.color = draft['color']
    }
    if (draft['accounts'] !== undefined) {
      const ids = requireIdList(draft['accounts'], 'accounts')
      out.accounts = deps.apps === undefined ? [] : await deps.apps.accountRefs(ids)
    }
    if (draft['learned'] !== undefined) {
      const known = new Set((deps.apps?.learnedApps() ?? []).map((a) => a.id))
      out.learned = requireIdList(draft['learned'], 'learned').filter((id) => known.has(id))
    }
    if (draft['browser'] !== undefined) out.browser = requireString(draft['browser'], 'browser', 64)
    return out
  }

  handle(CHANNELS.profiles.list, async () => deps.apps?.profiles.all() ?? [])

  handle(CHANNELS.profiles.create, async (_event, raw) => {
    if (deps.apps === undefined) return { ok: false, message: 'Not available in this build.' }
    const draft = await profileDraft(raw, false)
    const made = deps.apps.profiles.create(draft.name ?? '', draft.accounts ?? [], draft.color, draft.browser ?? '', draft.learned ?? [])
    return made.ok ? { ok: true, message: made.message, profile: made.value } : { ok: false, message: made.message }
  })

  handle(CHANNELS.profiles.update, async (_event, rawId, raw) => {
    if (deps.apps === undefined) return { ok: false, message: 'Not available in this build.' }
    const id = requireString(rawId, 'id', 64)
    const outcome = deps.apps.profiles.update(id, await profileDraft(raw, true))
    return { ok: outcome.ok, message: outcome.message }
  })

  handle(CHANNELS.profiles.remove, async (_event, rawId) => {
    deps.apps?.profiles.remove(requireString(rawId, 'id', 64))
  })

  handle(CHANNELS.profiles.setMember, async (_event, rawProfile, rawAccount, rawMember) => {
    const profileId = requireString(rawProfile, 'profileId', 64)
    const accountId = requireString(rawAccount, 'accountId', 200)
    if (typeof rawMember !== 'boolean') throw new Error('Invalid member')
    if (deps.apps === undefined) return
    if (!rawMember) {
      deps.apps.profiles.setMember(profileId, { id: accountId, app: '', label: '' }, false)
      return
    }
    const [ref] = await deps.apps.accountRefs([accountId])
    if (ref !== undefined) deps.apps.profiles.setMember(profileId, ref, true)
  })

  // ---- events out ----

  const offSettings = settings.onChange((next) => send(EVENTS.settings, next))
  const offStatus = account.onStatus((status) => send(EVENTS.accountStatus, status))
  const offProgress = account.onProgress((progress) => send(EVENTS.accountProgress, progress))
  // Each change goes to the window with its row (light), so the window patches its list instead of reading it all.
  const offData = store.onChange((change) => {
    // Nothing in the window shows turns (the model's own transcript); sending them only costs.
    if (change.entity === 'turn') return
    send(EVENTS.data, change.row === undefined ? change : { ...change, row: lightRow(change.entity, change.row) })
  })
  const offApps = deps.apps?.onChange(() => send(EVENTS.apps, null)) ?? (() => undefined)
  const offProfiles = deps.apps?.profiles.onChange(() => send(EVENTS.profiles, null)) ?? (() => undefined)

  return () => {
    helperFeed.dispose()
    offSettings()
    offStatus()
    offProgress()
    offData()
    offApps()
    offProfiles()
  }
}

async function checkKey(deps: IpcDeps): Promise<{ ok: boolean; message: string }> {
  const current = deps.settings.get()
  const key = deps.secrets.get('apiKey')
  if (key === null || key.trim() === '') return { ok: false, message: 'Add an API key first.' }
  return checkAccountKey(deps, { id: 'legacy', label: '', kind: 'api', provider: current.provider, baseUrl: current.baseUrl, model: current.model, hasKey: true, allowHttp: current.allowHttp }, key)
}

/** One tiny real request with an account's key and model. */
async function checkAccountKey(deps: IpcDeps, account: AiAccount, key: string): Promise<{ ok: boolean; message: string }> {
  if (key.trim() === '') return { ok: false, message: 'Add an API key first.' }
  const providerId = account.provider ?? 'anthropic'
  const info = PROVIDERS.find((provider) => provider.id === providerId)
  const model = account.model.trim() || info?.defaultModel || ''
  if (model === '') return { ok: false, message: 'Choose a model first.' }
  if (providerId === 'custom' && (account.baseUrl ?? '').trim() === '') {
    return { ok: false, message: 'Add the server address for this provider.' }
  }

  try {
    const provider = providerFor({
      provider: providerId,
      key,
      baseUrl: (account.baseUrl ?? '').trim() || undefined,
      allowHttp: account.allowHttp === true,
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

function requireIdList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 500) throw new Error(`${name} must be a list`)
  return value.map((item) => requireString(item, name, 200))
}

/** A chat id from the renderer, or undefined for the first chat. Plain ids only: they name session folders. */
function optionalChat(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const id = requireString(value, 'chat id', 64)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('chat id must be plain letters and digits')
  return id
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

/** A project's AI picks name accounts that exist (or '' for the main thread's); anything else is dropped. */
function withKnownPicks(row: Record<string, unknown>, deps: IpcDeps): Record<string, unknown> {
  if (!('ai' in row)) return row
  const picks = picksFrom(row['ai'])
  if (picks === null) {
    const { ai: _ai, ...rest } = row
    return rest
  }
  const known = new Set((deps.accounts?.all() ?? accountsOf(deps.settings.get())).map((account) => account.id))
  const clean = (pick: { account: string; model: string }): { account: string; model: string } => (known.has(pick.account) ? pick : { account: '', model: pick.model })
  // The project's helper models: known accounts only (cleanRoster already capped the list and the notes).
  const roster = (picks.roster ?? []).filter((entry) => known.has(entry.account))
  const first = roster[0]
  return { ...row, ai: { main: clean(picks.main), helpers: first !== undefined ? { account: first.account, model: first.model } : clean(picks.helpers), roster } }
}

/** A project's own picture is kept only when it is a small icon image (shared/project-icon.ts); anything else is dropped. */
function withSafeIcon(row: Record<string, unknown>): Record<string, unknown> {
  const icon = row['icon']
  if (typeof icon !== 'object' || icon === null || Array.isArray(icon)) return row
  const { image, ...rest } = icon as Record<string, unknown>
  return { ...row, icon: image !== undefined && isIconImage(image) ? { ...rest, image } : rest }
}
