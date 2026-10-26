/**
 * A meeting that ended early brings its follow-up job forward (presence/presence.ts).
 *
 * Follow-up jobs are one-off `at` routines named "Meeting: <title> <yyyy-mm-dd>" (a scheduler routine makes one per
 * meeting, a little after it is due to end), optionally carrying the calendar event id (TriggerRow.eventId). When the
 * meeting ends early, the job for it moves to now + 2 minutes, once:
 * - matched by event id when the job has one, else by the date in its name and a title close to the meeting's;
 * - only a job still waiting (switched on, not run since its time, its time still ahead);
 * - its spec is replaced, so the old time can never fire as well, and `movedEarly` marks it so it is never moved again;
 * - a meeting with no job changes nothing.
 */
import type { TriggerRow } from '@agent/core'

import type { DataStore } from '../runtime/data'

export const MOVE_AHEAD_MS = 2 * 60_000

export interface EndedMeeting {
  eventId: string
  title: string
  start: number
  end: number
}

export type MoveOutcome =
  | { moved: true; routineId: string; name: string; from: string; to: string }
  | { moved: false; why: 'no-job' | 'already-moved' | 'due-anyway'; routineId?: string; name?: string }

/** "Meeting: Weekly sync 2026-10-26 (retry)" -> { title: "Weekly sync", date: "2026-10-26", extra: "(retry)" } */
export function parseJobName(name: string): { title: string; date: string; extra: string } | null {
  const match = /^\s*meeting\s*:\s*(.*?)\s+(\d{4}-\d{2}-\d{2})\s*(.*)$/i.exec(name)
  if (match === null) return null
  return { title: match[1] ?? '', date: match[2] ?? '', extra: (match[3] ?? '').trim() }
}

/** The local calendar date of a moment, as the job names write it. */
export function localDate(stamp: number): string {
  const d = new Date(stamp)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** A local ISO time with no offset, the way `at` routines are written (Date.parse reads it as local). */
export function localIso(stamp: number): string {
  const d = new Date(stamp)
  return `${localDate(stamp)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((word) => word !== '')
}

/** Close enough to be the same meeting: the same words, or one name inside the other, or most words shared. */
export function sameTitle(a: string, b: string): boolean {
  const x = words(a)
  const y = words(b)
  if (x.length === 0 || y.length === 0) return false
  const joinedX = x.join(' ')
  const joinedY = y.join(' ')
  if (joinedX === joinedY) return true
  if ((joinedX.includes(joinedY) && y.length >= 2) || (joinedY.includes(joinedX) && x.length >= 2)) return true
  const setY = new Set(y)
  const shared = new Set(x.filter((word) => setY.has(word))).size
  const union = new Set([...x, ...y]).size
  return shared / union >= 0.6
}

/** A job that has not run for its current time yet and is switched on. */
function waiting(trigger: TriggerRow): boolean {
  if (trigger.kind !== 'at' || !trigger.enabled) return false
  const at = Date.parse(trigger.spec)
  if (!Number.isFinite(at)) return false
  return trigger.lastRunAt === null || trigger.lastRunAt < at
}

/** The follow-up jobs that belong to this meeting, best first. */
export function jobsFor(triggers: TriggerRow[], meeting: EndedMeeting): TriggerRow[] {
  const day = localDate(meeting.start)
  const mine = triggers.filter((trigger) => {
    if (trigger.kind !== 'at') return false
    if (meeting.eventId !== '' && typeof trigger.eventId === 'string' && trigger.eventId !== '') return trigger.eventId === meeting.eventId
    const parsed = parseJobName(trigger.name)
    return parsed !== null && parsed.date === day && sameTitle(parsed.title, meeting.title)
  })
  // The plain job before its retries ("... (probe +17)"), then the earliest.
  return mine.sort((a, b) => {
    const extraA = parseJobName(a.name)?.extra === '' ? 0 : 1
    const extraB = parseJobName(b.name)?.extra === '' ? 0 : 1
    return extraA - extraB || Date.parse(a.spec) - Date.parse(b.spec)
  })
}

/** Move the meeting's follow-up job to now + 2 minutes, once. */
export async function advanceMeetingJob(store: DataStore, meeting: EndedMeeting, now: number, why: string): Promise<MoveOutcome> {
  const jobs = jobsFor(await store.list('trigger'), meeting)
  if (jobs.length === 0) return { moved: false, why: 'no-job' }
  const done = jobs.find((job) => job.movedEarly !== undefined)
  if (done !== undefined) return { moved: false, why: 'already-moved', routineId: done.id, name: done.name }
  const job = jobs.find(waiting)
  if (job === undefined) return { moved: false, why: 'no-job' }
  const target = now + MOVE_AHEAD_MS
  // Already due within the two minutes: leave it, it runs on its own time.
  if (Date.parse(job.spec) <= target) return { moved: false, why: 'due-anyway', routineId: job.id, name: job.name }
  const to = localIso(target)
  await store.upsert('trigger', {
    id: job.id,
    spec: to,
    movedEarly: { from: job.spec, at: now, why, ...(meeting.eventId === '' ? {} : { eventId: meeting.eventId }) },
  })
  return { moved: true, routineId: job.id, name: job.name, from: job.spec, to }
}
