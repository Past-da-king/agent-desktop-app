import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import type {
  AgentApi,
  Attachment,
  BrowserBounds,
  BrowserState,
  ChatEvent,
  Decision,
  EntityMap,
  EntityName,
  ProviderInfo,
  RowInput,
  RunState,
  Settings,
  SignInResult,
  SyncProgress,
  SyncStatus,
  Unsubscribe,
} from '@agent/core'

import { CHANNELS, EVENTS } from '../shared/channels'

const platform: AgentApi['platform'] =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>
}

function on<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: AgentApi = {
  platform,
  version: process.versions.electron ?? '0.0.0',

  settings: {
    get: () => call<Settings>(CHANNELS.settings.get),
    save: (patch) => call<Settings>(CHANNELS.settings.save, patch),
    providers: () => call<ProviderInfo[]>(CHANNELS.settings.providers),
    setApiKey: (key) => call<void>(CHANNELS.settings.setApiKey, key),
    checkKey: () => call<{ ok: boolean; message: string }>(CHANNELS.settings.checkKey),
    reset: () => call<void>(CHANNELS.settings.reset),
    onChanged: (callback) => on<Settings>(EVENTS.settings, callback),
  },

  account: {
    signIn: (args) => call<SignInResult>(CHANNELS.account.signIn, args),
    signOut: () => call<void>(CHANNELS.account.signOut),
    firstSync: () => call<SyncStatus>(CHANNELS.account.firstSync),
    syncNow: () => call<SyncStatus>(CHANNELS.account.syncNow),
    status: () => call<SyncStatus>(CHANNELS.account.status),
    onStatus: (callback) => on<SyncStatus>(EVENTS.accountStatus, callback),
    onProgress: (callback) => on<SyncProgress>(EVENTS.accountProgress, callback),
  },

  data: {
    list: <E extends EntityName>(entity: E) => call<Array<EntityMap[E]>>(CHANNELS.data.list, entity),
    upsert: <E extends EntityName>(entity: E, row: RowInput<E>) =>
      call<EntityMap[E]>(CHANNELS.data.upsert, entity, row),
    remove: (entity, id) => call<void>(CHANNELS.data.remove, entity, id),
    onChanged: (callback) => on<EntityName>(EVENTS.data, callback),
  },

  chat: {
    send: (text, attachments?: Attachment[]) => call<void>(CHANNELS.chat.send, text, attachments ?? []),
    stop: () => call<void>(CHANNELS.chat.stop),
    state: () => call<RunState>(CHANNELS.chat.state),
    answer: (itemId, answer) => call<void>(CHANNELS.chat.answer, itemId, answer),
    decide: (itemId, decision: Decision) => call<void>(CHANNELS.chat.decide, itemId, decision),
    onEvent: (callback) => on<ChatEvent>(EVENTS.chat, callback),
  },

  routines: {
    runNow: (id) => call<void>(CHANNELS.routines.runNow, id),
  },

  browser: {
    setBounds: (bounds: BrowserBounds) => call<void>(CHANNELS.browser.setBounds, bounds),
    state: () => call<BrowserState>(CHANNELS.browser.state),
    back: () => call<void>(CHANNELS.browser.back),
    reload: () => call<void>(CHANNELS.browser.reload),
    selectTab: (id) => call<void>(CHANNELS.browser.selectTab, id),
    closeTab: (id) => call<void>(CHANNELS.browser.closeTab, id),
    takeOver: () => call<void>(CHANNELS.browser.takeOver),
    giveBack: () => call<void>(CHANNELS.browser.giveBack),
    openInSystem: () => call<void>(CHANNELS.browser.openInSystem),
    onState: (callback) => on<BrowserState>(EVENTS.browser, callback),
  },

  window: {
    minimize: () => {
      void call<void>(CHANNELS.window.minimize)
    },
    toggleMaximize: () => {
      void call<void>(CHANNELS.window.toggleMaximize)
    },
    close: () => {
      void call<void>(CHANNELS.window.close)
    },
    isMaximized: () => call<boolean>(CHANNELS.window.isMaximized),
    onMaximizeChange: (callback) => on<boolean>(EVENTS.maximize, callback),
    onQuickAsk: (callback) => on<null>(EVENTS.quickAsk, () => callback()),
  },

  files: {
    pick: () => call<Attachment[]>(CHANNELS.files.pick),
    pathsFor: (files: File[]) =>
      files
        .map((file) => webUtils.getPathForFile(file))
        .filter((path) => path !== ''),
    pickFolder: () => call<string | null>(CHANNELS.files.pickFolder),
  },

  shell: {
    openExternal: (url) => call<void>(CHANNELS.shell.openExternal, url),
    reveal: (path) => call<void>(CHANNELS.shell.reveal, path),
  },
}

contextBridge.exposeInMainWorld('agent', api)
