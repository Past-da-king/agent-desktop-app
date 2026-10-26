/**
 * Where the person is right now, attached to every message he sends (decision of 26 Oct 2026: "attach to the messages
 * I'm sending something that says where I'm currently at... if I'm supposed to be in a meeting and I'm sending so many
 * requests, clearly I'm not in a meeting").
 *
 * One short bracketed note goes in front of each of his messages in the main thread and in project chats (the runner
 * puts it there, runtime/runner.ts), never in the system prompt: the time, the device he typed on, how active he is
 * (his messages in the last 10 minutes; on this computer also the window focus and the computer's idle time), and
 * what his calendars say now and next (presence/calendar.ts, cached).
 *
 * Meetings:
 * - While a meeting is on and he is chatting, the note offers the agent ONE brief "is it over?" per meeting. The offer
 *   is recorded per meeting, so every later note says it was already asked and the agent does not ask again.
 * - A meeting ends early when he says so (the meeting_ended tool) or, conservatively, when he has clearly been back
 *   for a good while (past half way, at least 5 messages since, 4 in the last 10 minutes). Then its follow-up job is
 *   moved to now + 2 minutes once (presence/meeting-jobs.ts) and an internal event goes out (source "presence",
 *   event "meeting.ended_early") through the same events as workers, so a routine can listen for it too.
 */
import { MAIN_CHAT, type JsonObject } from '@agent/core'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { listWhere, type DataStore } from '../runtime/data'
import { localTimeZone } from '../runtime/time'
import { isOrigin } from '../devices/origin'
import type { MessageOrigin } from '../devices/types'
import type { CalendarCache, CalendarEvent } from './calendar'
import { advanceMeetingJob, sameTitle, type MoveOutcome } from './meeting-jobs'

export const ACTIVE_WINDOW_MS = 10 * 60_000
/** The one "is it over?" is offered only after the meeting has been on this long (early messages may be before it). */
export const ASK_AFTER_MS = 5 * 60_000
/** Inferring an early end: past this share of the meeting... */
export const INFER_AFTER_FRACTION = 0.5
/** ...with at least this many of his messages since then... */
export const INFER_MIN_MESSAGES = 5
/** ...at least this many of them in the last 10 minutes... */
export const INFER_MIN_RECENT = 4
/** ...in a meeting at least this long, with at least this much of it left (otherwise it ends anyway). */
export const INFER_MIN_LENGTH_MS = 15 * 60_000
export const INFER_MIN_LEFT_MS = 5 * 60_000
/** What is kept about past meetings (asked, ended) before it is dropped. */
const KEEP_MS = 3 * 24 * 60 * 60_000

export type EndedHow = 'said' | 'inferred'

export interface MeetingEndedEvent {
  eventId: string
  title: string
  start: number
  end: number
  endedAt: number
  how: EndedHow
  job: MoveOutcome
}

interface PresenceState {
  asked: Record<string, number>
  ended: Record<string, { at: number; how: EndedHow; title: string; start: number; end: number }>
}

/** Where the asked / ended marks live: a small file next to the app's data, or memory in tests. */
export interface PresenceStateStore {
  read(): PresenceState
  write(state: PresenceState): void
}

export function memoryPresenceState(): PresenceStateStore {
  let state: PresenceState = { asked: {}, ended: {} }
  return {
    read: () => state,
    write: (next) => {
      state = next
    },
  }
}

export function filePresenceState(path: string): PresenceStateStore {
  return {
    read: () => {
      try {
        if (!existsSync(path)) return { asked: {}, ended: {} }
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PresenceState>
        return { asked: raw.asked ?? {}, ended: raw.ended ?? {} }
      } catch {
        return { asked: {}, ended: {} }
      }
    },
    write: (state) => {
      try {
        writeFileSync(path, JSON.stringify(state), { mode: 0o600 })
      } catch {
        // Kept in memory for this run; the worst case is one more offer after a restart.
      }
    },
  }
}

export interface PresenceDeps {
  store: DataStore
  /** His meetings, cached. Null: no calendar line. */
  calendar: CalendarCache | null
  now?: () => number
  timeZone?: string
  /** This node's device id, to tell a message typed here from one sent from his phone. */
  selfId?: () => string
  /** True when this node is a server nobody types on (the headless node). */
  server?: boolean
  /** The app window has focus (desktop only). */
  isFocused?: () => boolean | null
  /** Seconds since the computer last saw keyboard or mouse input (desktop only). */
  idleSeconds?: () => number | null
  state?: PresenceStateStore
  /** A meeting ended early: the internal event (workers/router.ts events). */
  onEnded?: (event: MeetingEndedEvent) => void
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export class Presence {
  private readonly store: DataStore
  private readonly calendar: CalendarCache | null
  private readonly now: () => number
  private readonly timeZone: string
  private readonly selfId: () => string
  private readonly server: boolean
  private readonly isFocused: () => boolean | null
  private readonly idleSeconds: () => number | null
  private readonly state: PresenceStateStore
  private readonly onEnded: (event: MeetingEndedEvent) => void
  private readonly log: (message: string, detail?: Record<string, unknown>) => void

  constructor(deps: PresenceDeps) {
    this.store = deps.store
    this.calendar = deps.calendar
    this.now = deps.now ?? Date.now
    this.timeZone = deps.timeZone ?? localTimeZone()
    this.selfId = deps.selfId ?? (() => '')
    this.server = deps.server ?? false
    this.isFocused = deps.isFocused ?? (() => null)
    this.idleSeconds = deps.idleSeconds ?? (() => null)
    this.state = deps.state ?? memoryPresenceState()
    this.onEnded = deps.onEnded ?? (() => undefined)
    this.log = deps.log ?? (() => undefined)
  }

  /**
   * The note for one of his messages, already stored as a chat row (so it is counted). `meta` is that row's meta:
   * its origin says which device it came from.
   */
  async note(chat: string = MAIN_CHAT, meta: JsonObject | string = {}): Promise<string> {
    const now = this.now()
    const parts: string[] = []
    parts.push(`Now ${this.clock(now)} ${this.day(now, true)}.`)
    parts.push(this.deviceLine(originIn(meta)))

    const mine = await this.hisMessages(now - 12 * 60 * 60_000)
    const recent = mine.filter((at) => at > now - ACTIVE_WINDOW_MS).length
    parts.push(recent >= 3 ? `Active: ${recent} messages in the last 10 min.` : `${recent} message${recent === 1 ? '' : 's'} from him in the last 10 min.`)

    const calendar = await this.calendarLine(now, mine)
    if (calendar !== '') parts.push(calendar)
    void chat
    return `[Presence (from the app, not typed by him): ${parts.join(' ')}]`
  }

  /**
   * He says a meeting is over (meeting_ended), or the app inferred it. Finds the meeting (by id, by title, else the
   * one on now or just before), marks it ended once, moves its follow-up job, and sends the event.
   */
  async meetingEnded(query: { eventId?: string; title?: string }, how: EndedHow = 'said'): Promise<string> {
    const now = this.now()
    const event = this.findMeeting(query, now)
    if (event === null) {
      return query.title !== undefined && query.title.trim() !== ''
        ? `No meeting like "${query.title.trim()}" is on his calendar today, so nothing was moved.`
        : 'No meeting is on or just finished on his calendar, so nothing was moved.'
    }
    const outcome = await this.markEnded(event, now, how)
    if (outcome === null) return `"${event.title}" was already marked as ended; nothing changed.`
    if (event.end <= now) return `"${event.title}" was due to end at ${this.clock(event.end)} anyway; its follow-up runs on its own time.`
    return `Marked "${event.title}" as ended at ${this.clock(now)}. ${jobLine(outcome, (stamp) => this.clock(stamp))}`
  }

  // ---- internals ----

  private async hisMessages(since: number): Promise<number[]> {
    try {
      const rows = await listWhere(this.store, 'chat_item', { kind: 'user', since })
      return rows.filter((row) => parseMeta(row.meta)['via'] === undefined).map((row) => row.createdAt)
    } catch {
      return []
    }
  }

  private deviceLine(origin: MessageOrigin | null): string {
    const self = this.selfId()
    const here = origin === null || (self !== '' && origin.deviceId === self)
    if (!here && origin !== null) {
      const kind = origin.kind === 'phone' ? 'phone' : origin.kind === 'tablet' ? 'tablet' : 'computer'
      return `Typing on his ${kind}${origin.name.trim() === '' ? '' : ` (${origin.name.trim()})`}.`
    }
    if (this.server) return 'Typing on this server.'
    const facts: string[] = []
    const focused = this.isFocused()
    if (focused !== null) facts.push(focused ? 'app window focused' : 'app window not focused')
    const idle = this.idleSeconds()
    if (idle !== null) facts.push(idle >= 60 ? `computer idle ${Math.round(idle / 60)} min` : 'at the keyboard')
    return `Typing on this computer${facts.length === 0 ? '' : ` (${facts.join(', ')})`}.`
  }

  private async calendarLine(now: number, mine: number[]): Promise<string> {
    const calendar = this.calendar
    if (calendar === null || !calendar.hasCalendar()) return ''
    const events = calendar.events()
    const state = this.prune(this.state.read(), now)
    const current = events.filter((event) => event.start <= now && now < event.end).slice(0, 2)
    const next = events.find((event) => event.start > now)
    const out: string[] = []
    for (const event of current) {
      const key = keyOf(event)
      const span = `"${event.title}" ${this.clock(event.start)} to ${this.clock(event.end)}${event.where === '' ? '' : ` (${event.where})`}`
      const ended = state.ended[key]
      if (ended !== undefined) {
        out.push(`${span}, ended early at ${this.clock(ended.at)} (${ended.how === 'said' ? 'he said so' : 'inferred: he was back and active'}). Do not ask about it.`)
        continue
      }
      const inSlot = mine.filter((at) => at >= event.start)
      if (this.inferEnded(event, now, mine)) {
        const outcome = await this.markEnded(event, now, 'inferred')
        out.push(
          `${span}: it looks like it ended early (he has been chatting steadily since past half way)` +
            `${outcome === null ? '' : `; ${jobLine(outcome, (stamp) => this.clock(stamp))}`}. Do not ask about it.`,
        )
        continue
      }
      const minutesIn = Math.max(0, Math.round((now - event.start) / 60_000))
      const asked = state.asked[key]
      if (asked !== undefined) {
        out.push(`${span}, ${minutesIn} min in. You were already offered the one question about this meeting at ${this.clock(asked)}: do not ask again. If he says it is over, call meeting_ended.`)
      } else if (inSlot.length > 0 && now - event.start >= ASK_AFTER_MS) {
        state.asked[key] = now
        this.state.write(state)
        out.push(`${span}, ${minutesIn} min in, and he is chatting with you. You may ask ONCE, briefly, whether it is still on (this is the only time for this meeting). If he says it is over, call meeting_ended.`)
      } else {
        out.push(`${span}, ${minutesIn} min in.`)
      }
    }
    const nextLine = next === undefined ? '' : `next "${next.title}" ${this.when(next.start, now)}${next.where === '' ? '' : ` (${next.where})`}`
    if (out.length === 0) return `Calendar: nothing on now${nextLine === '' ? ' or later this week' : `; ${nextLine}`}.`
    return `Calendar: ${out.join(' Also ')}${nextLine === '' ? '' : ` Then ${nextLine}.`}`
  }

  /** Conservative: well past half way, many messages since, several just now, and enough of it left to matter. */
  private inferEnded(event: CalendarEvent, now: number, mine: number[]): boolean {
    const length = event.end - event.start
    if (length < INFER_MIN_LENGTH_MS) return false
    if (event.end - now < INFER_MIN_LEFT_MS) return false
    const half = event.start + length * INFER_AFTER_FRACTION
    if (now < half) return false
    const since = mine.filter((at) => at >= half).length
    const recent = mine.filter((at) => at >= Math.max(half, now - ACTIVE_WINDOW_MS)).length
    return since >= INFER_MIN_MESSAGES && recent >= INFER_MIN_RECENT
  }

  /** Mark it ended once; move its job and send the event. Null when it was already marked. */
  private async markEnded(event: CalendarEvent, now: number, how: EndedHow): Promise<MoveOutcome | null> {
    const state = this.prune(this.state.read(), now)
    const key = keyOf(event)
    if (state.ended[key] !== undefined) return null
    state.ended[key] = { at: now, how, title: event.title, start: event.start, end: event.end }
    this.state.write(state)
    if (event.end <= now) return { moved: false, why: 'due-anyway' }
    let job: MoveOutcome
    try {
      job = await advanceMeetingJob(this.store, { eventId: event.id, title: event.title, start: event.start, end: event.end }, now, how === 'said' ? 'he said the meeting was over' : 'he was back and active during the meeting')
    } catch (error) {
      this.log('Meeting job not moved', { message: error instanceof Error ? error.message : String(error) })
      job = { moved: false, why: 'no-job' }
    }
    this.log('Meeting ended early', { how, moved: job.moved ? 1 : 0 })
    try {
      this.onEnded({ eventId: event.id, title: event.title, start: event.start, end: event.end, endedAt: now, how, job })
    } catch {
      // The event is extra; the job has already moved.
    }
    return job
  }

  private findMeeting(query: { eventId?: string; title?: string }, now: number): CalendarEvent | null {
    const events = this.calendar?.events() ?? []
    const id = (query.eventId ?? '').trim()
    if (id !== '') {
      const byId = events.find((event) => event.id === id)
      if (byId !== undefined) return byId
    }
    const recent = events.filter((event) => event.start <= now && event.end > now - 3 * 60 * 60_000)
    const title = (query.title ?? '').trim()
    const pool = title === '' ? recent : events.filter((event) => event.start <= now + 15 * 60_000 && event.end > now - 12 * 60 * 60_000 && sameTitle(event.title, title))
    // The one on now first, then the one that started most recently.
    const on = pool.filter((event) => event.start <= now && now < event.end).sort((a, b) => b.start - a.start)[0]
    return on ?? [...pool].sort((a, b) => b.start - a.start)[0] ?? null
  }

  private prune(state: PresenceState, now: number): PresenceState {
    for (const [key, at] of Object.entries(state.asked)) if (at < now - KEEP_MS) delete state.asked[key]
    for (const [key, ended] of Object.entries(state.ended)) if (ended.at < now - KEEP_MS) delete state.ended[key]
    return state
  }

  private clock(stamp: number): string {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: this.timeZone }).format(new Date(stamp))
  }

  /** "Mon 26 Oct 2026" (with the year) or "Thu 29 Oct". */
  private day(stamp: number, year = false): string {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: this.timeZone })
      .format(new Date(stamp))
      .replace(/,/g, '')
  }

  /** "at 14:00" today, "tomorrow 09:00", "Thu 19:30" this week. */
  private when(stamp: number, now: number): string {
    const dayOf = (at: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone }).format(new Date(at))
    if (dayOf(stamp) === dayOf(now)) return `at ${this.clock(stamp)}`
    if (dayOf(stamp) === dayOf(now + 24 * 60 * 60_000)) return `tomorrow ${this.clock(stamp)}`
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: this.timeZone }).format(new Date(stamp))
    return stamp - now < 6 * 24 * 60 * 60_000 ? `${weekday} ${this.clock(stamp)}` : `${this.day(stamp)} ${this.clock(stamp)}`
  }
}

function jobLine(outcome: MoveOutcome, clock: (stamp: number) => string): string {
  if (outcome.moved) return `Its follow-up job "${outcome.name}" now runs at ${clock(Date.parse(outcome.to))} instead of ${clock(Date.parse(outcome.from))}.`
  if (outcome.why === 'already-moved') return `Its follow-up job "${outcome.name ?? ''}" was already brought forward.`
  if (outcome.why === 'due-anyway') return 'Its follow-up job is due within two minutes anyway.'
  return 'It has no follow-up job.'
}

/** One key per meeting: its calendar id, else its title and start. */
export function keyOf(event: CalendarEvent): string {
  return event.id !== '' ? `${event.source}:${event.id}` : `${event.title.trim().toLowerCase()}|${event.start}`
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function originIn(meta: JsonObject | string): MessageOrigin | null {
  const value = typeof meta === 'string' ? parseMeta(meta) : (meta as Record<string, unknown>)
  return isOrigin(value['origin']) ? value['origin'] : null
}
