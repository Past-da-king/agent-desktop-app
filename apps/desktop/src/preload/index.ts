import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import type {
  ModelListResult,
  AccountRules,
  AgentApi,
  AppChoice,
  AgentProfileInfo,
  AppsStatus,
  AppInfo,
  Attachment,
  CallEvent,
  CallSummary,
  DictationCommand,
  DictationView,
  BrowserBounds,
  AiAccount,
  BrowserPerson,
  ChatBrain,
  DataChange,
  BrowserState,
  ChatEvent,
  ChatRunInfo,
  Decision,
  EntityMap,
  EntityName,
  EnvironmentReport,
  HotkeyStatus,
  LearnedAppInfo,
  ProviderInfo,
  RowInput,
  RouteTarget,
  RunState,
  Settings,
  SignInResult,
  SyncProgress,
  SyncStatus,
  SystemInfo,
  Unsubscribe,
  VoiceResult,
  WorkerEvent,
  WorkerInfo,
  WorkerLogLine,
} from '@agent/core'
import type { MemoryImportPreview, MemoryImportResult, MemoryTidyPlan, MemoryTidyProgress, MemoryVersion, PastChatHit, UpkeepReport, UpkeepSummary } from '@agent/core'

import { CHANNELS, EVENTS } from '../shared/channels'
import { MEMORY_CHANNELS, MEMORY_EVENTS } from '../shared/memory-channels'
import { MEMORY_HISTORY_CHANNELS } from '../shared/memory-history-channels'
import { WORKER_CHANNELS, WORKER_EVENTS } from '../shared/workers-channels'

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
    listModels: () => call<ModelListResult>(CHANNELS.settings.listModels),
    checkCli: () => call<{ ok: boolean; message: string }>(CHANNELS.settings.checkCli),
    cliLogin: () => call<{ ok: boolean; message: string }>(CHANNELS.settings.cliLogin),
    reset: () => call<void>(CHANNELS.settings.reset),
    accounts: {
      add: (draft) => call<AiAccount>(CHANNELS.settings.accounts.add, draft),
      update: (id, patch) => call<AiAccount>(CHANNELS.settings.accounts.update, id, patch),
      remove: (id) => call<void>(CHANNELS.settings.accounts.remove, id),
      setKey: (id, key) => call<void>(CHANNELS.settings.accounts.setKey, id, key),
      check: (id) => call<{ ok: boolean; message: string }>(CHANNELS.settings.accounts.check, id),
      listModels: (id) => call<ModelListResult>(CHANNELS.settings.accounts.listModels, id),
      signIn: (id) => call<{ ok: boolean; message: string }>(CHANNELS.settings.accounts.signIn, id),
      chatBrain: (chat) => call<ChatBrain>(CHANNELS.settings.accounts.chatBrain, chat),
    },
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
    get: <E extends EntityName>(entity: E, id: string) => call<EntityMap[E] | null>(CHANNELS.data.get, entity, id),
    upsert: <E extends EntityName>(entity: E, row: RowInput<E>) =>
      call<EntityMap[E]>(CHANNELS.data.upsert, entity, row),
    remove: (entity, id) => call<void>(CHANNELS.data.remove, entity, id),
    onChanged: (callback) => on<DataChange>(EVENTS.data, callback),
  },

  chat: {
    send: (text, attachments?: Attachment[], chat?: string) =>
      call<void>(CHANNELS.chat.send, text, attachments ?? [], chat ?? ''),
    stop: (chat?: string) => call<void>(CHANNELS.chat.stop, chat ?? ''),
    state: (chat?: string) => call<RunState>(CHANNELS.chat.state, chat ?? ''),
    states: () => call<ChatRunInfo[]>(CHANNELS.chat.states),
    branch: (itemId: string) => call<string>(CHANNELS.chat.branch, itemId),
    answer: (itemId, answer) => call<void>(CHANNELS.chat.answer, itemId, answer),
    decide: (itemId, decision: Decision) => call<void>(CHANNELS.chat.decide, itemId, decision),
    tap: (itemId, label, message) => call<void>(CHANNELS.chat.tap, itemId, label, message),
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
    setView: (mode) => call<void>(CHANNELS.browser.setView, mode),
    setExpanded: (on) => call<void>(CHANNELS.browser.setExpanded, on),
    frame: () => call<string | null>(CHANNELS.browser.frame),
    go: (address) => call<void>(CHANNELS.browser.go, address),
    newTab: () => call<void>(CHANNELS.browser.newTab),
    devtools: () => call<void>(CHANNELS.browser.devtools),
    setMuted: (on: boolean) => call<void>(CHANNELS.browser.setMuted, on),
    people: () => call<BrowserPerson[]>(CHANNELS.browser.people),
    usePerson: (id: string) => call<void>(CHANNELS.browser.usePerson, id),
    signOut: (id: string) => call<void>(CHANNELS.browser.signOut, id),
    onState: (callback) => on<BrowserState>(EVENTS.browser, callback),
    attach: (tabId, guestId) => call<boolean>(CHANNELS.browser.attach, tabId, guestId),
  },

  helpers: {
    stop: (id) => call<boolean>(CHANNELS.helpers.stop, id),
    stopAll: () => call<number>(CHANNELS.helpers.stopAll),
  },

  apps: {
    status: () => call<AppsStatus>(CHANNELS.apps.status),
    setKey: (key: string) => call<{ ok: boolean; message: string }>(CHANNELS.apps.setKey, key),
    catalog: () => call<AppChoice[]>(CHANNELS.apps.catalog),
    search: (query) => call<AppChoice[]>(CHANNELS.apps.search, query),
    connect: (app: string) => call<{ ok: boolean; message: string }>(CHANNELS.apps.connect, app),
    disconnect: (accountId: string) => call<void>(CHANNELS.apps.disconnect, accountId),
    setRules: (accountId: string, rules: AccountRules) => call<void>(CHANNELS.apps.setRules, accountId, rules),
    learned: () => call<LearnedAppInfo[]>(CHANNELS.apps.learned),
    removeLearned: (id: string) => call<void>(CHANNELS.apps.removeLearned, id),
    setTrusted: (id: string, trusted: boolean) => call<void>(CHANNELS.apps.setTrusted, id, trusted),
    onChanged: (callback) => on<null>(EVENTS.apps, () => callback()),
  },

  profiles: {
    list: () => call<AgentProfileInfo[]>(CHANNELS.profiles.list),
    create: (draft) => call<{ ok: boolean; message: string; profile?: AgentProfileInfo }>(CHANNELS.profiles.create, draft),
    update: (id, patch) => call<{ ok: boolean; message: string }>(CHANNELS.profiles.update, id, patch),
    remove: (id) => call<void>(CHANNELS.profiles.remove, id),
    setMember: (profileId, accountId, member) => call<void>(CHANNELS.profiles.setMember, profileId, accountId, member),
    onChanged: (callback) => on<null>(EVENTS.profiles, () => callback()),
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
    onRoute: (callback) => on<RouteTarget>(EVENTS.route, callback),
    onHotkeyStatus: (callback) => on<HotkeyStatus>(EVENTS.hotkey, callback),
  },

  files: {
    pick: () => call<Attachment[]>(CHANNELS.files.pick),
    pathsFor: (files: File[]) => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter((path) => path !== '')
      if (paths.length > 0) void call<void>(CHANNELS.files.register, paths)
      return paths
    },
    pickFolder: () => call<string | null>(CHANNELS.files.pickFolder),
    thumbnail: (path: string) => call<string | null>(CHANNELS.files.thumbnail, path),
    savePasted: (name: string, mime: string, bytes: Uint8Array) =>
      call<Attachment>(CHANNELS.files.savePasted, name, mime, bytes),
    clipboardFiles: () => call<Attachment[]>(CHANNELS.files.clipboardFiles),
  },

  system: {
    info: () => call<SystemInfo>(CHANNELS.system.info),
  },

  environment: {
    scan: (refresh?: boolean) => call<EnvironmentReport>(CHANNELS.environment.scan, refresh === true),
  },

  shell: {
    openExternal: (url) => call<void>(CHANNELS.shell.openExternal, url),
    reveal: (path) => call<void>(CHANNELS.shell.reveal, path),
  },

  voice: {
    setKey: (key) => call<void>(CHANNELS.voice.setKey, key),
    check: () => call<{ ok: boolean; message: string }>(CHANNELS.voice.check),
    transcribe: (pcm) => call<VoiceResult<{ text: string }>>(CHANNELS.voice.transcribe, pcm),
    speak: (text) => call<VoiceResult<{ data: string }>>(CHANNELS.voice.speak, text),
    noteAudio: (file) => call<Uint8Array | null>(CHANNELS.voice.noteAudio, file),
    callStart: () => call<{ ok: boolean; message: string }>(CHANNELS.voice.callStart),
    callAudio: (pcm) => {
      ipcRenderer.send(CHANNELS.voice.callAudio, pcm)
    },
    callMute: (muted) => call<void>(CHANNELS.voice.callMute, muted),
    callEnd: () => call<CallSummary | null>(CHANNELS.voice.callEnd),
    onCall: (callback) => on<CallEvent>(EVENTS.voiceCall, callback),
  },

  hotkeys: {
    status: () => call<HotkeyStatus[]>(CHANNELS.hotkeys.status),
    pause: (paused) => call<void>(CHANNELS.hotkeys.pause, paused),
  },

  dictation: {
    audio: (session, pcm) => {
      ipcRenderer.send(CHANNELS.dictation.audio, session, pcm)
    },
    micState: (session, ok, message) => call<void>(CHANNELS.dictation.micState, session, ok, message),
    stop: () => call<void>(CHANNELS.dictation.stop),
    ready: () => call<void>(CHANNELS.dictation.ready),
    onCommand: (callback) => on<DictationCommand>(EVENTS.dictationCommand, callback),
    onView: (callback) => on<DictationView>(EVENTS.dictationView, callback),
  },

  app: {
    info: () => call<AppInfo>(CHANNELS.app.info),
    openLogsFolder: () => call<void>(CHANNELS.app.openLogsFolder),
    openLicences: () => call<void>(CHANNELS.app.openLicences),
  },

  memory: {
    newChat: (target?: { chat: string; from: string }) =>
      call<{ dividerId: string | null; saving: boolean }>(MEMORY_CHANNELS.newChat, target ?? null),
    retrySave: (id) => call<void>(MEMORY_CHANNELS.retrySave, id),
    pickImport: () => call<{ path: string; name: string } | null>(MEMORY_CHANNELS.pickImport),
    previewImport: (path, includeAll) => call<MemoryImportPreview>(MEMORY_CHANNELS.previewImport, path, includeAll),
    runImport: (path, includeAll) => call<MemoryImportResult>(MEMORY_CHANNELS.runImport, path, includeAll),
    searchChats: (query, limit) => call<PastChatHit[]>(MEMORY_CHANNELS.searchChats, query, limit),
    runDaily: () => call<UpkeepReport>(MEMORY_CHANNELS.runDaily),
    upkeep: () => call<UpkeepSummary>(MEMORY_CHANNELS.upkeep),
    undoChange: (id) => call<boolean>(MEMORY_CHANNELS.undoChange, id),
    history: (memoryId) => call<MemoryVersion[]>(MEMORY_HISTORY_CHANNELS.history, memoryId),
    restoreVersion: (memoryId, n) => call<boolean>(MEMORY_HISTORY_CHANNELS.restoreVersion, memoryId, n),
    onUpkeep: (callback) => on<UpkeepReport | null>(MEMORY_EVENTS.upkeep, callback),
    previewTidy: (path, includeAll) => call<MemoryTidyPlan>(MEMORY_CHANNELS.previewTidy, path, includeAll),
    startTidy: (path, includeAll) => call<MemoryTidyProgress>(MEMORY_CHANNELS.startTidy, path, includeAll),
    stopTidy: () => call<MemoryTidyProgress>(MEMORY_CHANNELS.stopTidy),
    tidyState: () => call<MemoryTidyProgress | null>(MEMORY_CHANNELS.tidyState),
    undoTidy: () => call<{ removed: number; restored: number }>(MEMORY_CHANNELS.undoTidy),
    onTidy: (callback) => on<MemoryTidyProgress>(MEMORY_EVENTS.tidy, callback),
  },

  workers: {
    list: () => call<WorkerInfo[]>(WORKER_CHANNELS.list),
    events: (worker, limit) => call<WorkerEvent[]>(WORKER_CHANNELS.events, worker ?? '', limit ?? 100),
    logs: (id, limit) => call<WorkerLogLine[]>(WORKER_CHANNELS.logs, id, limit ?? 200),
    start: (id) => call<void>(WORKER_CHANNELS.start, id),
    stop: (id) => call<void>(WORKER_CHANNELS.stop, id),
    restart: (id) => call<void>(WORKER_CHANNELS.restart, id),
    remove: (id) => call<void>(WORKER_CHANNELS.remove, id),
    setSecret: (id, name, value) => call<void>(WORKER_CHANNELS.setSecret, id, name, value),
    openFolder: (id) => call<void>(WORKER_CHANNELS.openFolder, id),
    onChange: (callback) => on<null>(WORKER_EVENTS.changed, () => callback()),
  },
}

contextBridge.exposeInMainWorld('agent', api)
