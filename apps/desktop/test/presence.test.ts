/**
 * Live presence on every message, and meetings that end early (decision of 26 Oct 2026).
 *
 * The note in front of each of his messages (time, device, activity, calendar now and next), the calendar read rarely
 * and cached, the one "is it over?" per meeting, an early end inferred conservatively or said outright, and the
 * meeting's follow-up job moved to now + 2 minutes once and never run twice. Also the runner (API path), the plan
 * path's prompt text, and the headless node.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type JsonObject, type Settings, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi, type RecordedRequest } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { buildSystemPrompt } from '../src/main/runtime/prompt'
import { Scheduler } from '../src/main/runtime/scheduler'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { FileKeyCipher } from '../src/headless/file-cipher'
import { startHeadlessRuntime } from '../src/headless/runtime'
import {
  CalendarCache,
  composioCalendarSource,
  parseGoogle,
  parseOutlook,
  type CalendarEvent,
  type CalendarSource,
} from '../src/main/presence/calendar'
import { advanceMeetingJob, jobsFor, localIso, sameTitle } from '../src/main/presence/meeting-jobs'
import { filePresenceState, Presence, type MeetingEndedEvent, type PresenceDeps } from '../src/main/presence/presence'
import { endedEvent } from '../src/main/presence/start'
import { secretsView, settingsView, testContext, toolNamed } from './support'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const ZONE = 'Africa/Johannesburg'
const MIN = 60_000
/** Mon 26 Oct 2026, 11:18 in Johannesburg. */
const NOW = Date.parse('2026-10-26T09:18:00Z')
const SCRUM: CalendarEvent = { id: 'ev-scrum', title: 'Grow Factory - Daily Scrum', start: Date.parse('2026-10-26T09:00:00Z'), end: Date.parse('2026-10-26T09:30:00Z'), where: 'Google Meet', source: 'googlecalendar' }
const FEEDBACK: CalendarEvent = { id: 'ev-feedback', title: 'Weekly Project Feedback', start: Date.parse('2026-10-29T17:30:00Z'), end: Date.parse('2026-10-29T18:30:00Z'), where: '', source: 'googlecalendar' }

const stores: Store[] = []
const dirs: string[] = []
const closers: Array<() => Promise<void> | void> = []
let fake: FakeAi | null = null

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await fake?.close()
  fake = null
  delete process.env['AGENT_FAKE_CALENDAR']
})

function newStore(): Store {
  const store = new Store(':memory:')
  stores.push(store)
  return store
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'presence-'))
  dirs.push(dir)
  return dir
}

/** A calendar source that counts its reads. */
function countingSource(events: CalendarEvent[] | null | (() => CalendarEvent[] | null)): CalendarSource & { calls: number } {
  const source = {
    calls: 0,
    async events() {
      source.calls += 1
      return typeof events === 'function' ? events() : events
    },
  }
  return source
}

async function cacheWith(events: CalendarEvent[] | null, now: () => number = () => NOW): Promise<CalendarCache> {
  const cache = new CalendarCache({ source: countingSource(events), now })
  await cache.refresh()
  return cache
}

/** One of his messages at a moment (createdAt pinned), optionally from another device or another agent. */
async function hisMessage(store: Store, at: number, extra: JsonObject = {}): Promise<string> {
  const meta = JSON.stringify(extra)
  await store.upsert('chat_item', { kind: 'user', text: 'hey', meta, createdAt: at } as never)
  return meta
}

function presence(store: Store, calendar: CalendarCache | null, patch: Partial<PresenceDeps> = {}): Presence {
  return new Presence({ store, calendar, now: () => NOW, timeZone: ZONE, selfId: () => 'pc-1', isFocused: () => true, idleSeconds: () => 4, ...patch })
}

function job(name: string, spec: string, extra: Partial<TriggerRow> = {}): Partial<TriggerRow> {
  return { name, kind: 'at', spec, prompt: `Process ONE meeting: ${name}`, enabled: true, lastRunAt: null, lastResult: '', ...extra }
}

const PHONE = { origin: { deviceId: 'phone-1', name: 'Pixel 8', kind: 'phone', platform: 'android', screenWidth: 412, canOpenLinks: true, canReceiveFiles: true } }

describe('the presence note', () => {
  it('says the time, the device, how active he is, and what is on now and next', async () => {
    const store = newStore()
    for (const ago of [9, 7, 5, 3, 2]) await hisMessage(store, NOW - ago * MIN)
    const meta = await hisMessage(store, NOW)
    const note = await presence(store, await cacheWith([SCRUM, FEEDBACK])).note('main', meta)
    expect(note.startsWith('[Presence (from the app, not typed by him): ')).toBe(true)
    expect(note.endsWith(']')).toBe(true)
    expect(note).toContain('Now 11:18 Mon 26 Oct 2026.')
    expect(note).toContain('Typing on this computer (app window focused, at the keyboard).')
    expect(note).toContain('Active: 6 messages in the last 10 min.')
    expect(note).toContain('Calendar: "Grow Factory - Daily Scrum" 11:00 to 11:30 (Google Meet), 18 min in')
    expect(note).toContain('Then next "Weekly Project Feedback" Thu 19:30.')
    // Short and cheap: one line, a few hundred characters.
    expect(note.split('\n')).toHaveLength(1)
    expect(note.length).toBeLessThan(700)
  })

  it('names the device he typed on: his phone, this computer idle, or a server', async () => {
    const store = newStore()
    const cache = await cacheWith([])
    const fromPhone = await hisMessage(store, NOW, PHONE)
    expect(await presence(store, cache).note('main', fromPhone)).toContain('Typing on his phone (Pixel 8).')
    const here = await hisMessage(store, NOW, { origin: { ...PHONE.origin, deviceId: 'pc-1', kind: 'desktop', name: 'Desk' } })
    expect(await presence(store, cache, { isFocused: () => false, idleSeconds: () => 300 }).note('main', here)).toContain(
      'Typing on this computer (app window not focused, computer idle 5 min).',
    )
    // No origin at all (Devices off): typed here.
    expect(await presence(store, cache).note('main', '{}')).toContain('Typing on this computer')
    // The headless node has no window and no keyboard.
    expect(await presence(store, cache, { server: true, isFocused: undefined, idleSeconds: undefined }).note('main', '{}')).toContain('Typing on this server.')
  })

  it('counts only his own messages in the last 10 minutes, in every chat', async () => {
    const store = newStore()
    await hisMessage(store, NOW - 30 * MIN) // too old
    await hisMessage(store, NOW - 4 * MIN, { chat: 'pc-project' }) // a project chat counts
    await hisMessage(store, NOW - 2 * MIN, { via: { kind: 'agent', name: 'Main' } }) // another agent, not him
    await hisMessage(store, NOW - 1 * MIN)
    const note = await presence(store, await cacheWith([])).note('main', '{}')
    expect(note).toContain('2 messages from him in the last 10 min.')
  })

  it('has no calendar line when no calendar is connected or none could ever be read', async () => {
    const store = newStore()
    expect(await presence(store, null).note()).not.toContain('Calendar')
    expect(await presence(store, await cacheWith(null)).note()).not.toContain('Calendar')
    const failing = new CalendarCache({ source: { events: async () => Promise.reject(new Error('down')) }, now: () => NOW })
    await failing.refresh()
    expect(await presence(store, failing).note()).not.toContain('Calendar')
    // A calendar that was read but is empty does say so.
    expect(await presence(store, await cacheWith([])).note()).toContain('Calendar: nothing on now or later this week.')
  })
})

describe('the calendar cache', () => {
  it('reads once, not once per message, and keeps the last good read when a refresh fails', async () => {
    const store = newStore()
    let broken = false
    const source = countingSource(() => {
      if (broken) throw new Error('offline')
      return [SCRUM]
    })
    const cache = new CalendarCache({ source, now: () => NOW })
    await cache.refresh()
    const p = presence(store, cache)
    for (let i = 0; i < 10; i += 1) await p.note('main', await hisMessage(store, NOW - i * 1000))
    expect(source.calls).toBe(1)
    broken = true
    await cache.refresh()
    expect(source.calls).toBe(2)
    expect(cache.events().map((event) => event.id)).toEqual(['ev-scrum'])
  })

  it('refreshes on its schedule, and just after a cached event ends', async () => {
    vi.useFakeTimers()
    try {
      let clock = NOW
      const source = countingSource([{ ...SCRUM, end: NOW + 2 * MIN }])
      const cache = new CalendarCache({ source, now: () => clock, refreshMs: 20 * MIN })
      cache.start()
      await vi.advanceTimersByTimeAsync(10)
      expect(source.calls).toBe(1)
      // The meeting ends at +2 min: one read just after it.
      clock += 3 * MIN
      await vi.advanceTimersByTimeAsync(3 * MIN)
      expect(source.calls).toBe(2)
      clock += 20 * MIN
      await vi.advanceTimersByTimeAsync(20 * MIN)
      expect(source.calls).toBe(3)
      cache.stop()
      await vi.advanceTimersByTimeAsync(60 * MIN)
      expect(source.calls).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads every connected calendar the person lets agents read, through his connected apps', async () => {
    const calls: Array<{ slug: string; args: JsonObject; account: string | null }> = []
    const google = JSON.stringify({ data: { items: [
      { id: 'g1', summary: 'Daily Scrum', start: { dateTime: '2026-10-26T11:00:00+02:00' }, end: { dateTime: '2026-10-26T11:30:00+02:00' }, hangoutLink: 'https://meet.google.com/x' },
      { id: 'g2', summary: 'Holiday', start: { date: '2026-10-27' }, end: { date: '2026-10-28' } },
      { id: 'g3', summary: 'Cancelled one', status: 'cancelled', start: { dateTime: '2026-10-26T12:00:00+02:00' }, end: { dateTime: '2026-10-26T13:00:00+02:00' } },
      { id: 'g4', summary: 'Declined one', attendees: [{ self: true, responseStatus: 'declined' }], start: { dateTime: '2026-10-26T14:00:00+02:00' }, end: { dateTime: '2026-10-26T15:00:00+02:00' } },
    ] }, successful: true })
    const outlook = JSON.stringify({ data: { response_data: { value: [
      { id: 'o1', subject: 'Standup', start: { dateTime: '2026-10-26T18:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-26T18:15:00.0000000', timeZone: 'UTC' }, onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/x' } },
      { id: 'o2', subject: 'All day', isAllDay: true, start: { dateTime: '2026-10-27T00:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-28T00:00:00.0000000', timeZone: 'UTC' } },
    ] } } })
    const source = composioCalendarSource({
      activeAccounts: async (apps) => {
        expect(apps).toEqual(['googlecalendar', 'outlook'])
        return [
          { id: 'acc-g', app: 'googlecalendar' },
          { id: 'acc-o', app: 'outlook' },
          { id: 'acc-asks', app: 'googlecalendar' },
        ]
      },
      rulesFor: (id) => ({ read: id === 'acc-asks' ? 'ask' : 'allow', change: 'allow' }),
      backend: () => ({
        execute: async (slug, args, account) => {
          calls.push({ slug, args, account })
          return { ok: true, text: slug.startsWith('OUTLOOK') ? outlook : google }
        },
      }),
    })
    const events = await source.events(NOW - 60 * MIN, NOW + 7 * 24 * 60 * MIN)
    expect(calls.map((call) => `${call.slug}@${call.account}`)).toEqual(['GOOGLECALENDAR_EVENTS_LIST@acc-g', 'OUTLOOK_GET_CALENDAR_VIEW@acc-o'])
    expect(events.map((event) => [event.title, new Date(event.start).toISOString(), event.where])).toEqual([
      ['Daily Scrum', '2026-10-26T09:00:00.000Z', 'Google Meet'],
      ['Standup', '2026-10-26T18:00:00.000Z', 'Teams'],
    ])
    // Nothing connected: null, so the note has no calendar line.
    expect(await composioCalendarSource({ activeAccounts: async () => [], backend: () => ({ execute: async () => ({ ok: true, text: '' }) }) }).events(0, 1)).toBeNull()
    expect(await composioCalendarSource({ activeAccounts: async () => [], backend: () => null }).events(0, 1)).toBeNull()
    expect(parseGoogle('not json')).toEqual([])
    expect(parseOutlook('{}')).toEqual([])
  })
})

describe('one question per meeting', () => {
  it('offers the question once, then every later note says it was already asked, across a restart', async () => {
    const store = newStore()
    const dir = tempDir()
    const cache = await cacheWith([SCRUM, FEEDBACK])
    const first = presence(store, cache, { state: filePresenceState(join(dir, 'presence.json')) })
    const one = await first.note('main', await hisMessage(store, NOW))
    expect(one).toContain('You may ask ONCE, briefly, whether it is still on')
    const two = await first.note('main', await hisMessage(store, NOW + 1000))
    expect(two).not.toContain('You may ask ONCE')
    expect(two).toContain('You were already offered the one question about this meeting at 11:18: do not ask again.')
    // The app restarts: the mark is kept.
    const again = presence(store, cache, { state: filePresenceState(join(dir, 'presence.json')), now: () => NOW + 3 * MIN })
    const three = await again.note('main', await hisMessage(store, NOW + 3 * MIN))
    expect(three).toContain('already offered')
    expect(three).not.toContain('You may ask ONCE')
  })

  it('does not offer it in the first minutes of a meeting', async () => {
    const store = newStore()
    const early = presence(store, await cacheWith([SCRUM]), { now: () => SCRUM.start + 2 * MIN })
    const note = await early.note('main', await hisMessage(store, SCRUM.start + 2 * MIN))
    expect(note).toContain('2 min in.')
    expect(note).not.toContain('ask')
  })

  it('the system prompt carries the rule; the note never goes in it', () => {
    const system = buildSystemPrompt({ settings: { ...DEFAULT_SETTINGS }, now: new Date(NOW), platform: 'win32', memories: [], goals: [], tasks: [], latestUserText: 'hi', role: 'main', promptRules: [] })
    expect(system).toContain('WHERE THE USER IS')
    expect(system).toContain('ONCE')
    expect(system).toContain('meeting_ended')
    expect(system).not.toContain('[Presence (from the app')
    const helper = buildSystemPrompt({ settings: { ...DEFAULT_SETTINGS }, now: new Date(NOW), platform: 'win32', memories: [], goals: [], tasks: [], latestUserText: 'hi', role: 'helper', promptRules: [] })
    expect(helper).not.toContain('WHERE THE USER IS')
  })
})

describe('a meeting that ends early', () => {
  const HOUR: CalendarEvent = { id: 'ev-hour', title: 'Priorities for the Week', start: Date.parse('2026-10-26T09:00:00Z'), end: Date.parse('2026-10-26T10:00:00Z'), where: 'Teams', source: 'outlook' }

  it('is inferred only when he has clearly been back for a while, past half way', async () => {
    const at = HOUR.start + 36 * MIN
    // Past half way but only 3 messages: still in the meeting as far as the app knows.
    const quiet = newStore()
    for (const ago of [5, 3, 1]) await hisMessage(quiet, at - ago * MIN)
    const ended: MeetingEndedEvent[] = []
    const note = await presence(quiet, await cacheWith([HOUR]), { now: () => at, onEnded: (event) => ended.push(event) }).note('main', '{}')
    expect(note).not.toContain('ended early')
    expect(ended).toHaveLength(0)
    // Many messages, but before half way: not inferred either.
    const before = newStore()
    for (let i = 0; i < 8; i += 1) await hisMessage(before, HOUR.start + 20 * MIN + i * 30_000)
    expect(await presence(before, await cacheWith([HOUR]), { now: () => HOUR.start + 25 * MIN }).note('main', '{}')).not.toContain('ended early')
    // Five since half way, four of them in the last ten minutes: it ended early.
    const busy = newStore()
    await busy.upsert('trigger', job('Meeting: Priorities for the Week 2026-10-26', localIso(HOUR.end + 5 * MIN)) as never)
    for (const ago of [6, 4, 3, 2, 1]) await hisMessage(busy, at - ago * MIN)
    const inferred = await presence(busy, await cacheWith([HOUR]), { now: () => at, onEnded: (event) => ended.push(event) }).note('main', '{}')
    expect(inferred).toContain('it looks like it ended early')
    expect(inferred).toContain('Do not ask about it.')
    expect(ended.map((event) => event.how)).toEqual(['inferred'])
    expect(ended[0]?.job.moved).toBe(true)
  })

  it('he says it is over: the follow-up job moves to now + 2 min, once, and the event goes out once', async () => {
    const store = newStore()
    const at = SCRUM.start + 20 * MIN
    await store.upsert('trigger', job('Meeting: Grow Factory - Daily Scrum 2026-10-26', localIso(SCRUM.end + 5 * MIN)) as never)
    await store.upsert('trigger', job('Meeting: Grow Factory - Daily Scrum 2026-10-27', localIso(SCRUM.end + 24 * 60 * MIN + 5 * MIN)) as never)
    await store.upsert('trigger', job('Meeting: Weekly Project Feedback 2026-10-29', localIso(FEEDBACK.end + 5 * MIN)) as never)
    const ended: MeetingEndedEvent[] = []
    const p = presence(store, await cacheWith([SCRUM, FEEDBACK]), { now: () => at, onEnded: (event) => ended.push(event) })
    const tool = toolNamed(buildToolset({ store, presence: p }), 'meeting_ended')
    const said = await tool.run({}, testContext())
    expect(said).toContain('Marked "Grow Factory - Daily Scrum" as ended at 11:20.')
    expect(said).toContain('now runs at 11:22 instead of 11:35')
    const rows = await store.list('trigger')
    const moved = rows.find((row) => row.name.endsWith('2026-10-26'))
    expect(Date.parse(moved?.spec ?? '')).toBe(at + 2 * MIN)
    expect(moved?.movedEarly?.from).toBe(localIso(SCRUM.end + 5 * MIN))
    // Tomorrow's scrum and Thursday's meeting are untouched.
    expect(rows.find((row) => row.name.endsWith('2026-10-27'))?.spec).toBe(localIso(SCRUM.end + 24 * 60 * MIN + 5 * MIN))
    expect(rows.find((row) => row.name.includes('Feedback'))?.movedEarly).toBeUndefined()
    // Said again: nothing changes, no second event.
    expect(await tool.run({ title: 'daily scrum' }, testContext())).toContain('already marked as ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]?.how).toBe('said')
    const event = endedEvent(ended[0]!)
    expect(event.source).toBe('presence')
    expect(event.event).toBe('meeting.ended_early')
    expect(event.dedupeKey).toBe('meeting-ended:ev-scrum')
    // The note now says it ended and not to ask.
    expect(await p.note('main', '{}')).toContain('ended early at 11:20 (he said so). Do not ask about it.')
  })

  it('a moved job runs once at its new time, and its old time never fires', async () => {
    const store = newStore()
    let clock = SCRUM.start + 20 * MIN
    const original = localIso(SCRUM.end + 5 * MIN)
    await store.upsert('trigger', job('Meeting: Grow Factory - Daily Scrum 2026-10-26', original) as never)
    const runs: string[] = []
    const scheduler = new Scheduler({ store, now: () => clock, runner: { runRoutine: async (trigger) => (runs.push(trigger.name), { text: 'Processed.', waiting: false }) } })
    const p = presence(store, await cacheWith([SCRUM], () => clock), { now: () => clock })
    await p.meetingEnded({}, 'said')
    await scheduler.tick()
    expect(runs).toHaveLength(0)
    clock += 2 * MIN + 1000
    await scheduler.tick()
    expect(runs).toEqual(['Meeting: Grow Factory - Daily Scrum 2026-10-26'])
    // Its original time comes and goes: nothing more.
    clock = SCRUM.end + 6 * MIN
    await scheduler.tick()
    clock += 60 * MIN
    await scheduler.tick()
    expect(runs).toHaveLength(1)
    // And a second early end changes nothing.
    expect(await advanceMeetingJob(store, { eventId: SCRUM.id, title: SCRUM.title, start: SCRUM.start, end: SCRUM.end }, clock, 'again')).toMatchObject({ moved: false, why: 'already-moved' })
  })

  it('a meeting with no job does nothing; the job is matched by event id first, then by date and a close title', async () => {
    const store = newStore()
    const at = SCRUM.start + 20 * MIN
    expect(await presence(store, await cacheWith([SCRUM]), { now: () => at }).meetingEnded({}, 'said')).toContain('It has no follow-up job.')
    expect(await store.list('trigger')).toHaveLength(0)
    expect(sameTitle('Grow Factory - Daily Scrum', 'grow factory daily scrum')).toBe(true)
    expect(sameTitle('Daily Scrum', 'Grow Factory - Daily Scrum')).toBe(true)
    expect(sameTitle('Weekly Project Feedback', 'Daily Scrum')).toBe(false)
    const rows = [
      { ...job('Meeting: Something renamed 2026-10-26', '2026-10-26T13:00'), id: 'by-id', eventId: 'ev-scrum' },
      { ...job('Meeting: Grow Factory Daily Scrum 2026-10-26 (probe +17)', '2026-10-26T13:30'), id: 'probe' },
      { ...job('Meeting: Grow Factory Daily Scrum 2026-10-26', '2026-10-26T13:35'), id: 'plain' },
      { ...job('Meeting: Grow Factory Daily Scrum 2026-10-25', '2026-10-25T13:35'), id: 'yesterday' },
      { ...job('Meeting: Other 2026-10-26', '2026-10-26T13:35'), id: 'other', eventId: 'ev-other' },
    ] as TriggerRow[]
    // With the event id: the job that carries it (even under another name), and only jobs without an id otherwise.
    expect(jobsFor(rows, { eventId: 'ev-scrum', title: SCRUM.title, start: SCRUM.start, end: SCRUM.end }).map((row) => row.id)).toEqual(['by-id', 'plain', 'probe'])
    // Without one: by name, the plain job before its retry.
    expect(jobsFor(rows, { eventId: '', title: SCRUM.title, start: SCRUM.start, end: SCRUM.end }).map((row) => row.id)).toEqual(['plain', 'probe'])
  })
})

describe('the runner and the headless node', () => {
  function lastUserText(request: RecordedRequest | undefined): string {
    const messages = Array.isArray(request?.body['messages']) ? (request?.body['messages'] as Array<Record<string, unknown>>) : []
    const users = messages.filter((message) => message['role'] === 'user')
    const content = users[users.length - 1]?.['content']
    if (typeof content === 'string') return content
    return Array.isArray(content) ? content.map((part) => String((part as Record<string, unknown>)['text'] ?? '')).join('') : ''
  }
  function systemOf(request: RecordedRequest | undefined): string {
    const messages = Array.isArray(request?.body['messages']) ? (request?.body['messages'] as Array<Record<string, unknown>>) : []
    const system = messages.find((message) => message['role'] === 'system')
    return typeof system?.['content'] === 'string' ? system['content'] : ''
  }

  it('every message of his carries the note (the request shows it), another agent\'s does not', async () => {
    fake = await startFakeAi(() => ({ text: 'Noted.' }))
    const store = newStore()
    const live: CalendarEvent = { ...SCRUM, start: Date.now() - 10 * MIN, end: Date.now() + 20 * MIN }
    const cache = await cacheWith([live], Date.now)
    const p = new Presence({ store, calendar: cache, timeZone: ZONE, isFocused: () => true, idleSeconds: () => 0 })
    const settings: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }
    const runner = new Runner({
      store,
      settings: settingsView(settings),
      secrets: secretsView('k'),
      tools: buildToolset({ store, presence: p }),
      providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
      isFocused: () => false,
      presence: p,
    })
    closers.push(() => runner.dispose())
    await runner.send('first')
    await runner.send('second')
    await runner.send('third')
    expect(fake.requests).toHaveLength(3)
    const notes = fake.requests.map(lastUserText)
    for (const text of notes) expect(text).toMatch(/^\[Presence \(from the app, not typed by him\): Now \d\d:\d\d /)
    expect(notes[0]).toContain('"Grow Factory - Daily Scrum"')
    expect(notes[0]).toContain('You may ask ONCE')
    expect(notes[1]).toContain('already offered')
    expect(notes[2]).toContain('Active: 3 messages in the last 10 min.')
    expect(notes[2]).toMatch(/\]\n\nthird$/)
    for (const request of fake.requests) expect(systemOf(request)).not.toContain('[Presence (from the app')
    expect(toolNamed(buildToolset({ store, presence: p }), 'meeting_ended')).toBeDefined()
    // Another agent writing into the chat: no note.
    await runner.receive('main', 'From the project chat: done.', { kind: 'agent', name: 'Project' } as never)
    await waitFor(() => fake!.requests.length === 4, 10_000)
    expect(lastUserText(fake.requests[3])).not.toContain('[Presence')
  })

  it('the headless node builds the note too, with its own calendar and no window', async () => {
    fake = await startFakeAi(() => ({ text: 'Fine.' }))
    const dir = tempDir()
    const calendarFile = join(dir, 'calendar.json')
    writeFileSync(calendarFile, JSON.stringify([{ id: 'ev-1', title: 'Server side standup', start: new Date(Date.now() - 10 * MIN).toISOString(), end: new Date(Date.now() + 20 * MIN).toISOString(), where: 'Zoom' }]))
    process.env['AGENT_FAKE_CALENDAR'] = calendarFile
    const settings = new SettingsStore(join(dir, 'settings.json'))
    settings.save({ hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false })
    new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key'))).set('apiKey', 'test-key')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
    const runtime = await startHeadlessRuntime({
      dataDir: dir,
      appDir: root,
      version: '9.9.9',
      quiet: true,
      chromium: null,
      providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
    })
    closers.push(() => runtime.stop(0))
    expect(toolNamed(runtime.mainTools, 'meeting_ended')).toBeDefined()
    await waitFor(async () => {
      await runtime.runner.send('ping')
      return lastUserText(fake!.requests[fake!.requests.length - 1]).includes('Server side standup')
    }, 10_000)
    const text = lastUserText(fake.requests[fake.requests.length - 1])
    expect(text).toContain('[Presence (from the app, not typed by him): ')
    expect(text).toContain('Typing on this server.')
    expect(text).toContain('(Zoom)')
  })

  it('routine_create keeps the calendar event id of a meeting job', async () => {
    const store = newStore()
    const tool = toolNamed(buildToolset({ store }), 'routine_create')
    await tool.run({ name: 'Meeting: Daily Scrum 2099-01-01', kind: 'at', spec: '2099-01-01T11:35', prompt: 'Process it.', event_id: 'ev-42' }, testContext())
    expect((await store.list('trigger'))[0]?.eventId).toBe('ev-42')
  })
})
