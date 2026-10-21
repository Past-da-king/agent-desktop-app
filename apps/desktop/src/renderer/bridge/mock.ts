import { DEFAULT_SETTINGS, GENERAL_PROFILE, MAIN_CHAT, PROFILE_COLORS, PROVIDERS, pickModel, resolvePick } from '@agent/core'
import type {
  AccountRules,
  AgentApi,
  AgentProfileInfo,
  ProfileAccount,
  ProfileDraft,
  AppChoice,
  AppsStatus,
  ConnectedAccount,
  LearnedAppInfo,
  BrowserBounds,
  BrowserPerson,
  DataChange,
  ProjectRow,
  BrowserState,
  BrowserViewMode,
  ChatEvent,
  ChatItem,
  Decision,
  EntityMap,
  EntityName,
  EnvironmentReport,
  HotkeyStatus,
  RouteTarget,
  RowInput,
  RunState,
  Settings,
  SignInResult,
  SyncProgress,
  SyncStatus,
  SystemInfo,
  Unsubscribe,
  MemoryImportPreview,
  AiAccount,
  MemoryRow,
  MemoryTidyPlan,
  MemoryTidyProgress,
  MemoryVersion,
  UpkeepChange,
  UpkeepReport,
} from '@agent/core'

import { mockVoice } from '../voice/mock-voice'
import { DEMO_CHATS } from './chats-demo'
import { mockHotkeys } from './mock-hotkeys'
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

// ---- memory versions (the main process keeps these in the Store; here, in memory) ----

const mockVersions = new Map<string, MemoryVersion[]>()

function versionOf(memoryId: string, n: number, at: number, by: string, reason: string, changed: string[], row: Partial<MemoryRow>, deleted = false): MemoryVersion {
  return {
    memoryId,
    n,
    at,
    by,
    reason,
    changed,
    deleted,
    title: row.title ?? '',
    body: row.body ?? '',
    kind: row.kind ?? 'fact',
    topics: row.topics ?? '',
    status: row.status === 'closed' ? 'closed' : 'open',
    aliases: row.aliases ?? '',
    pinned: row.pinned === true,
  }
}

function keepMockVersion(before: MemoryRow | null, after: MemoryRow | null, by: string, reason = ''): void {
  const id = after?.id ?? before?.id ?? ''
  const list = mockVersions.get(id) ?? []
  if (list.length === 0 && before !== null) list.push(versionOf(id, 1, before.updatedAt, 'earlier', '', ['created'], before))
  const fields = ['title', 'body', 'kind', 'topics', 'status', 'aliases', 'pinned'] as const
  const changed =
    after === null
      ? ['deleted']
      : before === null
        ? ['created']
        : fields.filter((key) => String(before[key] ?? (key === 'status' ? 'open' : '')) !== String(after[key] ?? (key === 'status' ? 'open' : '')))
  if (changed.length === 0) return
  list.push(versionOf(id, list.length + 1, Date.now(), by, reason, changed, after ?? before ?? {}, after === null))
  mockVersions.set(id, list)
}

// The demo's TAP decision changed over a few days, so its history has a story to show.
{
  const tap = rows.memory.find((row) => row.id === 'm9')
  if (tap !== undefined) {
    const day = 86_400_000
    const at = tap.updatedAt
    mockVersions.set('m9', [
      versionOf('m9', 1, at - 3 * day, 'chat filing', '', ['created'], { ...tap, title: 'Lisbon flights', body: 'Looking at a one-stop flight via Madrid for R7,900, the cheapest found.', kind: 'decision' }),
      versionOf('m9', 2, at - 2 * day, 'helper Airline comparison', 'compared three airlines', ['title', 'body'], { ...tap, title: 'Lisbon flights', body: 'Two options: one-stop via Madrid R7,900 (leaves 23:40), TAP direct R8,750. Waiting on Sam.' }),
      versionOf('m9', 3, at, 'agent', 'Sam chose TAP in the chat', ['title', 'body'], tap),
    ])
  }
}
let apiKey = ''
let running = false
let agentTimer: ReturnType<typeof setTimeout> | null = null
let activityTimer: ReturnType<typeof setTimeout> | null = null
let syncTimer: ReturnType<typeof setTimeout> | null = null

const settingsListeners = new Set<(next: Settings) => void>()
const dataListeners = new Set<(change: DataChange) => void>()
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
  for (const listener of dataListeners) listener({ entity, reset: true })
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

/** Chats with a mock run going, and the timers that finish it. */
const mockRuns = new Map<string, Array<ReturnType<typeof setTimeout>>>()

function chatEvent(chat: string, event: ChatEvent): ChatEvent {
  return chat === MAIN_CHAT ? event : ({ ...event, chat } as ChatEvent)
}

// ?busy=1 shows two chats working at once (the first chat and the Acme one), for screenshots.
if ((mode === 'demo' || mode === 'big') && typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('busy') === '1') {
  mockRuns.set(MAIN_CHAT, [])
  mockRuns.set(DEMO_CHATS.acme, [])
  running = true
}

/** A short pretend run in one chat: a tool step, then a reply. */
function mockRun(chat: string, ms: number, reply?: string): void {
  const tag = chat === MAIN_CHAT ? {} : { chat }
  for (const timer of mockRuns.get(chat) ?? []) clearTimeout(timer)
  running = true
  emitChat(chatEvent(chat, { type: 'run_started' }))
  emitChat(chatEvent(chat, { type: 'thinking', step: 1 }))
  const step = setTimeout(() => {
    insertChat({
      kind: 'activity',
      text: 'Searched memory, 1 found',
      meta: JSON.stringify({ tool: 'memory_search', status: 'done', summary: 'Searched memory, 1 found', ...tag }),
    })
  }, Math.min(300, ms / 2))
  const done = setTimeout(() => {
    insertChat({
      kind: 'agent',
      text:
        reply ??
        "Got it. I've added that to the current goal and I'll tell you as soon as it's done. Anything that spends money still waits for your OK.",
      meta: JSON.stringify(tag),
    })
    mockRuns.delete(chat)
    running = mockRuns.size > 0
    emitChat(chatEvent(chat, { type: 'run_finished' }))
  }, ms)
  mockRuns.set(chat, [step, done])
}

/** A different job sent while a chat was busy: a side run with its own block, done after a few seconds. */
function mockAlongside(chat: string, text: string, userItem: string): void {
  const tag = chat === MAIN_CHAT ? {} : { chat }
  const helper = insertChat({
    kind: 'helper',
    text,
    meta: JSON.stringify({ label: text.split(/\s+/).slice(0, 4).join(' '), state: 'working', summary: 'Thinking', side: true, ask: userItem, startedAt: Date.now(), ...tag }),
  })
  patchCard(helper.id, { id: helper.id })
  setTimeout(() => {
    insertChat({
      kind: 'activity',
      text: 'Read a page',
      meta: JSON.stringify({ tool: 'web_fetch', status: 'done', summary: 'Read a page', helper: helper.id, ...tag }),
    })
  }, 900)
  setTimeout(() => {
    patchCard(helper.id, {
      state: 'done',
      endedAt: Date.now(),
      summary: 'Done',
      result: `Done. ${text.replace(/[.?!]+$/, '')}: I looked into it and the short answer is yes. The details are in the steps below.`,
    })
  }, 3200)
}

const pastedPreviews = new Map<string, string>()

function signInError(email: string, password: string): string | null {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'That email address does not look right.'
  if (password.length < 6) return 'Use a password of at least 6 characters.'
  return null
}

const runState: RunState = { running: false, waiting: [] }

const browserListeners = new Set<(state: BrowserState) => void>()
// Only the seeded demo has a page open; empty and fresh modes show the browser's own empty state.
const demoBrowser = mode === 'demo' || mode === 'big'
const mockBrowser: BrowserState = {
  url: demoBrowser ? 'https://skyhop.example/flights' : '',
  title: demoBrowser ? 'SkyHop flights' : '',
  tabs: demoBrowser
    ? [
        {
          id: 'mock-tab-1',
          title: 'SkyHop flights',
          url: 'https://skyhop.example/flights',
          active: true,
        },
      ]
    : [],
  visible: false,
  agentActive: demoBrowser,
  needsUser: false,
  handoffReason: '',
  view: { mode: 'desktop', label: 'Desktop 1440x900', width: 1440, height: 900, scale: 0.28 },
}

const MOCK_VIEWS: Record<BrowserViewMode, NonNullable<BrowserState['view']>> = {
  desktop: { mode: 'desktop', label: 'Desktop 1440x900', width: 1440, height: 900, scale: 0.28 },
  tablet: { mode: 'tablet', label: 'Tablet 820x1180', width: 820, height: 1180, scale: 0.29 },
  phone: { mode: 'phone', label: 'Phone 390x844', width: 390, height: 844, scale: 0.4 },
  fit: { mode: 'fit', label: 'Fits the panel', width: 0, height: 0, scale: 1 },
}

function notifyBrowser(): void {
  const snapshot: BrowserState = {
    ...mockBrowser,
    tabs: mockBrowser.tabs.map((tab) => ({ ...tab })),
    ...(mockBrowser.view === undefined ? {} : { view: { ...mockBrowser.view } }),
  }
  for (const listener of browserListeners) listener(snapshot)
}

// ---- connected apps and learned apps ----

const MOCK_CATALOG: AppChoice[] = [
  { slug: 'gmail', name: 'Gmail', line: 'Read, search, draft and send email', logo: '', categories: ['Email'] },
  { slug: 'googlecalendar', name: 'Google Calendar', line: 'See your day, find time, add events', logo: '', categories: ['Calendar'] },
  { slug: 'googledrive', name: 'Google Drive', line: 'Find, read and share your files', logo: '', categories: ['Files'] },
  { slug: 'googledocs', name: 'Google Docs', line: 'Read and write documents', logo: '', categories: ['Documents'] },
  { slug: 'googlesheets', name: 'Google Sheets', line: 'Read and update spreadsheets', logo: '', categories: ['Documents'] },
  { slug: 'googlemeet', name: 'Google Meet', line: 'Meetings, links and recordings', logo: '', categories: ['Meetings'] },
  { slug: 'outlook', name: 'Outlook', line: 'Microsoft email and calendar', logo: '', categories: ['Email'] },
  { slug: 'microsoft_teams', name: 'Microsoft Teams', line: 'Chats, channels and meetings', logo: '', categories: ['Chat'] },
  { slug: 'one_drive', name: 'OneDrive', line: 'Microsoft files', logo: '', categories: ['Files'] },
  { slug: 'slack', name: 'Slack', line: 'Read channels and send messages', logo: '', categories: ['Chat'] },
  { slug: 'notion', name: 'Notion', line: 'Notes, docs and databases', logo: '', categories: ['Documents'] },
  { slug: 'todoist', name: 'Todoist', line: 'Tasks and projects', logo: '', categories: ['Tasks'] },
  { slug: 'trello', name: 'Trello', line: 'Boards and cards', logo: '', categories: ['Tasks'] },
  { slug: 'asana', name: 'Asana', line: 'Team tasks and projects', logo: '', categories: ['Tasks'] },
  { slug: 'clickup', name: 'ClickUp', line: 'Tasks, docs and goals', logo: '', categories: ['Tasks'] },
  { slug: 'linear', name: 'Linear', line: 'Issues and projects', logo: '', categories: ['Developer'] },
  { slug: 'github', name: 'GitHub', line: 'Repos, issues and pull requests', logo: '', categories: ['Developer'] },
  { slug: 'gitlab', name: 'GitLab', line: 'Repos, merge requests and pipelines', logo: '', categories: ['Developer'] },
  { slug: 'jira', name: 'Jira', line: 'Issues, sprints and boards', logo: '', categories: ['Developer'] },
  { slug: 'confluence', name: 'Confluence', line: 'Team pages and spaces', logo: '', categories: ['Documents'] },
  { slug: 'bitbucket', name: 'Bitbucket', line: 'Repos and pull requests', logo: '', categories: ['Developer'] },
  { slug: 'dropbox', name: 'Dropbox', line: 'Files and folders', logo: '', categories: ['Files'] },
  { slug: 'box', name: 'Box', line: 'Business files and sharing', logo: '', categories: ['Files'] },
  { slug: 'zoom', name: 'Zoom', line: 'Meetings and recordings', logo: '', categories: ['Meetings'] },
  { slug: 'calendly', name: 'Calendly', line: 'Booking links and meetings', logo: '', categories: ['Calendar'] },
  { slug: 'hubspot', name: 'HubSpot', line: 'Contacts, deals and CRM', logo: '', categories: ['Sales'] },
  { slug: 'salesforce', name: 'Salesforce', line: 'Accounts, leads and opportunities', logo: '', categories: ['Sales'] },
  { slug: 'pipedrive', name: 'Pipedrive', line: 'Deals and pipelines', logo: '', categories: ['Sales'] },
  { slug: 'zendesk', name: 'Zendesk', line: 'Support tickets', logo: '', categories: ['Support'] },
  { slug: 'intercom', name: 'Intercom', line: 'Customer conversations', logo: '', categories: ['Support'] },
  { slug: 'freshdesk', name: 'Freshdesk', line: 'Helpdesk tickets', logo: '', categories: ['Support'] },
  { slug: 'airtable', name: 'Airtable', line: 'Bases and records', logo: '', categories: ['Documents'] },
  { slug: 'monday', name: 'monday.com', line: 'Boards and workflows', logo: '', categories: ['Tasks'] },
  { slug: 'basecamp', name: 'Basecamp', line: 'Projects, to-dos and messages', logo: '', categories: ['Tasks'] },
  { slug: 'miro', name: 'Miro', line: 'Whiteboards and boards', logo: '', categories: ['Design'] },
  { slug: 'figma', name: 'Figma', line: 'Design files and comments', logo: '', categories: ['Design'] },
  { slug: 'canva', name: 'Canva', line: 'Designs and brand kits', logo: '', categories: ['Design'] },
  { slug: 'linkedin', name: 'LinkedIn', line: 'Posts and profile', logo: '', categories: ['Social'] },
  { slug: 'instagram', name: 'Instagram', line: 'Posts, stories and messages', logo: '', categories: ['Social'] },
  { slug: 'facebook', name: 'Facebook', line: 'Pages, posts and messages', logo: '', categories: ['Social'] },
  { slug: 'youtube', name: 'YouTube', line: 'Videos, playlists and comments', logo: '', categories: ['Social'] },
  { slug: 'twitter', name: 'X', line: 'Posts and messages', logo: '', categories: ['Social'] },
  { slug: 'reddit', name: 'Reddit', line: 'Posts, comments and messages', logo: '', categories: ['Social'] },
  { slug: 'discord', name: 'Discord', line: 'Servers and messages', logo: '', categories: ['Chat'] },
  { slug: 'telegram', name: 'Telegram', line: 'Chats and bots', logo: '', categories: ['Chat'] },
  { slug: 'whatsapp', name: 'WhatsApp Business', line: 'Messages to customers', logo: '', categories: ['Chat'] },
  { slug: 'spotify', name: 'Spotify', line: 'Playlists and playback', logo: '', categories: ['Media'] },
  { slug: 'shopify', name: 'Shopify', line: 'Orders, products and customers', logo: '', categories: ['Commerce'] },
  { slug: 'stripe', name: 'Stripe', line: 'Payments and invoices', logo: '', categories: ['Finance'] },
  { slug: 'quickbooks', name: 'QuickBooks', line: 'Invoices and accounts', logo: '', categories: ['Finance'] },
  { slug: 'xero', name: 'Xero', line: 'Invoices, bills and bank', logo: '', categories: ['Finance'] },
  { slug: 'paypal', name: 'PayPal', line: 'Payments and transactions', logo: '', categories: ['Finance'] },
  { slug: 'mailchimp', name: 'Mailchimp', line: 'Audiences and campaigns', logo: '', categories: ['Marketing'] },
  { slug: 'sendgrid', name: 'SendGrid', line: 'Transactional email', logo: '', categories: ['Marketing'] },
  { slug: 'typeform', name: 'Typeform', line: 'Forms and responses', logo: '', categories: ['Marketing'] },
  { slug: 'googleanalytics', name: 'Google Analytics', line: 'Traffic and reports', logo: '', categories: ['Marketing'] },
  { slug: 'wordpress', name: 'WordPress', line: 'Posts and pages', logo: '', categories: ['Marketing'] },
  { slug: 'webflow', name: 'Webflow', line: 'Sites and CMS items', logo: '', categories: ['Marketing'] },
  { slug: 'docusign', name: 'DocuSign', line: 'Envelopes and signatures', logo: '', categories: ['Documents'] },
  { slug: 'evernote', name: 'Evernote', line: 'Notes and notebooks', logo: '', categories: ['Documents'] },
  { slug: 'onenote', name: 'OneNote', line: 'Microsoft notebooks', logo: '', categories: ['Documents'] },
  { slug: 'excel', name: 'Excel', line: 'Microsoft workbooks', logo: '', categories: ['Documents'] },
  { slug: 'sharepoint', name: 'SharePoint', line: 'Sites, lists and files', logo: '', categories: ['Files'] },
  { slug: 'googletasks', name: 'Google Tasks', line: 'Your Google to-dos', logo: '', categories: ['Tasks'] },
  { slug: 'googlecontacts', name: 'Google Contacts', line: 'People and groups', logo: '', categories: ['Contacts'] },
]

const seededApps = mode === 'demo' || mode === 'big'
let appsKeyKind: AppsStatus['keyKind'] = seededApps ? 'project' : ''
let appsAccounts: ConnectedAccount[] = seededApps
  ? [
      { id: 'ca_gmail_work', app: 'gmail', appName: 'Gmail', label: 'ana@example.com', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_gmail_sales', app: 'gmail', appName: 'Gmail', label: 'sales@example.com', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_gmail_home', app: 'gmail', appName: 'Gmail', label: 'ana.home@example.org', logo: '', status: 'active', rules: { read: 'allow', change: 'never' } },
      { id: 'ca_gmail_old', app: 'gmail', appName: 'Gmail', label: 'ana.archive@example.net', logo: '', status: 'active', rules: { read: 'ask', change: 'never' } },
      { id: 'ca_slack_studio', app: 'slack', appName: 'Slack', label: 'Example Studio workspace', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_slack_club', app: 'slack', appName: 'Slack', label: 'Running club workspace', logo: '', status: 'pending', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_github_work', app: 'github', appName: 'GitHub', label: 'ana-studio', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_github_own', app: 'github', appName: 'GitHub', label: 'ana-codes', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_calendar', app: 'googlecalendar', appName: 'Google Calendar', label: 'ana@example.com', logo: '', status: 'active', rules: { read: 'allow', change: 'allow' } },
      { id: 'ca_meet', app: 'googlemeet', appName: 'Google Meet', label: 'ana@example.com', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_outlook', app: 'outlook', appName: 'Outlook', label: 'ana@client.example', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_teams', app: 'microsoft_teams', appName: 'Microsoft Teams', label: 'ana@client.example', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_onedrive', app: 'one_drive', appName: 'OneDrive', label: 'ana@client.example', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_clickup', app: 'clickup', appName: 'ClickUp', label: 'Example Studio', logo: '', status: 'active', rules: { read: 'allow', change: 'allow' } },
      { id: 'ca_linkedin', app: 'linkedin', appName: 'LinkedIn', label: 'Ana Example', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_instagram', app: 'instagram', appName: 'Instagram', label: '@ana.example', logo: '', status: 'active', rules: { read: 'allow', change: 'never' } },
      { id: 'ca_facebook', app: 'facebook', appName: 'Facebook', label: 'Ana Example', logo: '', status: 'failed', rules: { read: 'allow', change: 'ask' } },
      { id: 'ca_youtube', app: 'youtube', appName: 'YouTube', label: 'Ana Example channel', logo: '', status: 'active', rules: { read: 'allow', change: 'ask' } },
    ]
  : []
const appsConnecting = new Set<string>(seededApps ? ['slack'] : [])
let learnedApps: LearnedAppInfo[] = seededApps
  ? [
      {
        id: 'hacker_news',
        name: 'Hacker News',
        startUrl: 'https://news.ycombinator.com',
        host: 'news.ycombinator.com',
        about: 'The front page, comments and search. No sign-in needed.',
        trusted: false,
        updatedAt: Date.now() - 3 * 86_400_000,
        tools: [
          { name: 'front_page', description: 'The stories on the front page, with points and links', readOnly: true },
          { name: 'read_comments', description: 'The top comments on one story', readOnly: true },
          { name: 'search', description: 'Search stories by words', readOnly: true },
        ],
      },
      {
        id: 'example_shop',
        name: 'Example Shop',
        startUrl: 'https://shop.example',
        host: 'shop.example',
        about: 'You sign in yourself in the agent browser. It never pays.',
        trusted: false,
        updatedAt: Date.now() - 86_400_000,
        tools: [
          { name: 'search_products', description: 'Find products by name, with prices', readOnly: true },
          { name: 'order_history', description: 'Your recent orders and their status', readOnly: true },
          { name: 'add_to_cart', description: 'Put one product in the cart', readOnly: false },
        ],
      },
    ]
  : []
const appsListeners = new Set<() => void>()

function emitApps(): void {
  for (const listener of appsListeners) listener()
}

// ---- profiles: General (no accounts), and in the demo Work and Personal ----

function profileAccount(id: string): ProfileAccount | null {
  const account = appsAccounts.find((each) => each.id === id)
  return account === undefined ? null : { id: account.id, app: account.app, label: account.label }
}

let profiles: AgentProfileInfo[] = [
  { id: 'general', name: GENERAL_PROFILE, color: 'graphite', accounts: [], learned: [], browser: '', general: true },
  ...(seededApps
    ? [
        {
          id: 'p_work',
          name: 'Work',
          color: 'ocean' as const,
          accounts: [
            { id: 'ca_gmail_work', app: 'gmail', label: 'ana@example.com' },
            { id: 'ca_gmail_sales', app: 'gmail', label: 'sales@example.com' },
            { id: 'ca_slack_studio', app: 'slack', label: 'Example Studio workspace' },
            { id: 'ca_github_work', app: 'github', label: 'ana-studio' },
            { id: 'ca_calendar', app: 'googlecalendar', label: 'ana@example.com' },
            { id: 'ca_meet', app: 'googlemeet', label: 'ana@example.com' },
            { id: 'ca_outlook', app: 'outlook', label: 'ana@client.example' },
            { id: 'ca_teams', app: 'microsoft_teams', label: 'ana@client.example' },
            { id: 'ca_onedrive', app: 'one_drive', label: 'ana@client.example' },
            { id: 'ca_clickup', app: 'clickup', label: 'Example Studio' },
            { id: 'ca_linkedin', app: 'linkedin', label: 'Ana Example' },
          ],
          learned: ['example_shop'],
          browser: '',
          general: false,
        },
        {
          id: 'p_personal',
          name: 'Personal',
          color: 'ember' as const,
          accounts: [
            { id: 'ca_gmail_home', app: 'gmail', label: 'ana.home@example.org' },
            { id: 'ca_gmail_old', app: 'gmail', label: 'ana.archive@example.net' },
            { id: 'ca_slack_club', app: 'slack', label: 'Running club workspace' },
            { id: 'ca_github_own', app: 'github', label: 'ana-codes' },
            { id: 'ca_calendar', app: 'googlecalendar', label: 'ana@example.com' },
            { id: 'ca_linkedin', app: 'linkedin', label: 'Ana Example' },
            { id: 'ca_instagram', app: 'instagram', label: '@ana.example' },
            { id: 'ca_facebook', app: 'facebook', label: 'Ana Example' },
            { id: 'ca_youtube', app: 'youtube', label: 'Ana Example channel' },
          ],
          learned: ['hacker_news'],
          browser: '',
          general: false,
        },
      ]
    : []),
]
const profileListeners = new Set<() => void>()

function emitProfiles(): void {
  for (const listener of profileListeners) listener()
}

function nextProfileColor(): AgentProfileInfo['color'] {
  return PROFILE_COLORS.find((color) => color !== 'graphite' && !profiles.some((p) => p.color === color)) ?? 'iris'
}

function cleanProfileName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, 40)
}

function appName(slug: string): string {
  return (
    MOCK_CATALOG.find((item) => item.slug === slug)?.name ??
    slug
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ')
  )
}

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
    async listModels() {
      if (apiKey === '' && !settings.hasKey) return { ok: false, models: [], message: 'Add an API key first.' }
      await delay(400)
      const models = ['deepseek-v4.1-flash', 'deepseek-v4.1-pro', 'kimi-k3', 'glm-5.2', 'qwen4-coder', 'minimax-m3'].map((id) => ({ id, label: id, line: '' }))
      return { ok: true, models, message: `Your key works. ${models.length} models to choose from.` }
    },
    async cliLogin() {
      await delay(1200)
      return { ok: true, message: 'Signed in.' }
    },
    async checkCli() {
      await delay(900)
      return { ok: true, message: 'Claude Code is signed in and working on your plan.' }
    },
    accounts: {
      async add(draft) {
        const id = `acc_${Math.random().toString(16).slice(2, 8)}`
        const kind = draft.kind ?? 'api'
        const account: AiAccount = { id, label: draft.label?.trim() || (kind === 'api' ? 'API key' : kind === 'codex' ? 'ChatGPT plan' : 'Claude plan'), kind, model: draft.model ?? '', hasKey: false, ...(kind === 'api' ? { provider: draft.provider ?? 'anthropic' } : {}) }
        saveSettings({ accounts: [...settings.accounts, account] })
        return account
      },
      async update(id, patch) {
        const found = settings.accounts.find((a) => a.id === id)
        if (found === undefined) throw new Error('No such account')
        const next: AiAccount = { ...found, ...(patch.label === undefined ? {} : { label: patch.label }), ...(patch.model === undefined ? {} : { model: patch.model }), ...(patch.provider === undefined ? {} : { provider: patch.provider }) }
        saveSettings({ accounts: settings.accounts.map((a) => (a.id === id ? next : a)) })
        return next
      },
      async remove(id) {
        const clear = (pick: { account: string; model: string }): { account: string; model: string } => (pick.account === id ? { account: '', model: '' } : pick)
        saveSettings({ accounts: settings.accounts.filter((a) => a.id !== id), ai: { main: clear(settings.ai.main), helpers: clear(settings.ai.helpers) } })
      },
      async setKey(id, key) {
        saveSettings({ accounts: settings.accounts.map((a) => (a.id === id ? { ...a, hasKey: key.trim() !== '' } : a)) })
      },
      async check(id) {
        await delay(600)
        const found = settings.accounts.find((a) => a.id === id)
        return found === undefined ? { ok: false, message: 'No such account.' } : { ok: true, message: found.kind === 'api' ? 'That key works.' : 'Signed in and working on your plan.' }
      },
      async listModels(id) {
        await delay(400)
        const found = settings.accounts.find((a) => a.id === id)
        const ids = found?.kind === 'api' ? (found.provider === 'anthropic' ? ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] : ['deepseek-v4.1-flash', 'deepseek-v4.1-pro', 'kimi-k3', 'glm-5.2']) : ['opus', 'sonnet', 'haiku', 'fable']
        return { ok: true, models: ids.map((m) => ({ id: m, label: m, line: '' })), message: `${ids.length} models to choose from.` }
      },
      async signIn() {
        await delay(1000)
        return { ok: true, message: 'Signed in.' }
      },
      async chatBrain(chat) {
        const project = rows.project.find((p) => p.chats.includes(chat))
        const main = resolvePick(settings, project?.ai, 'main')
        const helpers = resolvePick(settings, project?.ai, 'helpers')
        const full = (pick: { account: string; model: string }): { account: string; model: string } => ({ account: pick.account, model: pickModel(settings, pick) })
        return { main: { wanted: full(main), using: full(main), deferred: false }, helpers: { wanted: full(helpers), using: full(helpers), deferred: false } }
      },
    },
    async reset() {
      rows = {
        chat_item: [],
        turn: [],
        memory: [],
        goal: [],
        task: [],
        trigger: [],
        project: [],
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
    async get<E extends EntityName>(entity: E, id: string): Promise<EntityMap[E] | null> {
      const row = (rows[entity] as Array<EntityMap[E]>).find((each) => each.id === id)
      return row === undefined ? null : (copy(row) as EntityMap[E])
    },
    async upsert<E extends EntityName>(entity: E, row: RowInput<E>): Promise<EntityMap[E]> {
      const raw = row as { id?: string }
      const before = entity === 'memory' ? (copy(rows.memory.find((each) => each.id === raw.id) ?? null) as MemoryRow | null) : null
      // The real Store stamps every memory write; so does the mock, so the window sees the change.
      const saved = upsertRow(entity, entity === 'memory' ? ({ ...row, updatedAt: Date.now() } as RowInput<E>) : row)
      if (entity === 'memory') keepMockVersion(before, saved as unknown as MemoryRow, 'you')
      return saved
    },
    async remove(entity, id) {
      const list = rows[entity] as Array<{ id: string }>
      const index = list.findIndex((row) => row.id === id)
      if (entity === 'memory' && index >= 0) keepMockVersion(copy(rows.memory[index] ?? null) as MemoryRow | null, null, 'you')
      if (index >= 0) {
        list.splice(index, 1)
        emitData(entity)
      }
    },
    onChanged(callback: (change: DataChange) => void): Unsubscribe {
      dataListeners.add(callback)
      return () => {
        dataListeners.delete(callback)
      }
    },
  },

  chat: {
    async send(text, attachments, chat) {
      const value = text.trim()
      const files = attachments ?? []
      if (value === '' && files.length === 0) return
      const target = chat === undefined || chat === '' ? MAIN_CHAT : chat
      const tag = target === MAIN_CHAT ? {} : { chat: target }
      if (mockRuns.has(target)) {
        // Busy: the same words the real router checks first decide it here; anything else goes alongside.
        const join = /^(also|and |plus|wait|actually|no,|instead|sorry|make sure|btw|by the way)/i.test(value)
        const user = insertChat({ kind: 'user', text: value, meta: JSON.stringify({ attachments: files, ...tag, route: join ? 'join' : 'alongside' }) })
        if (!join) mockAlongside(target, value, user.id)
        return
      }
      insertChat({ kind: 'user', text: value, meta: JSON.stringify({ attachments: files, ...tag }) })
      // The preview's take on project_create: the agent found the folder and asks on a card (tools/projects.ts).
      if (/\b(create|make|start) (a |the )?project\b/i.test(value)) {
        insertChat({ kind: 'agent', text: 'Found the folder on your Desktop. Here is the project; tap Create when it looks right.', meta: JSON.stringify(tag) })
        insertChat({
          kind: 'question',
          text: 'Make the project Acme relaunch?',
          meta: JSON.stringify({
            ...tag,
            options: ['Create', 'Change'],
            answer: '',
            card: { kind: 'project', name: 'Acme relaunch', description: 'The new acme shop site: copy, lender pages and the launch on 14 November.', path: 'C:\\Users\\You\\Desktop\\projects\\acme-site', folderNew: false, profile: 'Work', icon: { glyph: 'globe', color: 'teal' } },
          }),
        })
        return
      }
      mockRun(target, 800)
    },
    async stop(chat) {
      const target = chat === undefined || chat === '' ? MAIN_CHAT : chat
      const timers = mockRuns.get(target)
      if (timers === undefined) return
      for (const timer of timers) clearTimeout(timer)
      mockRuns.delete(target)
      running = mockRuns.size > 0
      insertChat({ kind: 'notice', text: 'Stopped', meta: JSON.stringify(target === MAIN_CHAT ? {} : { chat: target }) })
      emitChat(target === MAIN_CHAT ? { type: 'run_finished' } : { type: 'run_finished', chat: target })
    },
    async state(chat) {
      const target = chat === undefined || chat === '' ? null : chat
      const waiting = waitingIds().filter((id) => {
        if (target === null) return true
        const row = rows.chat_item.find((item) => item.id === id)
        const owner = row === undefined ? MAIN_CHAT : String(parseMeta(row.meta)['chat'] ?? MAIN_CHAT)
        return owner === target
      })
      return { running: target === null ? mockRuns.size > 0 : mockRuns.has(target), waiting }
    },
    async states() {
      const chats = new Set<string>(mockRuns.keys())
      const byChat = new Map<string, string[]>()
      for (const id of waitingIds()) {
        const row = rows.chat_item.find((item) => item.id === id)
        const owner = row === undefined ? MAIN_CHAT : String(parseMeta(row.meta)['chat'] ?? MAIN_CHAT)
        byChat.set(owner, [...(byChat.get(owner) ?? []), id])
        chats.add(owner)
      }
      const live = rows.chat_item.filter((item) => item.kind === 'helper' && parseMeta(item.meta)['state'] === 'working')
      for (const helper of live) chats.add(String(parseMeta(helper.meta)['chat'] ?? MAIN_CHAT))
      return [...chats].map((chat) => ({
        chat,
        running: mockRuns.has(chat),
        waiting: byChat.get(chat) ?? [],
        alongside: live.filter((helper) => String(parseMeta(helper.meta)['chat'] ?? MAIN_CHAT) === chat).length,
      }))
    },
    async branch(itemId) {
      const point = rows.chat_item.find((item) => item.id === itemId)
      if (point === undefined) throw new Error('That message is gone.')
      const from = String(parseMeta(point.meta)['chat'] ?? MAIN_CHAT)
      const chat = `c${newId('b').replace(/[^a-z0-9]/gi, '').slice(0, 16)}`
      const ordered = rows.chat_item.filter((item) => String(parseMeta(item.meta)['chat'] ?? MAIN_CHAT) === from).sort((a, b) => a.createdAt - b.createdAt)
      const cut = ordered.findIndex((item) => item.id === point.id)
      const history = ordered.slice(0, cut + 1).filter(
        (item) =>
          ['user', 'agent', 'report', 'notice', 'activity'].includes(item.kind) &&
          parseMeta(item.meta)['helper'] === undefined,
      )
      const first = history.find((item) => item.kind === 'user')
      const title = `Branch: ${(first?.text ?? 'Chat').slice(0, 50)}`
      for (const item of history) {
        insertChat({ kind: item.kind, text: item.text, createdAt: item.createdAt, meta: JSON.stringify({ ...parseMeta(item.meta), chat, copiedFrom: item.id }) })
      }
      insertChat({ kind: 'notice', text: `Branched from "${(first?.text ?? 'Chat').slice(0, 60)}". Everything above is copied; the old chat is unchanged.`, meta: JSON.stringify({ chat, title, branch: true, branchOf: from }) })
      return chat
    },
    async answer(itemId, answer) {
      patchCard(itemId, { answer })
      // Create on a project card makes the project, as project_create does.
      const card = parseMeta(rows.chat_item.find((item) => item.id === itemId)?.meta ?? '{}')['card'] as Record<string, unknown> | undefined
      if (answer === 'Create' && card?.['kind'] === 'project') {
        const made = upsertRow('project', {
          name: String(card['name']),
          description: String(card['description'] ?? ''),
          icon: card['icon'] as ProjectRow['icon'],
          path: String(card['path'] ?? ''),
          profile: 'p_work',
          hidden: false,
          chats: [],
        })
        insertChat({ kind: 'agent', text: `Made ${made.name}. It is in the rail.`, meta: '{}' })
      }
    },
    async decide(itemId, decision: Decision) {
      patchCard(itemId, { decision })
    },
    async tap(itemId, label, message) {
      // A button on the agent's card: no bubble from the person, the button remembers it went, and the agent answers.
      const row = rows.chat_item.find((item) => item.id === itemId)
      if (row === undefined || row.kind !== 'agent') return
      const meta = parseMeta(row.meta)
      const taps = Array.isArray(meta['taps']) ? meta['taps'].filter((t): t is string => typeof t === 'string') : []
      patchCard(itemId, { taps: taps.includes(message) ? taps : [...taps, message] })
      const owner = String(meta['chat'] ?? MAIN_CHAT)
      mockRun(owner, 700, `On it: ${label.trim() === '' ? 'your tap' : label.trim()}. I'll tell you when it's done.`)
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
    async frame() {
      return null
    },
    async go() {
      return undefined
    },
    async newTab() {
      return undefined
    },
    async attach() {
      // The web preview draws the designed demo page; there is no <webview> to attach.
      return false
    },
    async devtools() {
      return undefined
    },
    async people(): Promise<BrowserPerson[]> {
      const own = profiles.filter((p) => !p.general && p.browser === '')
      const signedIn: Record<string, string[]> = { mine: seededApps ? ['sam@example.com'] : [], p_work: seededApps ? ['ana@example.com'] : [] }
      const list: BrowserPerson[] = [
        { id: 'mine', name: 'Mine', color: 'graphite', kind: 'mine', partition: 'persist:agent-browser-mine', google: [], current: false, usedBy: profiles.filter((p) => p.browser === 'mine').map((p) => p.name) },
        { id: 'general', name: 'Agents', color: 'graphite', kind: 'shared', partition: 'persist:agent-browser', google: [], current: false, usedBy: ['The main agent', 'Routines'] },
        ...own.map((p) => ({ id: p.id, name: p.name, color: p.color, kind: 'profile' as const, partition: `persist:agent-browser-${p.id}`, google: [], current: false, usedBy: [p.name] })),
      ]
      return list.map((person) => ({ ...person, google: signedIn[person.id] ?? [], current: person.partition === (mockBrowser.personPartition ?? 'persist:agent-browser-mine') }))
    },
    async usePerson(id: string) {
      mockBrowser.personPartition = id === 'general' ? 'persist:agent-browser' : `persist:agent-browser-${id}`
      notifyBrowser()
    },
    async signOut() {
      return undefined
    },
    async setMuted(on: boolean) {
      mockBrowser.muted = on
      notifyBrowser()
    },
    async setExpanded(on: boolean) {
      mockBrowser.expanded = on
      notifyBrowser()
    },
    async setView(viewMode: BrowserViewMode) {
      mockBrowser.view = { ...MOCK_VIEWS[viewMode] }
      notifyBrowser()
    },
    onState(callback: (state: BrowserState) => void): Unsubscribe {
      browserListeners.add(callback)
      return () => {
        browserListeners.delete(callback)
      }
    },
  },

  helpers: {
    async stop(id) {
      const index = rows.chat_item.findIndex((item) => item.id === id && item.kind === 'helper')
      const current = rows.chat_item[index]
      if (index < 0 || !current) return false
      const meta = parseMeta(current.meta)
      if (meta['state'] !== 'working') return false
      patchCard(id, {
        state: 'stopped',
        summary: 'Stopped',
        endedAt: Date.now(),
        queued: false,
      })
      return true
    },
    async stopAll() {
      const working = rows.chat_item.filter(
        (item) => item.kind === 'helper' && parseMeta(item.meta)['state'] === 'working',
      )
      for (const item of working) {
        patchCard(item.id, {
          state: 'stopped',
          summary: 'Stopped',
          endedAt: Date.now(),
          queued: false,
        })
      }
      return working.length
    },
  },

  apps: {
    async status(): Promise<AppsStatus> {
      return {
        hasKey: appsKeyKind !== '',
        keyKind: appsKeyKind,
        accounts: copy(appsAccounts),
        connecting: [...appsConnecting],
        message: '',
      }
    },
    async setKey(key: string) {
      const value = key.trim()
      if (value === '') {
        appsKeyKind = ''
        appsAccounts = []
        appsConnecting.clear()
        emitApps()
        return { ok: true, message: 'Removed your Composio key.' }
      }
      await delay(400)
      if (value.length < 8) return { ok: false, message: "Composio didn't accept that key. Copy it again from your project's Settings, API Keys." }
      appsKeyKind = value.startsWith('ck_') ? 'consumer' : value.startsWith('uak_') ? 'user' : 'project'
      emitApps()
      return { ok: true, message: 'Your Composio key works. Connect your first app.' }
    },
    async catalog() {
      return copy(MOCK_CATALOG)
    },
    async search(query: string) {
      await delay(300)
      const q = query.trim().toLowerCase()
      const extra = [
        { slug: 'youtube', name: 'YouTube', line: 'Videos, channels and playlists' },
        { slug: 'takealot', name: 'Takealot', line: 'Shopping' },
        { slug: 'xero', name: 'Xero', line: 'Accounting' },
      ]
      return [...MOCK_CATALOG, ...extra].filter((app) => `${app.slug} ${app.name}`.toLowerCase().includes(q))
    },
    async connect(app: string) {
      if (appsKeyKind === '') return { ok: false, message: 'Add your Composio key first.' }
      const id = newId('ca')
      appsConnecting.add(app)
      appsAccounts = [
        ...appsAccounts,
        { id, app, appName: appName(app), label: appName(app), status: 'pending', rules: { read: 'allow', change: 'ask' } },
      ]
      emitApps()
      setTimeout(() => {
        appsConnecting.delete(app)
        appsAccounts = appsAccounts.map((account) =>
          account.id === id ? { ...account, status: 'active', label: 'you@example.com' } : account,
        )
        emitApps()
      }, 1500)
      return { ok: true, message: 'Sign in in your browser. This page updates when it is connected.' }
    },
    async disconnect(accountId: string) {
      const gone = appsAccounts.find((account) => account.id === accountId)
      appsAccounts = appsAccounts.filter((account) => account.id !== accountId)
      profiles = profiles.map((p) => ({ ...p, accounts: p.accounts.filter((a) => a.id !== accountId) }))
      emitProfiles()
      if (gone && !appsAccounts.some((account) => account.app === gone.app && account.status === 'pending')) {
        appsConnecting.delete(gone.app)
      }
      emitApps()
    },
    async setRules(accountId: string, rules: AccountRules) {
      appsAccounts = appsAccounts.map((account) =>
        account.id === accountId ? { ...account, rules: { read: rules.read, change: rules.change } } : account,
      )
      emitApps()
    },
    async learned() {
      return copy(learnedApps)
    },
    async removeLearned(id: string) {
      learnedApps = learnedApps.filter((app) => app.id !== id)
      profiles = profiles.map((p) => ({ ...p, learned: p.learned.filter((x) => x !== id) }))
      emitProfiles()
      emitApps()
    },
    async setTrusted(id: string, trusted: boolean) {
      learnedApps = learnedApps.map((app) => (app.id === id ? { ...app, trusted } : app))
      emitApps()
    },
    onChanged(callback: () => void): Unsubscribe {
      appsListeners.add(callback)
      return () => {
        appsListeners.delete(callback)
      }
    },
  },

  profiles: {
    async list() {
      return copy(profiles)
    },
    async create(draft: ProfileDraft) {
      const name = cleanProfileName(draft.name)
      if (name === '') return { ok: false, message: 'Give the profile a name.' }
      if (profiles.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, message: `There is already a profile called ${name}.` }
      }
      const accounts = (draft.accounts ?? []).map(profileAccount).filter((a): a is ProfileAccount => a !== null)
      const profile: AgentProfileInfo = {
        id: newId('p'),
        name,
        color: draft.color ?? nextProfileColor(),
        accounts,
        learned: (draft.learned ?? []).filter((id) => learnedApps.some((app) => app.id === id)),
        browser: draft.browser ?? '',
        general: false,
      }
      profiles = [...profiles, profile]
      emitProfiles()
      return { ok: true, message: `Made ${name}.`, profile: copy(profile) }
    },
    async update(id: string, patch: Partial<ProfileDraft>) {
      const current = profiles.find((p) => p.id === id)
      if (current === undefined) return { ok: false, message: 'That profile is gone.' }
      const name = patch.name === undefined ? current.name : cleanProfileName(patch.name)
      if (name === '') return { ok: false, message: 'Give the profile a name.' }
      if (current.general && name !== current.name) return { ok: false, message: 'General keeps its name.' }
      if (profiles.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, message: `There is already a profile called ${name}.` }
      }
      const learned = current.general
        ? []
        : patch.learned === undefined
          ? current.learned
          : patch.learned.filter((x) => learnedApps.some((app) => app.id === x))
      const accounts = current.general
        ? []
        : patch.accounts === undefined
          ? current.accounts
          : patch.accounts.map(profileAccount).filter((a): a is ProfileAccount => a !== null)
      profiles = profiles.map((p) =>
        p.id === id
          ? { ...p, name, color: patch.color ?? p.color, accounts, learned, browser: patch.browser ?? p.browser }
          : p,
      )
      emitProfiles()
      return { ok: true, message: 'Saved.' }
    },
    async remove(id: string) {
      if (profiles.find((p) => p.id === id)?.general === true) return
      profiles = profiles
        .filter((p) => p.id !== id)
        .map((p) => (p.browser === id ? { ...p, browser: '' } : p))
      emitProfiles()
    },
    async setMember(profileId: string, accountId: string, member: boolean) {
      const account = profileAccount(accountId)
      profiles = profiles.map((p) => {
        if (p.id !== profileId || p.general) return p
        const rest = p.accounts.filter((a) => a.id !== accountId)
        return { ...p, accounts: member && account !== null ? [...rest, account] : rest }
      })
      emitProfiles()
    },
    onChanged(callback: () => void): Unsubscribe {
      profileListeners.add(callback)
      return () => {
        profileListeners.delete(callback)
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
    onRoute(_callback: (target: RouteTarget) => void): Unsubscribe {
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
      // A pasted screenshot has no file on disk (Electron gives ''), so it is saved first, as in the app.
      return files.map((file) => (file.name === 'image.png' ? '' : `C:\\Users\\You\\Downloads\\${file.name}`))
    },
    async pickFolder() {
      return 'C:\\Users\\You\\Documents'
    },
    async savePasted(name, mime, bytes) {
      const safe = name.replace(/[\\/:*?"<>|]/g, '-') || 'Pasted image.png'
      const path = `C:\\Users\\You\\AppData\\Roaming\\Agent\\attachments\\${safe}`
      if (mime.startsWith('image/')) {
        try {
          let binary = ''
          for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
          pastedPreviews.set(path, `data:${mime};base64,${btoa(binary)}`)
        } catch {
          // A preview is a nicety in the browser preview.
        }
      }
      return { path, name: safe, mime, size: bytes.byteLength }
    },
    async clipboardFiles() {
      return []
    },
    async thumbnail(path) {
      const pasted = pastedPreviews.get(path)
      if (pasted !== undefined) return pasted
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

  environment: {
    async scan(): Promise<EnvironmentReport> {
      return {
        os: { platform: 'win32', release: '10.0.22631', arch: 'x64', hostname: 'This computer' },
        shells: [
          { id: 'pwsh', label: 'PowerShell 7', found: false },
          {
            id: 'powershell',
            label: 'Windows PowerShell',
            found: true,
            path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
            version: '5.1.22621.1',
            kind: 'exe',
          },
          {
            id: 'cmd',
            label: 'Command Prompt',
            found: true,
            path: 'C:\\Windows\\System32\\cmd.exe',
            kind: 'exe',
          },
        ],
        runtimes: [
          {
            id: 'node',
            label: 'Node',
            found: true,
            path: 'C:\\Program Files\\nodejs\\node.exe',
            version: '20.11.1',
            kind: 'exe',
          },
          { id: 'python', label: 'Python', found: true, path: 'C:\\Python312\\python.exe', version: '3.12.4', kind: 'exe' },
          { id: 'git', label: 'Git', found: true, path: 'C:\\Program Files\\Git\\cmd\\git.exe', version: '2.43.0', kind: 'exe' },
        ],
        aiTools: [
          { id: 'claude', label: 'Claude Code', found: true, path: 'C:\\Users\\You\\AppData\\Roaming\\npm\\claude.cmd', version: '1.0.60', kind: 'cmd' },
          { id: 'opencode', label: 'OpenCode', found: true, path: 'C:\\Users\\You\\AppData\\Roaming\\npm\\opencode.cmd', version: '0.4.5', kind: 'cmd' },
          { id: 'gemini', label: 'Gemini CLI', found: false },
          { id: 'codex', label: 'Codex', found: false },
          { id: 'antigravity', label: 'Antigravity', found: false },
        ],
        notes: [],
        scannedAt: Date.now(),
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

  voice: mockVoice({
    settings: () => settings,
    save: (patch) => {
      saveSettings(patch)
    },
    insertChat: (item) => insertChat(item),
    send: (text) => mockAgent.chat.send(text),
  }),

  ...mockHotkeys(() => settings),
  memory: {
    async newChat(target) {
      const chatOfRow = (item: ChatItem): string => String(parseMeta(item.meta)['chat'] ?? MAIN_CHAT)
      const tag = target === undefined || target.chat === MAIN_CHAT ? {} : { chat: target.chat }
      const list = rows.chat_item
        .filter((item) => item.kind !== 'branch' && (target === undefined || chatOfRow(item) === target.from))
        .sort((a, b) => b.createdAt - a.createdAt)
      const latest = target === undefined ? list[0] : rows.chat_item.find((item) => chatOfRow(item) === target.chat)
      if (latest !== undefined && latest.kind === 'notice' && parseMeta(latest.meta)['divider'] === true) {
        return { dividerId: latest.id, saving: false }
      }
      const hasChat = list.some((item) => item.kind === 'user')
      // The main thread's New chat carries on with a summary of itself (memory/service.ts compressChat).
      const inPlace = target === undefined || target.chat === target.from
      const meta: Record<string, unknown> = { divider: true, at: Date.now(), ...tag, ...(inPlace && hasChat ? { compress: 'pending' } : {}) }
      if (hasChat) meta['memory'] = { chat: 'mock-chat', status: 'saving' }
      const divider = insertChat({ kind: 'notice', text: 'New chat', meta: JSON.stringify(meta) })
      if (inPlace && hasChat) {
        setTimeout(() => {
          patchCard(divider.id, {
            compress: 'done',
            carry: '**Working on**\n- Durban trip on Fri 30 Oct: flights and a guesthouse.\n\n**Decided**\n- SkyHop 06:05 at R 899, the best value.\n\n**Asked last**\n- Hold the 06:05 and check a window seat back.',
          })
        }, 700)
      }
      if (hasChat) {
        setTimeout(() => {
          const saved = rows.memory.filter((row) => !row.pinned).slice(0, 3).map((row) => row.id)
          patchCard(divider.id, {
            memory: { chat: 'mock-chat', status: 'done', saved, added: 1, updated: saved.length - 1 },
            summary: 'Planned the Lisbon trip and settled on the TAP direct flight.',
          })
        }, 1200)
      }
      return { dividerId: divider.id, saving: hasChat }
    },
    async retrySave(id) {
      patchCard(id, { memory: { chat: 'mock-chat', status: 'saving' } })
      setTimeout(() => patchCard(id, { memory: { chat: 'mock-chat', status: 'done', saved: [], added: 0, updated: 0 } }), 800)
    },
    async pickImport() {
      return { path: 'memory-bank-export.json', name: 'memory-bank-export.json' }
    },
    async previewImport(_path, includeAll) {
      return mockImportPreview(includeAll)
    },
    async runImport(_path, includeAll) {
      await delay(900)
      const preview = mockImportPreview(includeAll)
      const total = Object.values(preview.byKind).reduce((sum, n) => sum + (n ?? 0), 0)
      return { ...preview, added: total, updated: 0, unchanged: 0, deletedHere: 0, redacted: 7, ms: 840, message: `${total.toLocaleString('en')} added, 0 updated, 0 already here.` }
    },
    async searchChats() {
      return []
    },
    async runDaily() {
      await delay(900)
      mockUpkeep = mockUpkeepReport()
      for (const listener of upkeepListeners) listener(mockUpkeep)
      return mockUpkeep
    },
    async upkeep() {
      return { report: mockUpkeep, lastRunAt: mockUpkeep?.at ?? 0, history: [] }
    },
    async history(memoryId: string) {
      return copy([...(mockVersions.get(memoryId) ?? [])].reverse())
    },
    async restoreVersion(memoryId: string, n: number) {
      const version = mockVersions.get(memoryId)?.find((each) => each.n === n)
      const current = rows.memory.find((row) => row.id === memoryId)
      if (version === undefined || version.deleted || current === undefined) return false
      const before = copy(current)
      const after = upsertRow('memory', { id: memoryId, title: version.title, body: version.body, kind: version.kind, topics: version.topics, status: version.status, aliases: version.aliases, pinned: version.pinned, updatedAt: Date.now() })
      keepMockVersion(before, after, 'you', `restored version ${n}`)
      return true
    },
    async undoChange(id) {
      const change = mockUpkeep?.changes.find((item) => item.id === id)
      if (change === undefined || change.undone === true) return false
      change.undone = true
      for (const listener of upkeepListeners) listener(mockUpkeep)
      return true
    },
    onUpkeep(callback) {
      upkeepListeners.add(callback)
      return () => {
        upkeepListeners.delete(callback)
      }
    },
    async previewTidy(_path, includeAll) {
      return mockTidyPlan(includeAll)
    },
    async startTidy(_path, includeAll) {
      const plan = mockTidyPlan(includeAll)
      const resume = mockTidy !== null && !mockTidy.finished && mockTidy.steps === plan.steps
      mockTidy = {
        running: true,
        finished: false,
        source: plan.source,
        project: TIDY_PROJECTS[0] ?? '',
        projectIndex: 1,
        projects: plan.projects,
        steps: plan.steps,
        done: resume && mockTidy !== null ? mockTidy.done : 0,
        failed: 0,
        added: resume && mockTidy !== null ? mockTidy.added : 0,
        updated: resume && mockTidy !== null ? mockTidy.updated : 0,
        errors: [],
        startedAt: Date.now(),
        finishedAt: null,
        canUndo: true,
        message: 'Getting ready.',
      }
      if (mockTidyTimer !== null) clearInterval(mockTidyTimer)
      mockTidyTimer = setInterval(() => {
        if (mockTidy === null) return
        const done = Math.min(mockTidy.steps, mockTidy.done + 6)
        const index = Math.min(TIDY_PROJECTS.length - 1, Math.floor((done / mockTidy.steps) * TIDY_PROJECTS.length))
        const project = TIDY_PROJECTS[index] ?? ''
        const failed = done >= 60 ? 1 : 0
        mockTidy = {
          ...mockTidy,
          done,
          failed,
          added: Math.round(done * 2.1),
          updated: Math.round(done * 1.3),
          project,
          projectIndex: index + 1,
          errors: failed > 0 ? [{ project: 'crm-1', error: 'The model took too long to answer.' }] : [],
          message: `Reading ${project}, part 1 of 2.`,
        }
        if (done >= mockTidy.steps) {
          stopMockTidy('Done, but 1 step failed. Start again to retry it.')
          mockTidy = { ...mockTidy, finished: true, finishedAt: Date.now() }
        }
        emitTidy()
      }, 300)
      emitTidy()
      return { ...mockTidy }
    },
    async stopTidy() {
      stopMockTidy('Stopped. Start again to carry on where it stopped.')
      emitTidy()
      if (mockTidy === null) throw new Error('Nothing is being tidied.')
      return { ...mockTidy }
    },
    async tidyState() {
      return mockTidy === null ? null : { ...mockTidy }
    },
    async undoTidy() {
      stopMockTidy('')
      const removed = mockTidy?.added ?? 0
      const restored = mockTidy?.updated ?? 0
      mockTidy = null
      return { removed, restored }
    },
    onTidy(callback) {
      tidyListeners.add(callback)
      return () => {
        tidyListeners.delete(callback)
      }
    },
  },

  app: {
    async info() {
      return {
        name: 'Agent',
        version: '0.0.0',
        platform: 'web',
        electron: 'browser',
        logsPath: '',
        licencesUrl: '',
      }
    },
    async openLogsFolder() {
      return undefined
    },
    async openLicences() {
      return undefined
    },
  },
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let mockUpkeep: UpkeepReport | null = null
const upkeepListeners = new Set<(report: UpkeepReport | null) => void>()

// Tidying a bank with the agent, simulated: the real export's numbers, a few steps a tick so the states show.
const TIDY_PROJECTS = ['aos', 'crm-1', 'creek', 'growos', 'applications', 'lender-ls', 'agency', 'studycvns', 'rmblr', 'shop-website', 'londacorp-erp']
let mockTidy: MemoryTidyProgress | null = null
let mockTidyTimer: ReturnType<typeof setInterval> | null = null
const tidyListeners = new Set<(progress: MemoryTidyProgress) => void>()

function mockTidyPlan(includeAll: boolean): MemoryTidyPlan {
  return includeAll
    ? { ok: true, message: '4,562 notes in 27 projects, read in 236 steps.', source: 'A.O.S Memory Bank', notes: 4562, projects: 27, steps: 236, chars: 9_695_241, olderState: 0, retired: 0 }
    : { ok: true, message: '1,717 notes in 25 projects, read in 110 steps.', source: 'A.O.S Memory Bank', notes: 1717, projects: 25, steps: 110, chars: 4_104_229, olderState: 754, retired: 2091 }
}

function emitTidy(): void {
  if (mockTidy === null) return
  const snapshot = { ...mockTidy, errors: [...mockTidy.errors] }
  for (const listener of tidyListeners) listener(snapshot)
}

function stopMockTidy(message: string): void {
  if (mockTidyTimer !== null) clearInterval(mockTidyTimer)
  mockTidyTimer = null
  if (mockTidy !== null) mockTidy = { ...mockTidy, running: false, message }
}

function mockImportPreview(includeAll: boolean): MemoryImportPreview {
  const byKind: MemoryImportPreview['byKind'] = includeAll
    ? { decision: 721, fact: 865, 'how-to': 566, person: 29, project: 24, organisation: 5, event: 2352 }
    : { decision: 464, fact: 553, 'how-to': 465, person: 28, project: 24, organisation: 5 }
  return {
    ok: true,
    message: 'From the A.O.S Memory Bank.',
    source: 'A.O.S Memory Bank',
    total: 4562,
    byKind,
    skippedRetired: includeAll ? 0 : 2091,
    skippedTransient: includeAll ? 0 : 932,
    invalid: 0,
  }
}

function mockUpkeepReport(): UpkeepReport {
  const at = Date.now()
  const page = (id: string): EntityMap['memory'] | null => rows.memory.find((row) => row.id === id) ?? null
  const change = (action: UpkeepChange['action'], memoryId: string, title: string, reason: string): UpkeepChange => ({
    id: `chg-${memoryId}-${action}`,
    at,
    action,
    memoryId,
    title,
    reason,
    before: page(memoryId),
  })
  return {
    at,
    trigger: 'manual',
    ok: true,
    message: '"Where we are" updated from 3 chats, 2 pages filed, 1 merged, 1 rewritten, 2 dropped.',
    day: new Date(at).toISOString().slice(0, 10),
    chats: 3,
    filed: 2,
    merged: 1,
    rewritten: 1,
    dropped: 2,
    changes: [
      change('where', 'where-we-are', 'Where we are', 'Compiled from 3 chats today'),
      change('filed', 'm9', 'Fly TAP direct to Lisbon', 'New page from today'),
      change('filed', 'm7', 'Lisbon trip', 'Updated from today'),
      change('merged', 'm2', 'Lerato', 'Merged 1 near-duplicate page into it'),
      change('rewritten', 'm6', 'Invoice day', 'The send date moved to the 26th'),
      change('dropped', 'big-m3', 'Checking flights now', 'Progress note, only true that day'),
      change('dropped', 'm-dup', 'lerato', 'Duplicate of "Lerato"'),
    ],
  }
}
