/**
 * THE CONTRACT between the main process, the preload script and the renderer.
 *
 * Types plus one plain constant (DEFAULT_SETTINGS): this file must never import anything, so the renderer can import it freely.
 * The renderer sees exactly one global, `window.agent`, which implements `AgentApi`. In Electron it is built by the
 * preload script over `ipcRenderer.invoke`. In a plain browser (dev and screenshots) it is the in-memory mock in
 * `apps/desktop/src/renderer/bridge/mock.ts`. Both implement this same interface, so the UI cannot tell them apart.
 *
 * Extending it: a milestone that adds a feature may ADD members here (never rename or remove one), and must update
 * the mock bridge and the preload in the same commit.
 */

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

export type PowerMode = 'none' | 'api_key' | 'subscription'
export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'opencode_go' | 'opencode_zen' | 'openrouter' | 'custom'
export type ThemePref = 'system' | 'light' | 'dark'
export type MascotId = 'scout' | 'ghost' | 'clover' | 'bloom' | 'puff' | 'gem' | 'pebble' | 'heart' | 'bun'

/** Everything non-secret. The API key and the sync token never appear here (only `hasKey` / `signedIn`). */
export interface Settings {
  mode: PowerMode
  /** With mode 'subscription': the installed AI tool that does the thinking on the person's own plan. */
  cli: 'claude' | 'codex' | ''
  provider: ProviderId
  model: string
  hasKey: boolean
  baseUrl: string
  allowHttp: boolean
  userName: string
  agentName: string
  accent: string
  mascot: MascotId
  theme: ThemePref
  onboarded: boolean
  /** Sync account. `syncUrl` is empty until the user (or the build) provides one: nothing is hardcoded. */
  syncUrl: string
  syncEmail: string | null
  signedIn: boolean
  deviceName: string
  quickAskHotkey: string
  launchAtLogin: boolean
  closeToTray: boolean
  notifications: boolean
  /** Folders the agent may read and write without asking each time. Empty means ask for everything. */
  grantedFolders: string[]
  /** Shell commands: always ask first, or never run. There is no "always allow". */
  shell: 'ask' | 'never'
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'none',
  cli: '',
  provider: 'anthropic',
  model: '',
  hasKey: false,
  baseUrl: '',
  allowHttp: false,
  userName: '',
  agentName: 'Your agent',
  accent: 'iris',
  mascot: 'scout',
  theme: 'system',
  onboarded: false,
  syncUrl: '',
  syncEmail: null,
  signedIn: false,
  deviceName: '',
  quickAskHotkey: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  closeToTray: true,
  notifications: true,
  grantedFolders: [],
  shell: 'ask',
}

export interface ProviderInfo {
  id: ProviderId
  label: string
  defaultModel: string
  baseUrl: string
  keyHint: string
}

// ---------------------------------------------------------------------------------------------------------------
// Synced rows. Every row has a stable string id (a UUID, "cid") so any device can create rows offline.
// The sync payload is the row minus `id`. Field names are the phone app's Room column names, camelCase.
// ---------------------------------------------------------------------------------------------------------------

export type EntityName = 'chat_item' | 'turn' | 'memory' | 'goal' | 'task' | 'trigger'

export interface RowBase {
  id: string
  createdAt: number
}

/** kind: user | agent | activity | helper | question | approval | notice | report | branch. `meta` is JSON text. */
export interface ChatItem extends RowBase {
  kind: string
  text: string
  meta: string
}

/** One provider-neutral model message (JSON of `Msg`), the model's own transcript. `thread` is "main" or a helper id. */
export interface TurnRow extends RowBase {
  thread: string
  json: string
}

export type MemoryKind = 'fact' | 'preference' | 'person' | 'decision' | 'how-to' | 'event' | 'skill'

export interface MemoryRow extends RowBase {
  title: string
  body: string
  kind: MemoryKind
  topics: string
  pinned: boolean
  source: 'agent' | 'user'
  updatedAt: number
}

export interface GoalRow extends RowBase {
  title: string
  why: string
  status: 'open' | 'achieved' | 'dropped'
}

export interface TaskRow extends RowBase {
  goalId: string | null
  title: string
  notes: string
  status: 'todo' | 'doing' | 'done' | 'blocked'
  dueAt: number | null
  /** user = on the person's own to-do list; agent = the agent's own working steps. */
  owner: 'user' | 'agent'
  blocker: string
  updatedAt: number
}

/** A routine. kind: at (spec = ISO time) | daily (spec = "HH:mm") | interval (spec = minutes). */
export interface TriggerRow extends RowBase {
  name: string
  kind: 'at' | 'daily' | 'interval'
  spec: string
  prompt: string
  enabled: boolean
  lastRunAt: number | null
  lastResult: string
}

export interface EntityMap {
  chat_item: ChatItem
  turn: TurnRow
  memory: MemoryRow
  goal: GoalRow
  task: TaskRow
  trigger: TriggerRow
}

/** What a caller supplies to create or update: everything except what the store fills in. `id` present = update. */
export type RowInput<E extends EntityName> = Partial<EntityMap[E]> & (E extends 'chat_item' ? { kind: string; text: string } : unknown)

// ---------------------------------------------------------------------------------------------------------------
// Account and sync
// ---------------------------------------------------------------------------------------------------------------

export interface SyncStatus {
  signedIn: boolean
  syncing: boolean
  lastSyncedAt: number | null
  error: string | null
  pendingPush: number
}

export type SignInResult = { ok: true } | { ok: false; error: string }

/** What the "Bringing your agent over" step shows, per kind of data, as the first pull applies. */
export interface SyncProgress {
  phase: 'connecting' | 'pulling' | 'done' | 'error'
  counts: Partial<Record<EntityName, number>>
  message?: string
}

// ---------------------------------------------------------------------------------------------------------------
// Chat and the running agent
// ---------------------------------------------------------------------------------------------------------------

export interface Attachment {
  /** Absolute path on this computer. */
  path: string
  name: string
  mime: string
  /** Bytes, when the caller knows them. The 20 MB rule uses it. */
  size?: number
}

/** What the main process pushes while the agent works. The renderer re-reads `data.list('chat_item')` on `chat_changed`. */
export type ChatEvent =
  | { type: 'run_started' }
  | { type: 'thinking'; step: number }
  | { type: 'chat_changed' }
  | { type: 'run_finished'; error?: string }
  | { type: 'needs_you'; itemId: string }

export interface RunState {
  running: boolean
  /** Ids of question or approval cards that are waiting for the person. */
  waiting: string[]
}

export type Decision = 'approve' | 'decline'

/** Where a notification click should take the person. */
export interface RouteTarget {
  view: 'home' | 'chat' | 'tasks' | 'memory' | 'routines'
  /** The row to show, when there is one. */
  id: string
}

/** Whether the Quick Ask shortcut is live. A failure is explained in Settings. */
export interface HotkeyStatus {
  accelerator: string
  ok: boolean
  message: string
}

/** What the app knows about this machine. `platform` is 'web' in the browser mock. */
export interface SystemInfo {
  platform: string
  arch: string
  hostname: string
  appVersion: string
}

// ---------------------------------------------------------------------------------------------------------------
// The environment scan: what is already on this computer. Read-only; nothing is installed or changed.
// ---------------------------------------------------------------------------------------------------------------

export type CommandKind = 'exe' | 'cmd' | 'ps1' | 'script'

/** One thing the scan looked for. `found: false` means it is not on this computer. */
export interface Found {
  id: string
  label: string
  found: boolean
  /** Absolute path, when it was found. Never shown in the system prompt. */
  path?: string
  version?: string
  kind?: CommandKind
}

export interface EnvironmentOs {
  platform: string
  release: string
  arch: string
  hostname: string
}

export interface EnvironmentReport {
  os: EnvironmentOs
  shells: Found[]
  runtimes: Found[]
  aiTools: Found[]
  notes: string[]
  /** Epoch milliseconds. */
  scannedAt: number
}

// ---------------------------------------------------------------------------------------------------------------
// The agent's browser
// ---------------------------------------------------------------------------------------------------------------

/** Where the renderer wants the live browser view, in window (CSS) pixels. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  active: boolean
}

/** What the panel shows. `agentActive` is false while the person has control. */
export interface BrowserState {
  url: string
  title: string
  tabs: BrowserTab[]
  visible: boolean
  agentActive: boolean
  /** True while the agent is waiting for the person to finish something on a page. */
  needsUser: boolean
  handoffReason: string
}

export type HelperState = 'working' | 'done' | 'failed' | 'stopped'

/** The helper controls the chat and Home need. A helper's live details ride on its `chat_item` row. */
export interface HelpersApi {
  /** Stops one working helper. False when it was not running. */
  stop(id: string): Promise<boolean>
  /** Stops every working helper and returns how many were asked to stop. */
  stopAll(): Promise<number>
}

// ---------------------------------------------------------------------------------------------------------------
// The api
// ---------------------------------------------------------------------------------------------------------------

export type Unsubscribe = () => void

/** 'web' means the mock bridge in a plain browser. */
export type AppPlatform = 'win32' | 'darwin' | 'linux' | 'web'

/** What the About dialog shows. The logs path is resolved by the main process, never guessed here. */
export interface AppInfo {
  name: string
  version: string
  platform: AppPlatform
  electron: string
  logsPath: string
  licencesUrl: string
}

export interface AgentApi {
  platform: AppPlatform
  version: string

  settings: {
    get(): Promise<Settings>
    save(patch: Partial<Settings>): Promise<Settings>
    providers(): Promise<ProviderInfo[]>
    /** Stores the key in the secrets module only. Pass '' to clear. */
    setApiKey(key: string): Promise<void>
    /** Makes one tiny real completion call with the stored key and chosen model. */
    checkKey(): Promise<{ ok: boolean; message: string }>
    /** Makes one tiny real turn through the installed AI tool (Claude Code) on the person's own plan. */
    checkCli(): Promise<{ ok: boolean; message: string }>
    /** Wipes local data and settings (not the account on the server). Used by "Start again". */
    reset(): Promise<void>
    onChanged(cb: (s: Settings) => void): Unsubscribe
  }

  account: {
    signIn(args: { serverUrl: string; email: string; password: string; mode: 'login' | 'register' }): Promise<SignInResult>
    signOut(): Promise<void>
    /** Pull everything now (used by the sync onboarding step). Resolves when the first pass is done. */
    firstSync(): Promise<SyncStatus>
    syncNow(): Promise<SyncStatus>
    status(): Promise<SyncStatus>
    onStatus(cb: (s: SyncStatus) => void): Unsubscribe
    onProgress(cb: (p: SyncProgress) => void): Unsubscribe
  }

  data: {
    list<E extends EntityName>(entity: E): Promise<Array<EntityMap[E]>>
    upsert<E extends EntityName>(entity: E, row: RowInput<E>): Promise<EntityMap[E]>
    remove(entity: EntityName, id: string): Promise<void>
    /** Fires after any local or remote change. The renderer reloads the lists it shows. */
    onChanged(cb: (entity: EntityName) => void): Unsubscribe
  }

  chat: {
    send(text: string, attachments?: Attachment[]): Promise<void>
    stop(): Promise<void>
    state(): Promise<RunState>
    /** Answer a `question` card. */
    answer(itemId: string, answer: string): Promise<void>
    /** Approve or decline an `approval` card. */
    decide(itemId: string, decision: Decision): Promise<void>
    onEvent(cb: (e: ChatEvent) => void): Unsubscribe
  }

  routines: {
    runNow(id: string): Promise<void>
  }

  browser: {
    /** The rectangle of the chat panel, or visible: false when the panel is closed. */
    setBounds(bounds: BrowserBounds): Promise<void>
    state(): Promise<BrowserState>
    back(): Promise<void>
    reload(): Promise<void>
    selectTab(id: string): Promise<void>
    closeTab(id: string): Promise<void>
    /** The person takes the page over: their mouse and keyboard work again. */
    takeOver(): Promise<void>
    /** The person hands the page back to the agent. */
    giveBack(): Promise<void>
    /** Opens the current page in the person's own browser. */
    openInSystem(): Promise<void>
    onState(cb: (state: BrowserState) => void): Unsubscribe
  }
  helpers: HelpersApi

  window: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizeChange(cb: (maximized: boolean) => void): Unsubscribe
    /** Quick Ask overlay: the main process shows/hides it; the renderer listens. */
    onQuickAsk(cb: () => void): Unsubscribe
    /** A notification was clicked: open this view and this row. */
    onRoute(cb: (target: RouteTarget) => void): Unsubscribe
    /** The global shortcut was registered, or could not be. Settings shows the message. */
    onHotkeyStatus(cb: (status: HotkeyStatus) => void): Unsubscribe
  }

  files: {
    /** Opens the OS file picker. Returns attachments. */
    pick(): Promise<Attachment[]>
    /** Resolve dropped File objects (from a drag-drop event) to absolute paths. */
    pathsFor(files: File[]): string[]
    pickFolder(): Promise<string | null>
    /** A small data URL for an image attachment, or null when no preview is available. */
    thumbnail(path: string): Promise<string | null>
  }

  /** About the computer the app is running on. */
  system: {
    info(): Promise<SystemInfo>
  }

  /** Looks at what is already installed here (shells, runtimes, AI tools). It never installs anything. */
  environment: {
    scan(refresh?: boolean): Promise<EnvironmentReport>
  }

  shell: {
    openExternal(url: string): Promise<void>
    /** Reveal a path in the OS file manager. */
    reveal(path: string): Promise<void>
  }

  /** Identity and housekeeping for the About dialog. */
  app: {
    info(): Promise<AppInfo>
    openLogsFolder(): Promise<void>
    openLicences(): Promise<void>
  }
}

declare global {
  interface Window {
    agent: AgentApi
  }
}
