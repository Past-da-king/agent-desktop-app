/**
 * calendar_events: his meetings across every calendar he connected (Connections: Google Calendar, Outlook), in one
 * list, read through the same calendar reader the presence note and wake-ups use (presence/calendar.ts): only the
 * accounts he lets agents read without asking, found from his accounts each time, never named in code. Read-only.
 * Agents use it, and so do mini-apps granted it (a calendar view across all his calendars).
 */
import { schema, str, type Tool } from '@agent/core'

import type { CalendarEvent } from '../presence/calendar'

export interface CalendarReader {
  range(from: number, to: number): Promise<CalendarEvent[] | null>
}

const DAY = 24 * 60 * 60_000
const MAX_DAYS = 62

function parseWhen(value: unknown, fallback: number): number {
  if (typeof value !== 'string' || value.trim() === '') return fallback
  const at = Date.parse(value.trim())
  return Number.isFinite(at) ? at : Number.NaN
}

export function calendarTools(calendar: () => CalendarReader | null, now: () => number = Date.now): Tool[] {
  return [
    {
      spec: {
        name: 'calendar_events',
        description:
          "The user's meetings on every calendar he connected (Google Calendar, Outlook), as one list, soonest first: title, start, end (ISO), where (Teams, Meet, Zoom or a place) and which calendar app. from and to are ISO date-times or dates (default: now to 7 days ahead; at most 62 days). Read-only. calendars 'none' means no calendar is connected.",
        schema: schema([], {
          from: str('ISO date-time or date to start from (default now)'),
          to: str('ISO date-time or date to end at (default 7 days after from)'),
        }),
      },
      run: async (input) => {
        const reader = calendar()
        const from = parseWhen(input['from'], now())
        const to = parseWhen(input['to'], from + 7 * DAY)
        if (!Number.isFinite(from) || !Number.isFinite(to)) return JSON.stringify({ error: 'from and to are ISO dates, like 2026-11-02 or 2026-11-02T09:00' })
        if (to <= from) return JSON.stringify({ error: 'to must be after from' })
        if (to - from > MAX_DAYS * DAY) return JSON.stringify({ error: `at most ${MAX_DAYS} days at a time` })
        if (reader === null) return JSON.stringify({ calendars: 'none', events: [] })
        const events = await reader.range(from, to)
        if (events === null) return JSON.stringify({ calendars: 'none', events: [] })
        return JSON.stringify({
          calendars: 'connected',
          from: new Date(from).toISOString(),
          to: new Date(to).toISOString(),
          events: events.map((event) => ({
            id: event.id,
            title: event.title,
            start: new Date(event.start).toISOString(),
            end: new Date(event.end).toISOString(),
            where: event.where,
            calendar: event.source,
          })),
        })
      },
    },
  ]
}
