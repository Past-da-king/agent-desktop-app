/**
 * Presence for one app process (the desktop app and the headless node build it the same way): the calendar cache,
 * the asked / ended marks in `<dataDir>/presence.json`, and the internal event when a meeting ends early.
 */
import { join } from 'node:path'

import type { DataStore } from '../runtime/data'
import { CalendarCache, calendarSourceFor, type CalendarApps } from './calendar'
import { filePresenceState, Presence, type MeetingEndedEvent } from './presence'

export const PRESENCE_SOURCE = 'presence'
export const MEETING_ENDED_EVENT = 'meeting.ended_early'

/** An internal event, the same shape a worker emits (workers/store.ts addEvent). */
export interface PresenceEventInput {
  source: string
  event: string
  payload: Record<string, unknown>
  dedupeKey: string
}

export interface StartPresenceOptions {
  store: DataStore
  dataDir: string
  /** His connected apps; null when this build has none. */
  apps: CalendarApps | null
  selfId: () => string
  server?: boolean
  isFocused?: () => boolean | null
  idleSeconds?: () => number | null
  timeZone?: string
  now?: () => number
  /** Stores and routes an internal event (workers/store.ts + workers/router.ts). */
  emitEvent?: (input: PresenceEventInput) => void
  log?: (message: string, detail?: Record<string, unknown>) => void
  env?: NodeJS.ProcessEnv
}

export interface PresenceHandle {
  presence: Presence
  calendar: CalendarCache
  stop(): void
}

export function startPresence(options: StartPresenceOptions): PresenceHandle {
  const calendar = new CalendarCache({
    source: calendarSourceFor(options.apps, options.env),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
  })
  const presence = new Presence({
    store: options.store,
    calendar,
    selfId: options.selfId,
    state: filePresenceState(join(options.dataDir, 'presence.json')),
    ...(options.server === undefined ? {} : { server: options.server }),
    ...(options.isFocused === undefined ? {} : { isFocused: options.isFocused }),
    ...(options.idleSeconds === undefined ? {} : { idleSeconds: options.idleSeconds }),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.log === undefined ? {} : { log: options.log }),
    onEnded: (event) => options.emitEvent?.(endedEvent(event)),
  })
  calendar.start()
  return { presence, calendar, stop: () => calendar.stop() }
}

/** The event a routine can listen for: {"source":"presence","event":"meeting.ended_early"}. */
export function endedEvent(event: MeetingEndedEvent): PresenceEventInput {
  return {
    source: PRESENCE_SOURCE,
    event: MEETING_ENDED_EVENT,
    payload: {
      eventId: event.eventId,
      title: event.title,
      start: new Date(event.start).toISOString(),
      end: new Date(event.end).toISOString(),
      endedAt: new Date(event.endedAt).toISOString(),
      how: event.how,
      job: event.job.moved
        ? { moved: true, routineId: event.job.routineId, name: event.job.name, from: event.job.from, to: event.job.to }
        : { moved: false, why: event.job.why },
    },
    // One per meeting, however many times it is reported.
    dedupeKey: `meeting-ended:${event.eventId !== '' ? event.eventId : `${event.title}|${event.start}`}`,
  }
}
