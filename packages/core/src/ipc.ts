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

/** How an AI account is reached: the person's Claude plan, their ChatGPT plan through Codex, or an API key. */
export type AiAccountKind = 'claude' | 'codex' | 'api'

/**
 * One way the agent can think: a plan the person already pays for, or a provider with their API key. The main
 * agent uses one; each project may use another. The key itself lives in the secrets module (`apiKey-<id>`).
 */
export interface AiAccount {
  id: string
  /** What the person calls it: "Claude plan", "OpenCode Go", "Work OpenAI". */
  label: string
  kind: AiAccountKind
  /** With kind 'api': which provider. */
  provider?: ProviderId
  /** With provider 'custom': the server address. */
  baseUrl?: string
  /** The model to use; '' on a plan means what the plan picks. */
  model: string
  /** With kind 'api': a key is stored for it. */
  hasKey: boolean
  allowHttp?: boolean
}

/** The id of the account the old single-choice settings were turned into. */
export const LEGACY_ACCOUNT = 'default'

/** One choice of what thinks: an account, and a model on it ('' = the account's own default model). */
export interface AiPick {
  account: string
  model: string
}

/** Two picks: one for the agent that talks in the chat, one for the helpers it starts. */
export interface AiPicks {
  main: AiPick
  /** '' account = the same as `main`. */
  helpers: AiPick
}

export const NO_PICK: AiPick = { account: '', model: '' }

/** Everything non-secret. The API key and the sync token never appear here (only `hasKey` / `signedIn`). */
export interface Settings {
  /** Kept for older code and onboarding; mirrors the main account (see `accounts`). */
  mode: PowerMode
  /** With mode 'subscription': the installed AI tool that does the thinking on the person's own plan. */
  cli: 'claude' | 'codex' | ''
  /** The model on the person's plan ('' = the plan's default; Claude takes opus, sonnet, haiku, fable). */
  cliModel: string
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
  /** Dictation anywhere: press to start, press again to stop; the words are typed where the cursor is. */
  dictateHotkey: string
  /** The same, then the words are cleaned up (fillers, false starts, punctuation) before they are typed. */
  dictateCleanHotkey: string
  launchAtLogin: boolean
  closeToTray: boolean
  notifications: boolean
  /** Folders the agent may read and write without asking each time. Empty means ask for everything. */
  grantedFolders: string[]
  /**
   * Acting on this computer: 'always' runs commands and code and opens files anywhere without asking;
   * 'ask' asks before every command and before any file outside the granted folders; 'never' runs no commands.
   */
  shell: 'always' | 'ask' | 'never'
  /** Voice: true once a Gemini key is in the secrets module. The key itself never appears here. */
  hasVoiceKey: boolean
  /** The Gemini prebuilt voice the call and read-aloud use (see VOICES). */
  voiceName: string
  /** Speak each finished agent reply aloud with Gemini TTS. */
  speakReplies: boolean
  /** When the end-of-day memory pass runs, "HH:mm" local time; '' turns it off. */
  dailyMemoryAt: string
  /** Every AI account the person set up. Empty on an install that only ever used the old single choice. */
  accounts: AiAccount[]
  /** What the main thread thinks with: its agent, and its helpers. Routines and the memory pass use `main`. */
  ai: AiPicks
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'none',
  cli: '',
  cliModel: '',
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
  quickAskHotkey: 'CommandOrControl+Alt+Left',
  dictateHotkey: 'Alt+Space',
  dictateCleanHotkey: 'CommandOrControl+Alt+C',
  launchAtLogin: false,
  closeToTray: true,
  notifications: true,
  grantedFolders: [],
  shell: 'ask',
  hasVoiceKey: false,
  voiceName: 'Kore',
  speakReplies: false,
  dailyMemoryAt: '23:30',
  accounts: [],
  ai: { main: { account: '', model: '' }, helpers: { account: '', model: '' } },
}

export interface ModelOption {
  id: string
  /** What to show; the id when the provider gives no name. */
  label: string
  line: string
}

export interface ModelListResult {
  ok: boolean
  models: ModelOption[]
  message: string
}

/** A new or changed account, from the window. */
export interface AiAccountDraft {
  label?: string
  kind?: AiAccountKind
  provider?: ProviderId
  baseUrl?: string
  model?: string
  allowHttp?: boolean
}

/** One slot of a chat as it runs: what it is set to, and what it actually runs on. */
export interface ChatBrainSlot {
  /** The pick the chat's project (or the main thread) is set to, resolved to an account id and model. */
  wanted: AiPick
  /** What the chat runs on until its next new chat (the same, unless a switch of family is waiting). */
  using: AiPick
  /** True when `wanted` only takes effect on the chat's next new chat. */
  deferred: boolean
}

/** What a chat thinks with right now, for the picker in its header. */
export interface ChatBrain {
  main: ChatBrainSlot
  helpers: ChatBrainSlot
}

export interface AccountsApi {
  add(draft: AiAccountDraft): Promise<AiAccount>
  update(id: string, patch: AiAccountDraft): Promise<AiAccount>
  remove(id: string): Promise<void>
  /** Stores the key for one account in the secrets module only. '' clears it. */
  setKey(id: string, key: string): Promise<void>
  /** One tiny real request on that account. */
  check(id: string): Promise<{ ok: boolean; message: string }>
  /** The models that account can use, asked live. */
  listModels(id: string): Promise<ModelListResult>
  /** Runs the plan's own sign-in for a plan account. */
  signIn(id: string): Promise<{ ok: boolean; message: string }>
  /** What a chat is thinking with (MAIN_CHAT or a project chat id). */
  chatBrain(chat: string): Promise<ChatBrain>
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

export type EntityName = 'chat_item' | 'turn' | 'memory' | 'goal' | 'task' | 'trigger' | 'project'

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
  /** The New chat divider time the run that wrote it started under (0 = before any divider). Older rows have none. */
  epoch?: number
}

export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'person'
  | 'decision'
  | 'how-to'
  | 'event'
  | 'skill'
  // Added for long-term memory (New Chat filing and the bank import).
  | 'organisation'
  | 'project'

export interface MemoryRow extends RowBase {
  title: string
  body: string
  kind: MemoryKind
  topics: string
  pinned: boolean
  source: 'agent' | 'user'
  updatedAt: number
  /** 'closed' = done and ticked off: kept and searchable, left out of what the agent is reminded of. Open when absent. */
  status?: MemoryStatus
  /** When it was closed (ms), or null. */
  closedAt?: number | null
  /** Other names or spellings it answers to, comma separated (a dictation that mis-hears "Initech" as "Londercorp"). */
  aliases?: string
  /** The project this memory belongs to (a ProjectRow id); absent for the person's general memory. */
  project?: string
}

export type MemoryStatus = 'open' | 'closed'

/**
 * One version of a memory page, kept every time the page changes: what it said after that change, who changed it,
 * why, and which fields changed. Numbered from 1 per page; the highest number is the page as it is now.
 */
export interface MemoryVersion {
  memoryId: string
  n: number
  at: number
  /** Who: "you", "agent", "helper <label>", "chat filing", "end of day", "import", "another device", "app". */
  by: string
  /** Why, when the writer said (empty otherwise). */
  reason: string
  /** Fields that changed from the version before: title, body, kind, topics, status, aliases, pinned; "created" or "deleted". */
  changed: string[]
  deleted: boolean
  title: string
  body: string
  kind: MemoryKind
  topics: string
  status: MemoryStatus
  aliases: string
  pinned: boolean
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
  /** Set on a routine the app itself runs (not a prompt for the agent): only its time and on/off can change. */
  builtin?: string
}

/** A project's icon, like an app icon: a glyph from the app's icon set or an emoji, on a coloured rounded tile. */
export interface ProjectIcon {
  /** An Icon name (renderer/ui/Icon.tsx) or one emoji. */
  glyph: string
  color: ProfileColor
  /** The project's own picture instead of the glyph: a small square data URL (shared/project-icon.ts). */
  image?: string
}

/**
 * A project: its own chats (each its own context, ids starting with "pc"), its own memories (MemoryRow.project), a
 * folder its agents work in, and the profile whose accounts and sign-ins its helpers use. One main agent runs every
 * chat; in a project chat it is told which project it is in.
 */
export interface ProjectRow extends RowBase {
  name: string
  description: string
  icon: ProjectIcon
  /** A folder on this computer the project's agents work in by default; '' for none. */
  path: string
  /** A profile id (apps/profiles.ts) whose accounts and sign-ins its helpers use; '' for General. */
  profile: string
  /** Kept, off the rail; still found by search and the Hidden projects list. */
  hidden: boolean
  /** Its chat ids, oldest first. */
  chats: string[]
  /** What its chats think with: the agent in each chat, and the helpers it starts. '' = the main thread's choice. */
  ai?: AiPicks
}

/** Where old chats from the days of several chats at once live, so nothing is lost. */
export const EARLIER_CHATS_PROJECT = 'earlier-chats'

/** The built-in End of day routine: the memory pass that writes "Where we are" and tidies memory. */
export const MEMORY_DAILY_ROUTINE = 'memory-daily'

export interface EntityMap {
  chat_item: ChatItem
  turn: TurnRow
  memory: MemoryRow
  goal: GoalRow
  task: TaskRow
  trigger: TriggerRow
  project: ProjectRow
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
  | { type: 'run_started'; chat?: string }
  | { type: 'thinking'; step: number; chat?: string }
  | { type: 'chat_changed'; chat?: string }
  | { type: 'run_finished'; error?: string; chat?: string }
  | { type: 'needs_you'; itemId: string; chat?: string }

/**
 * Several chats at once. Every chat row carries `meta.chat`, the id of the chat it belongs to; a row without one
 * belongs to the first chat, MAIN_CHAT. Events name their chat in `chat` (absent means MAIN_CHAT).
 */
export const MAIN_CHAT = 'main'

/** One chat's run as the rail and the chat header need it. */
export interface ChatRunInfo {
  chat: string
  running: boolean
  /** Card ids in this chat that wait for the person. */
  waiting: string[]
  /** Separate runs started from this chat (a different job sent while it was busy) that are still working. */
  alongside: number
}

/** Which way a message sent while the agent was busy went. */
export type BusyRoute = 'join' | 'alongside'

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
  /** Which shortcut this is about. Absent on older builds, where it was always Quick Ask. */
  action?: HotkeyAction
}

/** The app's global shortcuts. */
export type HotkeyAction = 'quickAsk' | 'dictate' | 'dictateClean'

/** Where a dictation is, for the small pill near the bottom of the screen. */
export type DictationPhase = 'starting' | 'listening' | 'finishing' | 'cleaning' | 'done' | 'notice' | 'error' | 'hidden'

export interface DictationView {
  phase: DictationPhase
  /** Clean-up mode: the words are tidied before they are typed. */
  clean: boolean
  /** The words so far: settled text, then the part still being heard. */
  text: string
  interim: string
  /** A plain line for done, notice and error ("Typed", "Add a Gemini key in Settings"). */
  message: string
  /** The shortcut that switches to clean-up while listening, as the person presses it ("Alt+C"), or ''. */
  switchKeys: string
}

/** What the main process asks of the pill window's microphone. */
export type DictationCommand = { type: 'start'; session: number } | { type: 'stop'; session: number }

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
  /** The tab's session partition: the renderer's <webview> for it must use exactly this one. */
  partition?: string
  /** True when the renderer hosts this tab's page in a <webview> inside its card. */
  embed?: boolean
  /** How this tab's page is laid out (each tab keeps the view it was opened with). */
  view?: BrowserPageSpec
}

/** The size and kind of page a tab lays out, for placing its <webview> (shared/page-place.ts). */
export interface BrowserPageSpec {
  mode: BrowserViewMode
  width: number
  height: number
  zoom?: number
  fixed?: boolean
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
  /** How the page is presented: the device it emulates and the size it is laid out at. */
  view?: BrowserViewInfo
  /** The page fills the app window so the person can work in it comfortably. */
  expanded?: boolean
  /** Every tab's sound is off. Remembered across restarts. */
  muted?: boolean
  /** The partition of the browser profile the person's own tabs open in. */
  personPartition?: string
  /** A tab is playing sound right now (heard or not). */
  audible?: boolean
}

/**
 * One browser profile, as in Chrome: a set of sign-ins of its own. The person's own (Mine) is never used by an
 * agent unless a profile borrows it; the agents share General; a profile may have its own.
 */
export interface BrowserPerson {
  /** 'mine', 'general' or a profile id. */
  id: string
  name: string
  color: ProfileColor
  kind: 'mine' | 'shared' | 'profile'
  /** The session partition; a tab with the same partition belongs to this profile. */
  partition: string
  /** Google accounts signed in here, e.g. "ap@example.com". */
  google: string[]
  /** The tabs the person opens go here. */
  current: boolean
  /** Who browses with these sign-ins: profile names, or the main agent and routines. */
  usedBy: string[]
}

export type BrowserViewMode = 'desktop' | 'tablet' | 'phone' | 'fit'

export interface BrowserViewInfo {
  mode: BrowserViewMode
  /** "Desktop 1440x900", "Phone 390x844", "Fits the panel". */
  label: string
  /** CSS pixels the page lays out at; 0 for `fit`. */
  width: number
  height: number
  /** How far the page is scaled down to fit the panel. */
  scale: number
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
// Connected apps (Composio, with the person's own key) and learned apps (sites the agent mapped itself)
// ---------------------------------------------------------------------------------------------------------------

/** What the agent may do in one account: go ahead, ask first, or never. */
export type AppRule = 'allow' | 'ask' | 'never'

/** Per account: reading and changing things are each allowed, ask first, or never. */
export interface AccountRules {
  read: AppRule
  change: AppRule
}

/** Reading runs, changing asks: what a new account starts with. */
export const DEFAULT_ACCOUNT_RULES: AccountRules = { read: 'allow', change: 'ask' }

/** One signed-in account of a connected app (work Gmail, personal Gmail...). */
export interface ConnectedAccount {
  /** Composio's connected account id. */
  id: string
  /** Composio toolkit slug, for example gmail. */
  app: string
  appName: string
  /** Who it is signed in as, or the app name when Composio does not say. */
  label: string
  status: 'active' | 'pending' | 'failed'
  rules: AccountRules
  /** The app's logo (an https URL from Composio's toolkit list), or '' to show a lettered tile. */
  logo?: string
}

/** Which kind of Composio key is stored. Never the key itself. */
export type ComposioKeyKind = 'project' | 'user' | 'org' | 'consumer' | ''

export interface AppsStatus {
  hasKey: boolean
  keyKind: ComposioKeyKind
  accounts: ConnectedAccount[]
  /** Apps whose sign-in was opened and is still being waited for. */
  connecting: string[]
  /** A plain sentence when the accounts could not be read (bad key, offline), else ''. */
  message: string
}

/** An app the person can connect. */
export interface AppChoice {
  slug: string
  name: string
  line: string
  /** The app's logo (an https URL from Composio), or '' to show a lettered tile. */
  logo?: string
  /** Composio's categories for it, for example Productivity. */
  categories?: string[]
}

export interface LearnedToolInfo {
  name: string
  description: string
  readOnly: boolean
}

/** A site the agent mapped once in its own browser, with the tools it saved for it. */
export interface LearnedAppInfo {
  id: string
  name: string
  startUrl: string
  host: string
  about: string
  /** The person lets its tools that change things run without asking each time. */
  trusted: boolean
  updatedAt: number
  tools: LearnedToolInfo[]
  /** The site's own icon (a data: URL), saved once it was fetched. */
  icon?: string
}

export interface AppsApi {
  status(): Promise<AppsStatus>
  /** Checks the Composio key with Composio and stores it in the secrets module only. Pass '' to remove it. */
  setKey(key: string): Promise<{ ok: boolean; message: string }>
  /** Every app Composio offers (with logos), popular ones first; the popular list alone when there is no key. */
  catalog(): Promise<AppChoice[]>
  /** Search every Composio app for what the person typed (the catalogue a Connect key cannot list in full). */
  search(query: string): Promise<AppChoice[]>
  /** Opens the app's sign-in in the person's own browser and waits in the background until it is connected. */
  connect(app: string): Promise<{ ok: boolean; message: string }>
  disconnect(accountId: string): Promise<void>
  setRules(accountId: string, rules: AccountRules): Promise<void>
  learned(): Promise<LearnedAppInfo[]>
  removeLearned(id: string): Promise<void>
  setTrusted(id: string, trusted: boolean): Promise<void>
  /** Fires when accounts, rules, the key or the learned apps change. */
  onChanged(cb: () => void): Unsubscribe
}

// ---------------------------------------------------------------------------------------------------------------
// Profiles: parts of the person's life (Work, Personal...), each a set of connected accounts and its own
// browser sign-ins. Every helper works inside exactly one. Ported from the phone's data/Profiles.kt.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The colours a profile can take, in the order new profiles get them. They are the app's own accent
 * colours plus graphite (the neutral surface tokens), so every one has tuned light and dark tones.
 */
export const PROFILE_COLORS = ['ocean', 'ember', 'violet', 'rose', 'teal', 'forest', 'magenta', 'iris', 'graphite'] as const
export type ProfileColor = (typeof PROFILE_COLORS)[number]

/** The profile for jobs that need none of the person's accounts. It always exists and keeps the original browser. */
export const GENERAL_PROFILE = 'General'

/** One connected account as a profile remembers it. */
export interface ProfileAccount {
  /** Composio's connected account id. */
  id: string
  /** Composio toolkit slug, for example gmail. */
  app: string
  label: string
}

export interface AgentProfileInfo {
  id: string
  name: string
  color: ProfileColor
  /** The accounts its helpers may use, and nothing else. */
  accounts: ProfileAccount[]
  /** Ids of the learned apps (sites the agent mapped) its helpers may run. */
  learned: string[]
  /** Whose browser sign-ins its helpers browse with: '' for its own, or another profile's id. */
  browser: string
  /** General: none of the person's accounts, cannot be renamed or deleted. */
  general: boolean
}

export interface ProfileDraft {
  name: string
  color?: ProfileColor
  /** Connected account ids. */
  accounts?: string[]
  /** Learned app ids. */
  learned?: string[]
  browser?: string
}

export interface ProfilesApi {
  /** General first, then the rest in the order they were made. */
  list(): Promise<AgentProfileInfo[]>
  create(draft: ProfileDraft): Promise<{ ok: boolean; message: string; profile?: AgentProfileInfo }>
  /** Rename, recolour, change its accounts or its browser sign-ins. */
  update(id: string, patch: Partial<ProfileDraft>): Promise<{ ok: boolean; message: string }>
  remove(id: string): Promise<void>
  /** Puts an account in a profile or takes it out. One account can sit in any number of profiles. */
  setMember(profileId: string, accountId: string, member: boolean): Promise<void>
  /** Fires when a profile changes (also when the agent makes one). */
  onChanged(cb: () => void): Unsubscribe
}

// ---------------------------------------------------------------------------------------------------------------
// The api
// ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------
// Voice: dictation, the live call, read-aloud. The Gemini key and connection live in the main process only.
// ---------------------------------------------------------------------------------------------------------------

export interface VoiceOption {
  id: string
  /** One or two words on how it sounds, from Gemini's own catalogue. */
  feel: string
}

/** Gemini's prebuilt voices, the ones worth offering first. */
export const VOICES: VoiceOption[] = [
  { id: 'Kore', feel: 'Firm' },
  { id: 'Puck', feel: 'Upbeat' },
  { id: 'Charon', feel: 'Informative' },
  { id: 'Zephyr', feel: 'Bright' },
  { id: 'Aoede', feel: 'Breezy' },
  { id: 'Leda', feel: 'Youthful' },
  { id: 'Orus', feel: 'Firm' },
  { id: 'Fenrir', feel: 'Excitable' },
  { id: 'Sulafat', feel: 'Warm' },
  { id: 'Achird', feel: 'Friendly' },
  { id: 'Vindemiatrix', feel: 'Gentle' },
  { id: 'Algenib', feel: 'Gravelly' },
]

export type VoiceResult<T> = ({ ok: true } & T) | { ok: false; error: string }

/** Something the voice agent put on screen during a call. It lands in the chat as an agent message too. */
export interface CallVisual {
  id: string
  kind: 'list' | 'image' | 'card'
  title: string
  /** list: the points. */
  items?: string[]
  /** image: an https address. */
  imageUrl?: string
  /** card: a short body and an optional footnote. */
  body?: string
  footnote?: string
  at: number
}

export type CallState = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'waiting' | 'ended' | 'error'

export interface CallLine {
  id: string
  who: 'you' | 'agent' | 'note'
  text: string
  at: number
}

/** What the main process pushes during a live call. */
export type CallEvent =
  | { type: 'state'; state: CallState; message?: string }
  /** 24 kHz mono PCM16, base64. The renderer plays it and meters it for the orb. */
  | { type: 'audio'; data: string }
  /** The text so far of one caption line; the same id grows until `final`. */
  | { type: 'caption'; line: CallLine; final: boolean }
  | { type: 'visual'; visual: CallVisual }
  /** The person spoke over the agent: drop any queued audio. */
  | { type: 'interrupted' }

export interface CallSummary {
  itemId: string
  durationMs: number
  lines: number
}

export interface VoiceApi {
  /** Stores the Gemini key in the secrets module only. Pass '' to clear. */
  setKey(key: string): Promise<void>
  /** One tiny real call with the stored key. */
  check(): Promise<{ ok: boolean; message: string }>
  /** 16 kHz mono PCM16 audio of a whole dictation, as bytes. */
  transcribe(pcm: Uint8Array): Promise<VoiceResult<{ text: string }>>
  /** Speak text with Gemini TTS. Returns 24 kHz mono PCM16, base64. */
  speak(text: string): Promise<VoiceResult<{ data: string }>>
  /** A voice note's audio (a WAV), by the file name in its chat row. Null when it is not on this computer. */
  noteAudio(file: string): Promise<Uint8Array | null>
  callStart(): Promise<{ ok: boolean; message: string }>
  /** One chunk of 16 kHz mono PCM16 from the microphone. Fire and forget. */
  callAudio(pcm: Uint8Array): void
  callMute(muted: boolean): Promise<void>
  /** Ends the call and writes its transcript to the chat. Null when no call was live. */
  callEnd(): Promise<CallSummary | null>
  onCall(cb: (event: CallEvent) => void): Unsubscribe
}

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
    /**
     * The models the person can use right now, asked live: the provider's list for an API key, or the engine's
     * own list on a Claude or ChatGPT plan. Never a hardcoded list.
     */
    listModels(): Promise<ModelListResult>
    /** Makes one tiny real turn through the installed AI tool (Claude Code) on the person's own plan. */
    checkCli(): Promise<{ ok: boolean; message: string }>
    /** The AI accounts: add one, change it, take it out, give it a key, check it, list its models. */
    accounts: AccountsApi
    /** Runs the chosen plan's own sign-in (it opens the browser) and resolves when it is done. */
    cliLogin(): Promise<{ ok: boolean; message: string }>
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
    /** `chat` is the chat it goes to; MAIN_CHAT when left out. */
    send(text: string, attachments?: Attachment[], chat?: string): Promise<void>
    /** Stops that chat's run (MAIN_CHAT when left out). */
    stop(chat?: string): Promise<void>
    /** One chat's run and cards; with no chat, whether any chat is running and every waiting card. */
    state(chat?: string): Promise<RunState>
    /** Every chat that is running, waiting or has work going alongside. */
    states(): Promise<ChatRunInfo[]>
    /**
     * A new chat holding the history of `itemId`'s chat up to and including that message. Returns the new chat id.
     * The old chat is left as it was.
     */
    branch(itemId: string): Promise<string>
    /** Answer a `question` card. */
    answer(itemId: string, answer: string): Promise<void>
    /** Approve or decline an `approval` card. */
    decide(itemId: string, decision: Decision): Promise<void>
    /**
     * A tap on a button the agent drew in its message `itemId`: goes to the agent quietly, as a button tap, never as a
     * message the person typed. `label` is the button's words, `message` what the tap asks (with the item it names).
     */
    tap(itemId: string, label: string, message: string): Promise<void>
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
    /** Shows the page as a desktop, tablet or phone, or at the panel's own size. Remembered for the site. */
    setView(mode: BrowserViewMode): Promise<void>
    /** Shows the live page over the whole app window, or back in the panel. */
    setExpanded(on: boolean): Promise<void>
    /** A still picture (JPEG data URL) of the page as it is drawn in the panel, shown while the live page steps aside. */
    frame(): Promise<string | null>
    /** The person typed an address or a search in the bar: open it in the tab in front of them. */
    go(address: string): Promise<void>
    /** A new empty tab for the person. */
    newTab(): Promise<void>
    /** Opens Chromium's own DevTools for the tab in front, in a window of its own. */
    devtools(): Promise<void>
    /** Turns the sound of every tab off or back on. */
    setMuted(on: boolean): Promise<void>
    /** The browser profiles: Mine, the agents' shared one, and each profile with sign-ins of its own. */
    people(): Promise<BrowserPerson[]>
    /** The person's next tabs open in this profile ('mine', 'general' or a profile id). */
    usePerson(id: string): Promise<void>
    /** Signs one browser profile out of every site. */
    signOut(id: string): Promise<void>
    onState(cb: (state: BrowserState) => void): Unsubscribe
    /** The renderer's <webview> for a tab is attached: hands its guest page to the main process. */
    attach(tabId: string, guestId: number): Promise<boolean>
  }
  helpers: HelpersApi
  apps: AppsApi
  profiles: ProfilesApi

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
    /**
     * Saves something pasted that has no file on disk (a screenshot, an image copied from a page, a long text) into
     * the app's attachments folder and returns it as an attachment.
     */
    savePasted(name: string, mime: string, bytes: Uint8Array): Promise<Attachment>
    /**
     * The files on the system clipboard (copied in Explorer, Finder or a Linux file manager), read by the main
     * process because a paste event often has no File objects for them. Empty when there are none.
     */
    clipboardFiles(): Promise<Attachment[]>
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

  /** Dictation, the live voice call and read-aloud. */
  voice: VoiceApi

  /** The global shortcuts (Quick Ask and dictation anywhere). */
  hotkeys: {
    /** Each shortcut and whether it is live, or what is in its way. */
    status(): Promise<HotkeyStatus[]>
    /** Lets the Settings recorder hear a key that is already a global shortcut. Resumed on false. */
    pause(paused: boolean): Promise<void>
  }

  /** Dictation anywhere: used by the small pill window that holds the microphone. */
  dictation: {
    /** One chunk of 16 kHz mono PCM16 from the pill's microphone. Fire and forget. */
    audio(session: number, pcm: Uint8Array): void
    /** The pill's microphone started, or could not (the message says why). */
    micState(session: number, ok: boolean, message: string): Promise<void>
    /** The pill was clicked: stop now and type what was heard. */
    stop(): Promise<void>
    /** The pill's page is listening for commands (it loaded, or reloaded). */
    ready(): Promise<void>
    onCommand(cb: (command: DictationCommand) => void): Unsubscribe
    onView(cb: (view: DictationView) => void): Unsubscribe
  }
  /** New Chat filing, past chats and the memory import. */
  memory: MemoryApi

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

// ---------------------------------------------------------------------------------------------------------------
// Long-term memory across chats: New Chat files the finished chat into memory in the background, past chats stay
// searchable, and an existing memory bank can be imported from a JSON export.
// ---------------------------------------------------------------------------------------------------------------

/** What a closing divider carries about filing the chat before it. Lives in the divider's `meta.memory`. */
export interface ChatMemoryNote {
  /** The id of the chat that was filed (the id of its first row, or of the divider that started it). */
  chat: string
  status: 'saving' | 'done' | 'failed'
  /** Memory ids written or updated, newest first. */
  saved?: string[]
  added?: number
  updated?: number
  error?: string
}

/** A past chat found by search. */
export interface PastChatHit {
  chatId: string
  title: string
  /** When the chat started (ms). */
  at: number
  summary: string
  snippets: string[]
}

/** The importer's view of one file before anything is written. */
export interface MemoryImportPreview {
  ok: boolean
  message: string
  /** Name of the bank the file says it came from. */
  source: string
  total: number
  /** Entries that would be written, per app kind. */
  byKind: Partial<Record<MemoryKind, number>>
  /** Left out by default: retired entries and short-lived kinds (state, event). */
  skippedRetired: number
  skippedTransient: number
  invalid: number
}

export interface MemoryImportResult extends MemoryImportPreview {
  added: number
  updated: number
  unchanged: number
  /** Entries whose page the person deleted here: left alone, never brought back. */
  deletedHere: number
  redacted: number
  ms: number
}

/** What tidying a memory bank with the agent would do: the notes it reads and the steps it takes, before it starts. */
export interface MemoryTidyPlan {
  ok: boolean
  message: string
  source: string
  /** Notes the agent reads (retired notes and older day-to-day state are left out unless everything is included). */
  notes: number
  projects: number
  /** One model call each. */
  steps: number
  chars: number
  /** Older day-to-day state and events left out because newer notes say where things stand. */
  olderState: number
  retired: number
}

/** Where tidying a memory bank has got to. It runs in the background and survives closing the dialog. */
export interface MemoryTidyProgress {
  running: boolean
  /** True once every step has run (some may have failed). */
  finished: boolean
  source: string
  /** The project being read now, and its place in the list. */
  project: string
  projectIndex: number
  projects: number
  steps: number
  done: number
  failed: number
  added: number
  updated: number
  /** The last few failures, newest last. */
  errors: Array<{ project: string; error: string }>
  startedAt: number
  finishedAt: number | null
  /** The whole import can still be undone. */
  canUndo: boolean
  message: string
}

/** One change the end-of-day pass made to memory, with the page as it was so it can be undone. */
export interface UpkeepChange {
  id: string
  at: number
  action: 'where' | 'filed' | 'merged' | 'rewritten' | 'dropped'
  memoryId: string
  title: string
  reason: string
  /** The page before the change; null when the change created it. */
  before: MemoryRow | null
  undone?: boolean
}

/** What the end-of-day pass did, for the Memory view. */
export interface UpkeepReport {
  at: number
  trigger: 'schedule' | 'manual' | 'catch-up'
  ok: boolean
  message: string
  /** The day the "Where we are" page covers (YYYY-MM-DD), when one was written. */
  day: string
  chats: number
  filed: number
  merged: number
  rewritten: number
  dropped: number
  changes: UpkeepChange[]
}

export interface UpkeepSummary {
  report: UpkeepReport | null
  lastRunAt: number
  /** Earlier "Where we are" pages, oldest first. */
  history: Array<{ day: string; body: string }>
}

export interface MemoryApi {
  /**
   * Starts a fresh chat at once. The old one is filed into memory in the background. With `target` (several chats
   * at once), `chat` is the new chat the person opened and `from` the one they left: it keeps running and keeps
   * its context, and the divider with the filing note opens the new chat.
   */
  newChat(target?: { chat: string; from: string }): Promise<{ dividerId: string | null; saving: boolean }>
  /** Files a chat again after a failure (the divider that closed it). */
  retrySave(dividerId: string): Promise<void>
  /** Opens the OS picker for a memory export (.json). Null when the person cancelled. */
  pickImport(): Promise<{ path: string; name: string } | null>
  previewImport(path: string, includeAll: boolean): Promise<MemoryImportPreview>
  runImport(path: string, includeAll: boolean): Promise<MemoryImportResult>
  /** What tidying the file with the agent would take. */
  previewTidy(path: string, includeAll: boolean): Promise<MemoryTidyPlan>
  /** Starts (or resumes) tidying the file into memory in the background. Steps already done are skipped. */
  startTidy(path: string, includeAll: boolean): Promise<MemoryTidyProgress>
  /** Stops after the step in progress; starting again carries on where it stopped. */
  stopTidy(): Promise<MemoryTidyProgress>
  tidyState(): Promise<MemoryTidyProgress | null>
  /** Takes every page the tidy import added out again and puts every page it changed back as it was. */
  undoTidy(): Promise<{ removed: number; restored: number }>
  onTidy(cb: (progress: MemoryTidyProgress) => void): Unsubscribe
  /** Full text search over past chats and their summaries. */
  searchChats(query: string, limit?: number): Promise<PastChatHit[]>
  /** The end-of-day pass now: "Where we are" from today's chats, then the clean-up sweep. */
  runDaily(): Promise<UpkeepReport>
  upkeep(): Promise<UpkeepSummary>
  /** Puts one logged change back. */
  undoChange(changeId: string): Promise<boolean>
  /** Every kept version of one memory page, newest first. */
  history(memoryId: string): Promise<MemoryVersion[]>
  /** Makes a page say what an earlier version said again (a new version, so nothing is lost). */
  restoreVersion(memoryId: string, n: number): Promise<boolean>
  onUpkeep(cb: (report: UpkeepReport | null) => void): Unsubscribe
}
