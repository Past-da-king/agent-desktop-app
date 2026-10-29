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
}

/** Something that reads his calendars for a window of time. Null: no calendar is connected. Throws when it cannot read. */
export interface CalendarSource {
  events(from: number, to: number): Promise<CalendarEvent[] | null>
  /** True when the last events() read some calendars but not all (the cache then tries again soon). */
  incomplete?(): boolean
}

// ---- Composio (the connectors already in use) -----------------------------------------------------------

/** What the calendar reader needs from AppsService: his accounts in some apps, and running one action. */
export interface CalendarApps {
  activeAccounts(apps: string[]): Promise<Array<{ id: string; app: string }>>
  backend(): { execute(slug: string, args: JsonObject, account: string | null): Promise<{ ok: boolean; text: string }> } | null
  /** The per-account rules he set in Connections. Only accounts he lets agents read without asking are read. */
  rulesFor?(accountId: string): AccountRules
}

export const CALENDAR_APPS = ['googlecalendar', 'outlook'] as const

/** Every connected calendar account, read in one call each. No account: no events (and no error). */
export function composioCalendarSource(apps: CalendarApps, log: (message: string, detail?: Record<string, unknown>) => void = () => undefined): CalendarSource {
  let partial = false
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
      for (const account of accounts) {
        const app = account.app.toLowerCase()
        const call = app === 'outlook' ? outlookCall(from, to) : googleCall(from, to)
        try {
          const result = await backend.execute(call.slug, call.args, account.id)
          const reply = unwrapComposio(result.text)
          if (!result.ok || !reply.ok) {
            failures += 1
            log('Calendar read failed', { account: account.id, app, error: (reply.error ?? result.text).slice(0, 300) })
            continue
          }
          const key = app === 'outlook' ? 'value' : 'items'
          const listed = findList(reply.data, key).length
          const events = app === 'outlook' ? parseOutlookData(reply.data) : parseGoogleData(reply.data)
          // A list came back but nothing was kept, or no list at all: say so, so a new reply shape is never a silent empty calendar.
          if (events.length === 0 && (listed > 0 || !hasList(reply.data, key))) {
            log('Calendar reply kept no meetings', { account: account.id, app, listed, reply: result.text.slice(0, 300) })
          }
          found.push(...events)
        } catch (error) {
          failures += 1
          log('Calendar read failed', { account: account.id, app, error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (failures === accounts.length) throw new Error('No calendar could be read.')
      partial = failures > 0
      return found
    },
  }
}

function googleCall(from: number, to: number): { slug: string; args: JsonObject } {
  return {
    slug: 'GOOGLECALENDAR_EVENTS_LIST',
    args: { calendarId: 'primary', timeMin: new Date(from).toISOString(), timeMax: new Date(to).toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 100 },
  }
}

function outlookCall(from: number, to: number): { slug: string; args: JsonObject } {
  // Asked in UTC, so the times that come back (no offset of their own) are read as UTC.
  return {
    slug: 'OUTLOOK_GET_CALENDAR_VIEW',
    args: { start_datetime: new Date(from).toISOString(), end_datetime: new Date(to).toISOString(), timezone: 'UTC', top: 100 },
  }
}

/**
 * What a Composio reply really says. Composio Connect (COMPOSIO_MULTI_EXECUTE_TOOL) wraps the app's answer as
 * {successful, data: {results: [{response: {successful, data, error}}]}}; the REST API answers {successful, data}.
 * ok is false when either layer says it failed (or the text is an "Error:" or not JSON); data is the app's own answer.
 */
export function unwrapComposio(text: string): { ok: boolean; data: unknown; error?: string } {
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

/** Google Calendar events (items[]), without all-day, cancelled or declined ones. */
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
    if (attendees.some((one) => one['self'] === true && one['responseStatus'] === 'declined')) continue
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
    out.push({ id: text0(item['id']), title: text0(item['summary']) || '(no title)', start: startAt, end: endAt, where, source: 'googlecalendar' })
  }
  return out
}

/** Outlook calendar view (value[]), without all-day, cancelled or declined ones. */
export function parseOutlook(text: string): CalendarEvent[] {
  const reply = unwrapComposio(text)
  return reply.ok ? parseOutlookData(reply.data) : []
}

function parseOutlookData(data: unknown): CalendarEvent[] {
  const out: CalendarEvent[] = []
  for (const item of findList(data, 'value')) {
    if (item['isCancelled'] === true || item['isAllDay'] === true) continue
    if (record(item['responseStatus'])['response'] === 'declined') continue
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
    out.push({ id: text0(item['id']), title: text0(item['subject']) || '(no title)', start: startAt, end: endAt, where, source: 'outlook' })
  }
  return out
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
function findList(value: unknown, key: string, depth = 0): Array<Record<string, unknown>> {
  if (depth > 8 || typeof value !== 'object' || value === null) return []
  if (Array.isArray(value)) {
    for (const each of value.slice(0, 20)) {
      const found = findList(each, key, depth + 1)
      if (found.length > 0) return found
    }
    return []
  }
  const obj = value as Record<string, unknown>
  const direct = obj[key]
  if (Array.isArray(direct)) return direct.filter((each) => typeof each === 'object' && each !== null).map(record)
  for (const inner of Object.values(obj)) {
    const found = findList(typeof inner === 'string' && inner.trim().startsWith('{') ? parseJson(inner) : inner, key, depth + 1)
    if (found.length > 0) return found
  }
  return []
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
          source: 'file',
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

  /** The cached meetings, soonest first. */
  events(): CalendarEvent[] {
    return this.list
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
        // Nothing connected (or disconnected since): no calendar line at all, rather than an empty calendar.
        this.list = events === null ? [] : dedupe(events).sort((a, b) => a.start - b.start)
        this.known = events !== null
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

/** The same meeting on two calendars (invited on both) shows once. */
function dedupe(events: CalendarEvent[]): CalendarEvent[] {
  const seen = new Set<string>()
  const out: CalendarEvent[] = []
  for (const event of events) {
    const key = `${event.start}|${event.end}|${event.title.trim().toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(event)
  }
  return out
}

