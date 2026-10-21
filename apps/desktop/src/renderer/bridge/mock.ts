import { DEFAULT_SETTINGS, GENERAL_PROFILE, PROFILE_COLORS, PROVIDERS } from '@agent/core'
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
  UpkeepChange,
  UpkeepReport,
} from '@agent/core'

import { mockVoice } from '../voice/mock-voice'
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
    async tap(itemId, label, message) {
      // A button on the agent's card: no bubble from the person, the button remembers it went, and the agent answers.
      const row = rows.chat_item.find((item) => item.id === itemId)
      if (row === undefined || row.kind !== 'agent') return
      const meta = parseMeta(row.meta)
      const taps = Array.isArray(meta['taps']) ? meta['taps'].filter((t): t is string => typeof t === 'string') : []
      patchCard(itemId, { taps: taps.includes(message) ? taps : [...taps, message] })
      running = true
      runState.running = true
      emitChat({ type: 'run_started' })
      clearChatTimers()
      agentTimer = setTimeout(() => {
        insertChat({ kind: 'agent', text: `On it: ${label.trim() === '' ? 'your tap' : label.trim()}. I'll tell you when it's done.`, meta: '{}' })
        running = false
        runState.running = false
        agentTimer = null
        emitChat({ type: 'run_finished' })
      }, 700)
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
    async devtools() {
      return undefined
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
    async newChat() {
      const list = rows.chat_item.filter((item) => item.kind !== 'branch').sort((a, b) => b.createdAt - a.createdAt)
      const latest = list[0]
      if (latest !== undefined && latest.kind === 'notice' && parseMeta(latest.meta)['divider'] === true) {
        return { dividerId: latest.id, saving: false }
      }
      const hasChat = list.some((item) => item.kind === 'user')
      const meta: Record<string, unknown> = { divider: true, at: Date.now() }
      if (hasChat) meta['memory'] = { chat: 'mock-chat', status: 'saving' }
      const divider = insertChat({ kind: 'notice', text: 'New chat', meta: JSON.stringify(meta) })
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
