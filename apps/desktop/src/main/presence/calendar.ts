/**
 * The person's calendars, for the presence note on his messages (presence/presence.ts).
 *
 * Read from the calendars he connected through Connections (Composio: Google Calendar, Outlook), found from his
 * accounts each time, never named in code. Read rarely and cached: once at start, every 20 minutes, and just after an
 * event in the cache ends, never once per message. When nothing is connected or a read fails, there is simply no
 * calendar line. A test copy can point AGENT_FAKE_CALENDAR at a JSON file of events instead (no accounts touched).
 */
import { readFileSync } from 'node:fs'

import type { AccountRules, JsonObject } from '@agent/core'

/** One meeting on one of his calendars. Times are epoch ms. */
export interface CalendarEvent {
  /** The calendar's own id for the event ('' when it has none). */
  id: string
  title: string
  start: number
  end: number
  /** Where it happens: an online meeting kind (Google Meet, Teams, Zoom) or a place. '' when none. */
  where: string
  /** Which calendar app it came from (googlecalendar, outlook, file). */
  source: string
  /** The link to join it online (Teams, Meet, Zoom), '' when there is none. */
  joinUrl?: string
  /** Who organised it. self: he did. Null when the calendar does not say. */
  organiser?: { name: string; email: string; self: boolean } | null
  /** His own answer to it. 'none' when there is nothing to answer (no invitation). */
  response?: CalendarResponse
  /** The connected calendar account it was read from (its email), so personal and work can be told apart. '' when unknown. */
  account?: string
}

export type CalendarResponse = 'accepted' | 'tentative' | 'declined' | 'needsAction' | 'none'

/** Something that reads his calendars for a window of time. Null: no calendar is connected. Throws when it cannot read. */
export interface CalendarSource {
  events(from: number, to: number): Promise<CalendarEvent[] | null>
  /** True when the last events() read some calendars but not all (the cache then tries again soon). */
  incomplete?(): boolean
}

// ---- Composio (the connectors already in use) -----------------------------------------------------------

/** What the calendar reader needs from AppsService: his accounts in some apps, and running one action. */
export interface CalendarApps {
  /** label: who the account signed in as, when Connections knows it (often its email). */
  activeAccounts(apps: string[]): Promise<Array<{ id: string; app: string; label?: string }>>
  backend(): { execute(slug: string, args: JsonObject, account: string | null): Promise<{ ok: boolean; text: string }> } | null
  /** The per-account rules he set in Connections. Only accounts he lets agents read without asking are read. */
  rulesFor?(accountId: string): AccountRules
}

export const CALENDAR_APPS = ['googlecalendar', 'outlook'] as const

/** Every connected calendar account, read in one call each. No account: no events (and no error). */
export function composioCalendarSource(apps: CalendarApps, log: (message: string, detail?: Record<string, unknown>) => void = () => undefined, now: () => number = Date.now): CalendarSource {
  let partial = false
  // Which email each account is, learned once and kept (an Outlook reply does not say whose calendar it is).
  const emails = new Map<string, string>()
  const askedProfileAt = new Map<string, number>()
  type Backend = NonNullable<ReturnType<CalendarApps['backend']>>
  const remember = (id: string, email: string): string => {
    emails.set(id, email)
    return email
  }
  const outlookEmail = async (backend: Backend, account: { id: string; label?: string }, events: CalendarEvent[]): Promise<string> => {
    const known = emails.get(account.id)
    if (known !== undefined) return known
    const label = emailIn(account.label)
    if (label !== '') return remember(account.id, label)
    const asked = askedProfileAt.get(account.id)
    if (asked === undefined || now() - asked > PROFILE_RETRY_MS) {
      askedProfileAt.set(account.id, now())
      try {
        const result = await backend.execute(OUTLOOK_PROFILE.slug, OUTLOOK_PROFILE.args, account.id)
        const reply = unwrapComposio(result.text)
        const found = result.ok && reply.ok ? profileEmail(reply.data) : ''
        if (found !== '') return remember(account.id, found)
        log('Calendar account email not read', { account: account.id, error: (reply.error ?? result.text).slice(0, 200) })
      } catch (error) {
        log('Calendar account email not read', { account: account.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    // Last: the organiser of a meeting he organised is him.
    return events.find((event) => event.organiser?.self === true && event.organiser.email !== '')?.organiser?.email.toLowerCase() ?? ''
  }
  return {
    incomplete: () => partial,
    async events(from, to) {
      partial = false
      const backend = apps.backend()
      if (backend === null) return null
      const accounts = (await apps.activeAccounts([...CALENDAR_APPS])).filter(
        (account) => (CALENDAR_APPS as readonly string[]).includes(account.app.toLowerCase()) && (apps.rulesFor?.(account.id).read ?? 'allow') === 'allow',
      )
      if (accounts.length === 0) return null
      const found: CalendarEvent[] = []
      let failures = 0
      let partialRead = false
      for (const account of accounts) {
        const app = account.app.toLowerCase()
        const replies: Array<{ data: unknown; text: string }> = []
        /** Reads one span; a reply Connect cut short is read again as two halves. Returns the error, or null. */
        const readSpan = async (start: number, end: number, depth: number): Promise<string | null> => {
          const call = app === 'outlook' ? outlookCall(start, end) : googleCall(start, end)
          const result = await backend.execute(call.slug, call.args, account.id)
          const reply = unwrapComposio(result.text)
          if (!result.ok || !reply.ok) return reply.error ?? result.text
          if (reply.cut === true) {
            // Too big to come back whole: Connect sent a preview (events cut short). Halves are smaller; past the
            // last split keep what came and try again soon.
            if (depth === 0) log('Calendar reply was cut short', { account: account.id, app, bytes: result.text.length, days: Math.round((end - start) / 86_400_000) })
            if (depth < CUT_SPLITS && end - start > CUT_MIN_SPAN_MS) {
              const mid = start + Math.floor((end - start) / 2)
              return (await readSpan(start, mid, depth + 1)) ?? (await readSpan(mid, end, depth + 1))
            }
            partialRead = true
          }
          replies.push({ data: reply.data, text: result.text })
          return null
        }
        try {
          const error = await readSpan(from, to, 0)
          if (error !== null) {
            failures += 1
            log('Calendar read failed', { account: account.id, app, error: error.slice(0, 300) })
            continue
          }
          const key = app === 'outlook' ? 'value' : 'items'
          const listed = replies.reduce((sum, each) => sum + findList(each.data, key).length, 0)
          // A meeting across the line between two halves comes back in both: once.
          const ids = new Set<string>()
          const events = replies
            .flatMap((each) => (app === 'outlook' ? parseOutlookData(each.data) : parseGoogleData(each.data)))
            .filter((event) => event.id === '' || (!ids.has(event.id) && ids.add(event.id) !== undefined))
          // Which account: Google names a primary calendar after its account's email; Outlook is asked once.
          const email =
            app === 'outlook'
              ? await outlookEmail(backend, account, events)
              : replies.map((each) => emailIn(listHolder(each.data, 'items')['summary'])).find((one) => one !== '') || emailIn(account.label) || emails.get(account.id) || ''
          if (app !== 'outlook' && email !== '') remember(account.id, email)
          for (const event of events) event.account = email
          // A list came back but nothing was kept, or no list at all: say so, so a new reply shape is never a silent empty calendar.
          if (events.length === 0 && (listed > 0 || !replies.some((each) => hasList(each.data, key)))) {
            log('Calendar reply kept no meetings', { account: account.id, app, listed, reply: (replies[0]?.text ?? '').slice(0, 300) })
          }
          found.push(...events)
        } catch (error) {
          failures += 1
          log('Calendar read failed', { account: account.id, app, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (failures === accounts.length) throw new Error('No calendar could be read.')
      partial = failures > 0 || partialRead
      return found
    },
  }
}

/** An Outlook profile read that failed is tried again after this long (not on every calendar read). */
const PROFILE_RETRY_MS = 6 * 60 * 60_000
/** Who the Outlook account is (Microsoft Graph /me). */
const OUTLOOK_PROFILE = { slug: 'OUTLOOK_GET_PROFILE', args: { user_id: 'me' } as JsonObject }

function profileEmail(data: unknown): string {
  return emailIn(findValue(data, ['mail', 'userPrincipalName', 'emailAddress', 'email']))
}

/** The first of these keys holding an email, however deep the reply wrapped it. */
function findValue(value: unknown, keys: string[], depth = 0): string {
  if (depth > 6 || typeof value !== 'object' || value === null || Array.isArray(value)) return ''
  const obj = value as Record<string, unknown>
  for (const key of keys) if (emailIn(obj[key]) !== '') return obj[key] as string
  for (const inner of Object.values(obj)) {
    const found = findValue(typeof inner === 'string' && inner.trim().startsWith('{') ? parseJson(inner) : inner, keys, depth + 1)
    if (found !== '') return found
  }
  return ''
}

/** The text when it is an email address (lower case), else ''. */
function emailIn(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text.toLowerCase() : ''
}

/**
 * A cut-short reply is read again as two halves, each half again if it is cut too, at most this many times deep and
 * never below a day (his real Outlook week with join links and organisers: 17 meetings, 19.7 KB, still whole).
 */
const CUT_SPLITS = 5
const CUT_MIN_SPAN_MS = 24 * 60 * 60_000

/**
 * Only the fields the note reads. Composio Connect saves a reply over a few thousand tokens to its own sandbox and
 * sends back only a preview, with each event cut short (29 Oct 2026: his Outlook week, 9,343 tokens), so asking for
 * less is what keeps the meetings in the reply.
 */
const GOOGLE_FIELDS =
  'summary,items(id,status,summary,start,end,attendees(self,responseStatus),organizer(email,displayName,self),hangoutLink,conferenceData(conferenceSolution/name,entryPoints(entryPointType,uri)),location),nextPageToken'
const OUTLOOK_SELECT = [
  'id',
  'subject',
  'start',
  'end',
  'isAllDay',
  'isCancelled',
  'responseStatus',
  'onlineMeetingProvider',
  'onlineMeeting',
  'onlineMeetingUrl',
  'organizer',
  'isOrganizer',
  'location',
]

function googleCall(from: number, to: number): { slug: string; args: JsonObject } {
  return {
    slug: 'GOOGLECALENDAR_EVENTS_LIST',
    args: {
      calendarId: 'primary',
      timeMin: new Date(from).toISOString(),
      timeMax: new Date(to).toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 100,
      fields: GOOGLE_FIELDS,
    },
  }
}

function outlookCall(from: number, to: number): { slug: string; args: JsonObject } {
  // Asked in UTC, so the times that come back (no offset of their own) are read as UTC.
  return {
    slug: 'OUTLOOK_GET_CALENDAR_VIEW',
    args: { start_datetime: new Date(from).toISOString(), end_datetime: new Date(to).toISOString(), timezone: 'UTC', top: 100, select: OUTLOOK_SELECT },
  }
}

/**
 * What a Composio reply really says. Composio Connect (COMPOSIO_MULTI_EXECUTE_TOOL) wraps the app's answer as
 * {successful, data: {results: [{response: {successful, data, error}}]}}; the REST API answers {successful, data}.
 * ok is false when either layer says it failed (or the text is an "Error:" or not JSON); data is the app's own answer.
 */
export function unwrapComposio(text: string): { ok: boolean; data: unknown; error?: string; cut?: boolean } {
  const failed = text.trimStart().startsWith('Error:')
  const parsed = parseJson(failed ? text.trimStart().slice(6) : text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false, data: null, error: text.slice(0, 300) || 'empty reply' }
  const outer = parsed as Record<string, unknown>
  const results = record(outer['data'])['results']
  if (Array.isArray(results) && results.length > 0) {
    const first = record(results[0])
    const inner = 'response' in first ? record(first['response']) : first
    const error = errorText(inner['error']) || errorText(first['error']) || errorText(outer['error'])
    if (failed || inner['successful'] === false || outer['successful'] === false) return { ok: false, data: inner['data'] ?? null, error: error || 'Composio said the call failed' }
    // A big reply: the whole of it went to Connect's sandbox file and only a cut preview came back.
    const cut = !('data' in inner) && ('data_preview' in inner || 'remote_file_info' in record(outer['data']))
    if (cut) return { ok: true, data: inner['data_preview'] ?? null, cut: true }
    return { ok: true, data: inner['data'] ?? inner }
  }
  if (failed || outer['successful'] === false) return { ok: false, data: outer['data'] ?? null, error: errorText(outer['error']) || 'Composio said the call failed' }
  return { ok: true, data: 'data' in outer ? outer['data'] : outer }
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, 300)
  if (typeof value === 'object' && value !== null) return JSON.stringify(value).slice(0, 300)
  return ''
}

/** Google Calendar events (items[]), without all-day or cancelled ones. Declined ones stay, marked declined. */
export function parseGoogle(text: string): CalendarEvent[] {
  const reply = unwrapComposio(text)
  return reply.ok ? parseGoogleData(reply.data) : []
}

function parseGoogleData(data: unknown): CalendarEvent[] {
  const out: CalendarEvent[] = []
  for (const item of findList(data, 'items')) {
    if (item['status'] === 'cancelled') continue
    const start = record(item['start'])
    const end = record(item['end'])
    // All-day entries (a date, no time) are days off and reminders, not meetings.
    if (typeof start['dateTime'] !== 'string' || typeof end['dateTime'] !== 'string') continue
    const attendees = Array.isArray(item['attendees']) ? (item['attendees'] as unknown[]).map(record) : []
    const me = attendees.find((one) => one['self'] === true)
    const organizer = record(item['organizer'])
    const startAt = Date.parse(start['dateTime'])
    const endAt = Date.parse(end['dateTime'])
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) continue
    const conference = record(record(item['conferenceData'])['conferenceSolution'])
    const where =
      typeof item['hangoutLink'] === 'string' && item['hangoutLink'] !== ''
        ? 'Google Meet'
        : typeof conference['name'] === 'string'
          ? conference['name']
          : typeof item['location'] === 'string'
            ? onlineKind(item['location'])
            : ''
    const points = record(item['conferenceData'])['entryPoints']
    const video = (Array.isArray(points) ? points : []).map(record).find((point) => point['entryPointType'] === 'video' && /^https:\/\//.test(text0(point['uri'])))
    const location = text0(item['location']).trim()
    const joinUrl = text0(item['hangoutLink']) || text0(video?.['uri']) || (/^https:\/\/\S+$/.test(location) ? location : '')
    const response: CalendarResponse =
      me !== undefined ? googleResponse(me['responseStatus']) : organizer['self'] === true ? 'accepted' : attendees.length === 0 ? 'none' : 'needsAction'
    out.push({
      id: text0(item['id']),
      title: text0(item['summary']) || '(no title)',
      start: startAt,
      end: endAt,
      where,
      source: 'googlecalendar',
      joinUrl,
      organiser: organiserOf(text0(organizer['displayName']), text0(organizer['email']), organizer['self'] === true),
      response,
      account: '',
    })
  }
  return out
}

/** Outlook calendar view (value[]), without all-day or cancelled ones. Declined ones stay, marked declined. */
export function parseOutlook(text: string): CalendarEvent[] {
  const reply = unwrapComposio(text)
  return reply.ok ? parseOutlookData(reply.data) : []
}

function parseOutlookData(data: unknown): CalendarEvent[] {
  const out: CalendarEvent[] = []
  for (const item of findList(data, 'value')) {
    if (item['isCancelled'] === true || item['isAllDay'] === true) continue
    const startAt = outlookTime(record(item['start']))
    const endAt = outlookTime(record(item['end']))
    if (startAt === null || endAt === null || endAt <= startAt) continue
    const online = record(item['onlineMeeting'])
    const provider = text0(item['onlineMeetingProvider'])
    const where =
      typeof online['joinUrl'] === 'string' && online['joinUrl'] !== ''
        ? onlineKind(online['joinUrl']) || 'Teams'
        : provider === 'teamsForBusiness'
          ? 'Teams'
          : onlineKind(text0(record(item['location'])['displayName']))
    const organizer = record(record(item['organizer'])['emailAddress'])
    const place = text0(record(item['location'])['displayName']).trim()
    const joinUrl = text0(online['joinUrl']) || text0(item['onlineMeetingUrl']) || (/^https:\/\/\S+$/.test(place) ? place : '')
    out.push({
      id: text0(item['id']),
      title: text0(item['subject']) || '(no title)',
      start: startAt,
      end: endAt,
      where,
      source: 'outlook',
      joinUrl,
      organiser: organiserOf(text0(organizer['name']), text0(organizer['address']), item['isOrganizer'] === true),
      response: outlookResponse(text0(record(item['responseStatus'])['response']), item['isOrganizer'] === true),
      account: '',
    })
  }
  return out
}

function organiserOf(name: string, email: string, self: boolean): CalendarEvent['organiser'] {
  return name === '' && email === '' ? null : { name, email: email.toLowerCase(), self }
}

/** Google's answer for him: accepted, tentative, declined, needsAction. */
function googleResponse(value: unknown): CalendarResponse {
  return value === 'accepted' || value === 'tentative' || value === 'declined' || value === 'needsAction' ? value : 'none'
}

/** Outlook's answer for him, in the same words as Google's. A meeting he organised counts as accepted. */
function outlookResponse(value: string, organiser: boolean): CalendarResponse {
  if (value === 'organizer' || (organiser && (value === '' || value === 'none'))) return 'accepted'
  if (value === 'accepted' || value === 'declined') return value
  if (value === 'tentativelyAccepted') return 'tentative'
  if (value === 'notResponded') return 'needsAction'
  return 'none'
}

function outlookTime(value: Record<string, unknown>): number | null {
  const raw = text0(value['dateTime'])
  if (raw === '') return null
  const zone = text0(value['timeZone'])
  // No offset of its own: it is in the zone it names; we asked for UTC.
  const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw)
  const stamp = Date.parse(hasOffset || (zone !== '' && zone.toUpperCase() !== 'UTC') ? raw : `${raw.replace(/(\.\d{3})\d+$/, '$1')}Z`)
  return Number.isFinite(stamp) ? stamp : null
}

/** "Google Meet", "Teams", "Zoom" from a link or a place, else the place itself (short). */
function onlineKind(place: string): string {
  const lower = place.toLowerCase()
  if (lower.includes('meet.google.')) return 'Google Meet'
  if (lower.includes('teams.microsoft.') || lower.includes('teams.live.')) return 'Teams'
  if (lower.includes('zoom.us')) return 'Zoom'
  if (/^https?:\/\//.test(lower)) return 'online'
  return place.trim().slice(0, 60)
}

/**
 * The first array of objects under `key`, however deep Composio wrapped it (data.items, data.response_data.value,
 * data.results[0].response.data.items...). It looks inside arrays of objects too, and inside JSON held as a string.
 */
function findList(value: unknown, key: string): Array<Record<string, unknown>> {
  const direct = listHolder(value, key)[key]
  return Array.isArray(direct) ? direct.filter((each) => typeof each === 'object' && each !== null).map(record) : []
}

/** The object holding the first `key` list of objects (the app's own reply: Google's summary sits beside items). */
function listHolder(value: unknown, key: string, depth = 0): Record<string, unknown> {
  if (depth > 8 || typeof value !== 'object' || value === null) return {}
  if (Array.isArray(value)) {
    for (const each of value.slice(0, 20)) {
      const found = listHolder(each, key, depth + 1)
      if (key in found) return found
    }
    return {}
  }
  const obj = value as Record<string, unknown>
  const direct = obj[key]
  if (Array.isArray(direct) && direct.some((each) => typeof each === 'object' && each !== null)) return obj
  for (const inner of Object.values(obj)) {
    const found = listHolder(typeof inner === 'string' && inner.trim().startsWith('{') ? parseJson(inner) : inner, key, depth + 1)
    if (key in found) return found
  }
  return {}
}

/** Whether the reply holds a `key` list at all (an empty calendar has one, with nothing in it). */
function hasList(value: unknown, key: string, depth = 0): boolean {
  if (depth > 8 || typeof value !== 'object' || value === null) return false
  if (Array.isArray(value)) return value.slice(0, 20).some((each) => hasList(each, key, depth + 1))
  const obj = value as Record<string, unknown>
  if (Array.isArray(obj[key])) return true
  return Object.values(obj).some((inner) => hasList(typeof inner === 'string' && inner.trim().startsWith('{') ? parseJson(inner) : inner, key, depth + 1))
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text0(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ---- a file of events (test copies) --------------------------------------------------------------------

/**
 * Events from a JSON file: [{id, title, start, end, where?}] with ISO times. Read on every refresh, so a test can
 * change it while the app runs. Used only when AGENT_FAKE_CALENDAR names a file.
 */
export function fileCalendarSource(path: string): CalendarSource {
  return {
    async events(from, to) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown
      const list = Array.isArray(raw) ? raw : []
      return list
        .map(record)
        .map((item): CalendarEvent => ({
          id: text0(item['id']),
          title: text0(item['title']) || '(no title)',
          start: Date.parse(text0(item['start'])),
          end: Date.parse(text0(item['end'])),
          where: text0(item['where']),
          // A test file may say which calendar app each event is from (a proof of several calendars in one view).
          source: text0(item['source']) || 'file',
          joinUrl: text0(item['joinUrl']),
          organiser: organiserOf(text0(record(item['organiser'])['name']), text0(record(item['organiser'])['email']), record(item['organiser'])['self'] === true),
          response: googleResponse(item['response']),
          account: text0(item['account']),
        }))
        .filter((event) => Number.isFinite(event.start) && Number.isFinite(event.end) && event.end > from && event.start < to)
    },
  }
}

/** The source this app uses: the fake file when a test copy names one, else his connected calendars. */
export function calendarSourceFor(
  apps: CalendarApps | null,
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string, detail?: Record<string, unknown>) => void,
): CalendarSource | null {
  const fake = (env['AGENT_FAKE_CALENDAR'] ?? '').trim()
  if (fake !== '') return fileCalendarSource(fake)
  return apps === null ? null : composioCalendarSource(apps, log)
}

// ---- the cache -----------------------------------------------------------------------------------------

export const CALENDAR_REFRESH_MS = 20 * 60_000
/** Read from this long ago (a meeting that started before midnight) to this far ahead (the next meeting this week). */
const BACK_MS = 12 * 60 * 60_000
const AHEAD_MS = 7 * 24 * 60 * 60_000
/** A refresh just after an event ends, so a meeting moved or added meanwhile is seen. */
const AFTER_END_MS = 30_000
/** A read that failed (all calendars or some) is tried again after these waits, then the normal refresh takes over. */
export const CALENDAR_RETRY_MS = [60_000, 120_000, 300_000] as const

export interface CalendarCacheDeps {
  source: CalendarSource | null
  now?: () => number
  refreshMs?: number
  log?: (message: string, detail?: Record<string, unknown>) => void
}

/** His meetings, read rarely and kept here. events() never calls a calendar. */
export class CalendarCache {
  private readonly source: CalendarSource | null
  private readonly now: () => number
  private readonly refreshMs: number
  private readonly log: (message: string, detail?: Record<string, unknown>) => void
  private list: CalendarEvent[] = []
  private known = false
  private timer: ReturnType<typeof setInterval> | null = null
  private endTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  private running: Promise<void> | null = null
  /** How many times a calendar was read (tests prove it is not per message). */
  reads = 0
  lastReadAt: number | null = null
  private readonly listeners = new Set<() => void>()
  private readFrom = 0
  private readTo = 0

  /** Told after a read that changed the meetings (mini-apps' calendar.changed). Returns the stopper. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * The meetings between from and to on every connected calendar (the calendar_events tool): from the cache when its
   * last read covered that window, else one read of the calendars for it. Null: no calendar is connected.
   */
  async range(from: number, to: number): Promise<CalendarEvent[] | null> {
    if (this.source === null) return null
    if (this.known && from >= this.readFrom && to <= this.readTo) return this.list.filter((event) => event.end > from && event.start < to)
    const events = await this.source.events(from, to)
    this.reads += 1
    return events === null ? null : dedupe(events).sort((a, b) => a.start - b.start)
  }

  constructor(deps: CalendarCacheDeps) {
    this.source = deps.source
    this.now = deps.now ?? Date.now
    this.refreshMs = deps.refreshMs ?? CALENDAR_REFRESH_MS
    this.log = deps.log ?? (() => undefined)
  }

  /** Read now, then every refreshMs. Safe to call twice. */
  start(): void {
    if (this.source === null || this.timer !== null) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), this.refreshMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.endTimer !== null) clearTimeout(this.endTimer)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.timer = null
    this.endTimer = null
    this.retryTimer = null
  }

  /** True once a calendar has been read successfully (an empty one counts). */
  hasCalendar(): boolean {
    return this.known
  }

  /** The cached meetings he has not declined, soonest first (the presence note, meetings that end early). */
  events(): CalendarEvent[] {
    return this.list.filter((event) => event.response !== 'declined')
  }

  /** Read the calendars again. A failure keeps what was read before; one read at a time. */
  refresh(): Promise<void> {
    if (this.source === null) return Promise.resolve()
    if (this.running !== null) return this.running
    const source = this.source
    const run = (async () => {
      const now = this.now()
      this.reads += 1
      try {
        const events = await source.events(now - BACK_MS, now + AHEAD_MS)
        const before = JSON.stringify(this.list)
        // Nothing connected (or disconnected since): no calendar line at all, rather than an empty calendar.
        this.list = events === null ? [] : dedupe(events).sort((a, b) => a.start - b.start)
        this.known = events !== null
        this.readFrom = now - BACK_MS
        this.readTo = now + AHEAD_MS
        if (JSON.stringify(this.list) !== before) {
          for (const listener of [...this.listeners]) {
            try {
              listener()
            } catch {
              // A listener failing never stops the cache.
            }
          }
        }
        this.lastReadAt = now
        this.armEnd()
        if (source.incomplete?.() === true) this.armRetry('some calendars')
        else this.retries = 0
      } catch (error) {
        this.log('Calendar not read', { message: error instanceof Error ? error.message : String(error) })
        this.armRetry('no calendar')
      }
    })().finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }

  /** After a failed read: try again in 1, then 2, then 5 minutes; after that the normal refresh carries on. */
  private armRetry(what: string): void {
    if (this.timer === null || this.retryTimer !== null) return
    const wait = CALENDAR_RETRY_MS[this.retries]
    if (wait === undefined) {
      this.retries = 0
      return
    }
    this.retries += 1
    this.log('Calendar read again soon', { failed: what, inSeconds: wait / 1000, attempt: this.retries })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.refresh()
    }, wait)
    this.retryTimer.unref?.()
  }

  /** A refresh just after the next event in the cache ends. */
  private armEnd(): void {
    if (this.endTimer !== null) clearTimeout(this.endTimer)
    this.endTimer = null
    if (this.timer === null) return
    const now = this.now()
    const next = this.list.map((event) => event.end).filter((end) => end > now).sort((a, b) => a - b)[0]
    if (next === undefined) return
    const wait = next - now + AFTER_END_MS
    if (wait > this.refreshMs) return
    this.endTimer = setTimeout(() => {
      this.endTimer = null
      void this.refresh()
    }, wait)
    this.endTimer.unref?.()
  }
}

/** The same meeting on two calendars (invited on both) shows once: the copy he has not declined, else the first. */
function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Map<string, number>()
  const out: CalendarEvent[] = []
  for (const event of events) {
    const key = `${event.start}|${event.end}|${event.title.trim().toLowerCase()}`
    const at = seen.get(key)
    if (at === undefined) {
      seen.set(key, out.length)
      out.push(event)
    } else if (out[at]?.response === 'declined' && event.response !== 'declined') out[at] = event
  }
  return out
}

