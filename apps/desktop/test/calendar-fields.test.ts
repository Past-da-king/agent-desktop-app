/**
 * calendar_events carries what a person needs to act on a meeting: the link to join, who organised it, his own answer
 * and which calendar account it came from. And a mini-app's look check waits for its first data before the shot.
 */
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

import type { JsonObject } from '@agent/core'

import { CalendarCache, composioCalendarSource, parseGoogle, parseOutlook, type CalendarApps, type CalendarEvent } from '../src/main/presence/calendar'
import { calendarTools } from '../src/main/tools/calendar'
import { CheckWatch, waitForFirstData } from '../src/main/miniapps/check-wait'
import { agentJs } from '../src/shared/miniapp-kit'

function connectReply(slug: string, data: JsonObject): string {
  return JSON.stringify({ successful: true, data: { results: [{ response: { successful: true, data }, tool_slug: slug, index: 0 }], total_count: 1, success_count: 1, error_count: 0 }, error: null, log_id: 'log_test' })
}

// Shapes as his real calendars send them (29 Oct 2026), names changed.
const GOOGLE = connectReply('GOOGLECALENDAR_EVENTS_LIST', {
  summary: 'me@work.example',
  items: [
    {
      id: 'scrum1',
      summary: 'Daily Scrum',
      start: { dateTime: '2026-10-30T11:00:00+02:00' },
      end: { dateTime: '2026-10-30T11:30:00+02:00' },
      hangoutLink: 'https://meet.google.com/orv-brcz-qfw',
      organizer: { email: 'Chris@Partner.example', displayName: 'Chris' },
      attendees: [{ responseStatus: 'accepted' }, { self: true, responseStatus: 'needsAction' }],
      conferenceData: { conferenceSolution: { name: 'Google Meet' }, entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/orv-brcz-qfw' }, { entryPointType: 'phone', uri: 'tel:+44-20' }] },
    },
    {
      id: 'zoom1',
      summary: 'Partner call',
      start: { dateTime: '2026-10-30T14:00:00+02:00' },
      end: { dateTime: '2026-10-30T15:00:00+02:00' },
      organizer: { email: 'me@work.example', self: true },
      conferenceData: { conferenceSolution: { name: 'Zoom Meeting' }, entryPoints: [{ entryPointType: 'video', uri: 'https://zoom.us/j/123' }] },
    },
    {
      id: 'tent1',
      summary: 'Maybe',
      start: { dateTime: '2026-10-30T16:00:00+02:00' },
      end: { dateTime: '2026-10-30T16:30:00+02:00' },
      attendees: [{ self: true, responseStatus: 'tentative' }],
    },
    {
      id: 'dec1',
      summary: 'Said no',
      start: { dateTime: '2026-10-30T17:00:00+02:00' },
      end: { dateTime: '2026-10-30T17:30:00+02:00' },
      attendees: [{ self: true, responseStatus: 'declined' }],
    },
    { id: 'solo', summary: 'Focus', start: { dateTime: '2026-10-30T18:00:00+02:00' }, end: { dateTime: '2026-10-30T19:00:00+02:00' } },
  ],
})

const OUTLOOK = connectReply('OUTLOOK_GET_CALENDAR_VIEW', {
  '@odata.context': "https://graph.microsoft.com/v1.0/$metadata#users('75858a9e')/calendarView",
  value: [
    {
      id: 'o1',
      subject: 'Weekly Project Feedback',
      start: { dateTime: '2026-10-29T17:30:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-10-29T18:30:00.0000000', timeZone: 'UTC' },
      responseStatus: { response: 'notResponded' },
      onlineMeetingProvider: 'teamsForBusiness',
      onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x' },
      organizer: { emailAddress: { name: 'Thabo M', address: 'thabo@company.example' } },
      isOrganizer: false,
    },
    {
      id: 'o2',
      subject: 'Intern interview',
      start: { dateTime: '2026-11-02T11:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-02T11:45:00.0000000', timeZone: 'UTC' },
      responseStatus: { response: 'organizer' },
      onlineMeetingProvider: 'teamsForBusiness',
      onlineMeeting: null,
      onlineMeetingUrl: 'https://teams.microsoft.com/l/meetup-join/old',
      organizer: { emailAddress: { name: 'Me', address: 'Me@Company.example' } },
      isOrganizer: true,
    },
    {
      id: 'o3',
      subject: 'Optional sync',
      start: { dateTime: '2026-11-02T13:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-02T13:30:00.0000000', timeZone: 'UTC' },
      responseStatus: { response: 'tentativelyAccepted' },
      location: { displayName: 'Boardroom' },
      organizer: { emailAddress: { name: 'Lee', address: 'lee@company.example' } },
    },
    {
      id: 'o4',
      subject: 'Not going',
      start: { dateTime: '2026-11-02T14:00:00.0000000', timeZone: 'UTC' },
      end: { dateTime: '2026-11-02T14:30:00.0000000', timeZone: 'UTC' },
      responseStatus: { response: 'declined' },
    },
  ],
})

const PROFILE = connectReply('OUTLOOK_GET_PROFILE', { response_data: { displayName: 'Me', mail: 'Me@Company.example', userPrincipalName: 'me@company.onmicrosoft.example' } })

function apps(accounts: Array<{ id: string; app: string; label?: string }>, replies: Record<string, () => string>, calls: Array<{ slug: string; args: JsonObject; account: string | null }> = []): CalendarApps {
  return {
    activeAccounts: async () => accounts,
    backend: () => ({
      execute: async (slug, args, account) => {
        calls.push({ slug, args, account })
        const reply = replies[slug]
        return reply === undefined ? { ok: false, text: `Error: no such tool ${slug}` } : { ok: true, text: reply() }
      },
    }),
  }
}

const pick = (events: CalendarEvent[] | null) =>
  (events ?? []).map((event) => ({ title: event.title, joinUrl: event.joinUrl, organiser: event.organiser, response: event.response, account: event.account }))

describe('calendar events carry the join link, organiser, his answer and the account', () => {
  it('reads them from Google: Meet link, a video entry point (Zoom), organiser, his own response, and the account from the calendar', async () => {
    expect(pick(parseGoogle(GOOGLE))).toEqual([
      { title: 'Daily Scrum', joinUrl: 'https://meet.google.com/orv-brcz-qfw', organiser: { name: 'Chris', email: 'chris@partner.example', self: false }, response: 'needsAction', account: '' },
      { title: 'Partner call', joinUrl: 'https://zoom.us/j/123', organiser: { name: '', email: 'me@work.example', self: true }, response: 'accepted', account: '' },
      { title: 'Maybe', joinUrl: '', organiser: null, response: 'tentative', account: '' },
      { title: 'Said no', joinUrl: '', organiser: null, response: 'declined', account: '' },
      { title: 'Focus', joinUrl: '', organiser: null, response: 'none', account: '' },
    ])
    const events = await composioCalendarSource(apps([{ id: 'googlecalendar_a', app: 'googlecalendar' }], { GOOGLECALENDAR_EVENTS_LIST: () => GOOGLE })).events(0, Date.parse('2026-12-01'))
    expect(new Set(events?.map((event) => event.account))).toEqual(new Set(['me@work.example']))
  })

  it('reads them from Outlook: Teams join link (or the older onlineMeetingUrl), organiser, the answer in the same words as Google', () => {
    expect(pick(parseOutlook(OUTLOOK))).toEqual([
      { title: 'Weekly Project Feedback', joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x', organiser: { name: 'Thabo M', email: 'thabo@company.example', self: false }, response: 'needsAction', account: '' },
      { title: 'Intern interview', joinUrl: 'https://teams.microsoft.com/l/meetup-join/old', organiser: { name: 'Me', email: 'me@company.example', self: true }, response: 'accepted', account: '' },
      { title: 'Optional sync', joinUrl: '', organiser: { name: 'Lee', email: 'lee@company.example', self: false }, response: 'tentative', account: '' },
      { title: 'Not going', joinUrl: '', organiser: null, response: 'declined', account: '' },
    ])
  })

  it('names the Outlook account: its label when that is an email, else its profile once (kept), else the organiser of his own meeting', async () => {
    const labelled: Array<{ slug: string; args: JsonObject; account: string | null }> = []
    const byLabel = await composioCalendarSource(apps([{ id: 'outlook_a', app: 'outlook', label: 'Me@Company.example' }], { OUTLOOK_GET_CALENDAR_VIEW: () => OUTLOOK }, labelled)).events(0, Date.parse('2026-12-01'))
    expect(new Set(byLabel?.map((event) => event.account))).toEqual(new Set(['me@company.example']))
    expect(labelled.map((call) => call.slug)).toEqual(['OUTLOOK_GET_CALENDAR_VIEW'])

    const profiled: Array<{ slug: string; args: JsonObject; account: string | null }> = []
    const source = composioCalendarSource(apps([{ id: 'outlook_b', app: 'outlook', label: 'maine-baba' }], { OUTLOOK_GET_CALENDAR_VIEW: () => OUTLOOK, OUTLOOK_GET_PROFILE: () => PROFILE }, profiled))
    expect(new Set((await source.events(0, Date.parse('2026-12-01')))?.map((event) => event.account))).toEqual(new Set(['me@company.example']))
    await source.events(0, Date.parse('2026-12-01'))
    // Asked once, then kept.
    expect(profiled.map((call) => `${call.slug}@${call.account}`)).toEqual(['OUTLOOK_GET_CALENDAR_VIEW@outlook_b', 'OUTLOOK_GET_PROFILE@outlook_b', 'OUTLOOK_GET_CALENDAR_VIEW@outlook_b'])

    const lines: string[] = []
    const noProfile = composioCalendarSource(apps([{ id: 'outlook_c', app: 'outlook' }], { OUTLOOK_GET_CALENDAR_VIEW: () => OUTLOOK }), (message) => lines.push(message))
    expect(new Set((await noProfile.events(0, Date.parse('2026-12-01')))?.map((event) => event.account))).toEqual(new Set(['me@company.example']))
    expect(lines).toContain('Calendar account email not read')
  })

  it('asks for the new fields and only them, so the reply stays small', async () => {
    const calls: Array<{ slug: string; args: JsonObject; account: string | null }> = []
    await composioCalendarSource(
      apps([{ id: 'g', app: 'googlecalendar' }, { id: 'o', app: 'outlook', label: 'me@company.example' }], { GOOGLECALENDAR_EVENTS_LIST: () => GOOGLE, OUTLOOK_GET_CALENDAR_VIEW: () => OUTLOOK }, calls),
    ).events(0, 1)
    const fields = String(calls.find((call) => call.slug === 'GOOGLECALENDAR_EVENTS_LIST')?.args['fields'])
    expect(fields).toMatch(/^summary,items\(/)
    for (const part of ['organizer(email,displayName,self)', 'entryPoints(entryPointType,uri)', 'hangoutLink', 'attendees(self,responseStatus)']) expect(fields).toContain(part)
    const select = calls.find((call) => call.slug === 'OUTLOOK_GET_CALENDAR_VIEW')?.args['select'] as string[]
    expect(select).toEqual(expect.arrayContaining(['onlineMeeting', 'onlineMeetingUrl', 'organizer', 'isOrganizer', 'responseStatus']))
    for (const heavy of ['body', 'attendees', 'bodyPreview']) expect(select).not.toContain(heavy)
  })

  it('a long window Connect keeps cutting is read in smaller and smaller spans, never below a day, and then counts as partial', async () => {
    const cut = JSON.stringify({ successful: true, data: { results: [{ response: { successful: true, data_preview: { value: [{ id: 'x', '...': 'more' }] } } }], remote_file_info: { file_path: '/mnt/files/x.json' } } })
    const spans: number[] = []
    const source = composioCalendarSource({
      activeAccounts: async () => [{ id: 'o', app: 'outlook', label: 'me@company.example' }],
      backend: () => ({
        execute: async (_slug, args) => {
          const days = (Date.parse(String(args['end_datetime'])) - Date.parse(String(args['start_datetime']))) / 86_400_000
          spans.push(days)
          // Whole only at 4 days or less (a busy month).
          return { ok: true, text: days <= 4 ? OUTLOOK : cut }
        },
      }),
    })
    const from = Date.parse('2026-10-29T00:00:00Z')
    const events = await source.events(from, from + 28 * 86_400_000)
    expect(spans.slice(0, 3)).toEqual([28, 14, 7])
    expect(spans.filter((days) => days <= 4).length).toBe(8)
    // The same meetings came back in every span: each once.
    expect(events?.map((event) => event.title)).toEqual(['Weekly Project Feedback', 'Intern interview', 'Optional sync', 'Not going'])
    expect(source.incomplete?.()).toBe(false)

    const always: number[] = []
    const stuck = composioCalendarSource({
      activeAccounts: async () => [{ id: 'o', app: 'outlook', label: 'me@company.example' }],
      backend: () => ({
        execute: async (_slug, args) => {
          always.push((Date.parse(String(args['end_datetime'])) - Date.parse(String(args['start_datetime']))) / 86_400_000)
          return { ok: true, text: cut }
        },
      }),
    })
    await stuck.events(from, from + 7 * 86_400_000)
    expect(Math.min(...always)).toBeGreaterThanOrEqual(0.875)
    expect(always.length).toBeLessThanOrEqual(15)
    expect(stuck.incomplete?.()).toBe(true)
  })

  it('declined meetings are listed (marked) for calendar_events, but never reach the presence note', async () => {
    const cache = new CalendarCache({ source: composioCalendarSource(apps([{ id: 'g', app: 'googlecalendar' }], { GOOGLECALENDAR_EVENTS_LIST: () => GOOGLE })), now: () => Date.parse('2026-10-30T08:00:00Z') })
    await cache.refresh()
    expect(cache.events().map((event) => event.title)).not.toContain('Said no')
    expect(cache.events().map((event) => event.title)).toContain('Daily Scrum')
    const ranged = await cache.range(Date.parse('2026-10-30T00:00:00Z'), Date.parse('2026-10-31T00:00:00Z'))
    expect(ranged?.find((event) => event.title === 'Said no')?.response).toBe('declined')
  })

  it('the same meeting on two calendars keeps the copy he did not decline', async () => {
    const at = { start: { dateTime: '2026-10-30T10:00:00Z' }, end: { dateTime: '2026-10-30T11:00:00Z' } }
    const no = connectReply('GOOGLECALENDAR_EVENTS_LIST', { summary: 'me@home.example', items: [{ id: 'a', summary: 'Board', ...at, attendees: [{ self: true, responseStatus: 'declined' }] }] })
    const yes = connectReply('OUTLOOK_GET_CALENDAR_VIEW', { value: [{ id: 'b', subject: 'Board', start: { dateTime: '2026-10-30T10:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-30T11:00:00.0000000', timeZone: 'UTC' }, responseStatus: { response: 'accepted' } }] })
    const cache = new CalendarCache({
      source: composioCalendarSource(apps([{ id: 'g', app: 'googlecalendar' }, { id: 'o', app: 'outlook', label: 'me@work.example' }], { GOOGLECALENDAR_EVENTS_LIST: () => no, OUTLOOK_GET_CALENDAR_VIEW: () => yes })),
      now: () => Date.parse('2026-10-30T08:00:00Z'),
    })
    await cache.refresh()
    expect(cache.events().map((event) => [event.title, event.response, event.account])).toEqual([['Board', 'accepted', 'me@work.example']])
  })

  it('calendar_events (and so every mini-app granted it) returns the new fields', async () => {
    const cache = new CalendarCache({
      source: composioCalendarSource(apps([{ id: 'g', app: 'googlecalendar' }, { id: 'o', app: 'outlook', label: 'me@company.example' }], { GOOGLECALENDAR_EVENTS_LIST: () => GOOGLE, OUTLOOK_GET_CALENDAR_VIEW: () => OUTLOOK })),
    })
    const [tool] = calendarTools(() => cache, () => Date.parse('2026-10-29T00:00:00Z'))
    const out = JSON.parse(String(await tool?.run({ from: '2026-10-29', to: '2026-11-05' }, {} as never))) as { events: Array<Record<string, unknown>> }
    expect(out.events.find((event) => event['title'] === 'Weekly Project Feedback')).toEqual({
      id: 'o1',
      title: 'Weekly Project Feedback',
      start: '2026-10-29T17:30:00.000Z',
      end: '2026-10-29T18:30:00.000Z',
      where: 'Teams',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_x',
      organiser: { name: 'Thabo M', email: 'thabo@company.example', self: false },
      response: 'needsAction',
      calendar: 'outlook',
      account: 'me@company.example',
    })
    expect(out.events.find((event) => event['title'] === 'Daily Scrum')).toMatchObject({ joinUrl: 'https://meet.google.com/orv-brcz-qfw', response: 'needsAction', calendar: 'googlecalendar', account: 'me@work.example' })
    expect(String(tool?.spec.description)).toMatch(/joinUrl.*organiser.*response.*account/s)
  })
})

describe('the look check waits for the first data', () => {
  /** A fake clock: sleep moves time on and runs what was due. */
  function clock() {
    let t = 1_000
    const due: Array<{ at: number; run: () => void }> = []
    return {
      now: () => t,
      at: (ms: number, run: () => void) => due.push({ at: t + ms, run }),
      sleep: async (ms: number) => {
        t += ms
        for (const job of due.filter((one) => one.at <= t)) {
          due.splice(due.indexOf(job), 1)
          job.run()
        }
      },
    }
  }

  it('shoots as soon as the app says agent.ready()', async () => {
    const c = clock()
    const watch = new CheckWatch(c.now())
    watch.sent({ op: 'call', id: 1 }, c.now())
    c.at(800, () => watch.sent({ op: 'ready' }, c.now()))
    const out = await waitForFirstData({ watch, lastMutation: async () => c.now(), now: c.now, sleep: c.sleep })
    expect(out.how).toBe('ready')
    expect(out.ms).toBeLessThan(1_100)
  })

  it('without ready: never while a call is unanswered; once answered and the page is still', async () => {
    const c = clock()
    const watch = new CheckWatch(c.now())
    let mutated = c.now()
    watch.sent({ op: 'call', id: 1 }, c.now())
    // The calendar answers after 4 s (slower than the old fixed 1.5 s), then the page draws for 300 ms.
    c.at(4_000, () => {
      watch.replied(c.now())
      mutated = c.now()
    })
    c.at(4_300, () => (mutated = c.now()))
    const out = await waitForFirstData({ watch, lastMutation: async () => mutated, now: c.now, sleep: c.sleep })
    expect(out.how).toBe('data')
    expect(out.ms).toBeGreaterThanOrEqual(4_300 + 500)
    expect(out.ms).toBeLessThan(5_200)
  })

  it('a call made from the answer of the first is waited for too', async () => {
    const c = clock()
    const watch = new CheckWatch(c.now())
    watch.sent({ op: 'call', id: 1 }, c.now())
    c.at(1_000, () => {
      watch.replied(c.now())
      watch.sent({ op: 'call', id: 2 }, c.now())
    })
    c.at(3_000, () => watch.replied(c.now()))
    const out = await waitForFirstData({ watch, lastMutation: async () => 0, now: c.now, sleep: c.sleep })
    expect(out.how).toBe('data')
    expect(out.ms).toBeGreaterThanOrEqual(3_500)
  })

  it('an app that asks for nothing is shot once still; one that never gets its answer times out and says so', async () => {
    const c = clock()
    const still = await waitForFirstData({ watch: new CheckWatch(c.now()), lastMutation: async () => 0, now: c.now, sleep: c.sleep })
    expect(still.how).toBe('still')
    expect(still.ms).toBeLessThan(1_500)

    const c2 = clock()
    const watch = new CheckWatch(c2.now())
    watch.sent({ op: 'call', id: 1 }, c2.now())
    const out = await waitForFirstData({ watch, lastMutation: async () => 0, now: c2.now, sleep: c2.sleep, limitMs: 6_000 })
    expect(out).toMatchObject({ how: 'timeout', inflight: 1 })
    expect(out.ms).toBeGreaterThanOrEqual(6_000)
  })

  it('the bridge gives every app agent.ready(), which tells the host once', () => {
    const posted: string[] = []
    const listeners: Record<string, () => void> = {}
    const window: Record<string, unknown> = {
      __miniappHost: { post: (text: string) => posted.push(text), onMessage: () => undefined },
      addEventListener: (name: string, fn: () => void) => (listeners[name] = fn),
      parent: null,
    }
    window['window'] = window
    const sandbox = {
      window,
      location: { search: '?theme=dark' },
      URLSearchParams,
      document: { documentElement: { setAttribute: () => undefined, style: { setProperty: () => undefined } } },
      console,
    }
    runInNewContext(agentJs(), sandbox)
    const agent = window['agent'] as { ready: () => void }
    expect(typeof agent.ready).toBe('function')
    agent.ready()
    agent.ready()
    expect(posted.map((text) => JSON.parse(text).op)).toEqual(['hello', 'ready'])
  })
})
