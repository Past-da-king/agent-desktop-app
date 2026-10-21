import {
  DEFAULT_SETTINGS,
  type ChatItem,
  type EntityMap,
  type GoalRow,
  type MemoryRow,
  type Settings,
  type TaskRow,
  type TriggerRow,
} from '@agent/core'

import { openUiDemo } from './openui-demo'

export type DemoMode = 'fresh' | 'demo' | 'empty' | 'big'

export interface SeedResult {
  settings: Settings
  rows: { [E in keyof EntityMap]: Array<EntityMap[E]> }
}

const DAY = 86_400_000
const HOUR = 3_600_000

/**
 * The page the mock bridge pretends the agent opened. Only the browser preview uses it; the real
 * app shows the live page in the panel instead.
 */
export interface SkyHopFlight {
  time: string
  code: string
  fare: string
  selected: boolean
}

export const skyHopDemo = {
  brand: 'SkyHop',
  action: 'Sign in',
  route: 'Johannesburg to Durban, Fri 30 Oct',
  flights: [
    { time: '06:05', code: 'SH 151', fare: 'R 899', selected: true },
    { time: '07:30', code: 'BA 220', fare: 'R 1,020', selected: false },
    { time: '09:40', code: 'SH 157', fare: 'R 1,049', selected: false },
  ] as SkyHopFlight[],
} as const

/** Only the query string chooses a mode; everything else is a fresh install. */
export function readMode(search: string): DemoMode {
  const demo = new URLSearchParams(search).get('demo')
  if (demo === 'empty') return 'empty'
  if (demo === 'big') return 'big'
  if (demo === '1') return 'demo'
  return 'fresh'
}

export function freshSettings(): Settings {
  return { ...DEFAULT_SETTINGS, deviceName: 'This computer' }
}

export function demoSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    mode: 'api_key',
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    hasKey: true,
    hasVoiceKey: true,
    userName: 'Sam',
    agentName: 'Nova',
    accent: 'iris',
    mascot: 'scout',
    theme: 'system',
    onboarded: true,
    signedIn: true,
    syncEmail: 'sam@example.com',
    deviceName: 'Windows 11',
    quickAskHotkey: 'CommandOrControl+Alt+Left',
    dictateHotkey: 'Alt+Space',
    dictateCleanHotkey: 'CommandOrControl+Alt+C',
    launchAtLogin: true,
    closeToTray: true,
    notifications: true,
  }
}

function task(
  id: string,
  title: string,
  notes: string,
  status: TaskRow['status'],
  dueAt: number | null,
  updatedAt: number,
  extra: Partial<TaskRow> = {},
): TaskRow {
  return {
    id,
    createdAt: updatedAt,
    goalId: null,
    title,
    notes,
    status,
    dueAt,
    owner: 'user',
    blocker: '',
    updatedAt,
    ...extra,
  }
}

export function demoRows(): SeedResult['rows'] {
  const now = Date.now()
  const today = new Date(now)
  today.setHours(19, 43, 0, 0)
  const soon = (days: number, hour = 9): number => {
    const date = new Date(now + days * DAY)
    date.setHours(hour, 0, 0, 0)
    return date.getTime()
  }

  const goals: GoalRow[] = [
    { id: 'g1', createdAt: now - 6 * DAY, title: 'Plan the Durban trip', why: 'A long weekend away', status: 'open' },
    {
      id: 'g2',
      createdAt: now - 21 * DAY,
      title: "Apply for a Master's in Computer Science for 2027",
      why: 'Keep learning',
      status: 'open',
    },
    { id: 'g3', createdAt: now - 40 * DAY, title: 'Tidy up the Acme invoices', why: 'Clean books', status: 'open' },
  ]

  const tasks: TaskRow[] = [
    task(
      't1',
      'Send Lerato the invoice',
      'Lerato runs the books at Acme and takes invoices on the 25th. The draft is in your Acme folder.',
      'todo',
      today.getTime(),
      now - 2 * HOUR,
      { goalId: 'g3' },
    ),
    task(
      't2',
      "Renew driver's licence",
      'Booking slots open at 08:00 on weekdays. Bring your ID and an eye-test certificate.',
      'todo',
      soon(6, 20),
      now - DAY,
      { dueAt: soon(6, 20) },
    ),
    task('t3', 'Buy a gift for Nomsa', 'Nomsa turns 30 on Saturday. She likes ceramics and anything from local makers.', 'todo', soon(7), now - 2 * DAY),
    task('t4', 'Shortlist 3 guesthouses in Durban', 'Near the beachfront, breakfast included, under R 1,400 a night.', 'todo', soon(8), now - 3 * DAY),
    task('a1', 'Find the cheapest morning flights', 'Morning only, window seats.', 'done', null, now - 5 * HOUR, { owner: 'agent', goalId: 'g1' }),
    task('a2', 'Pick a guesthouse', 'Three are shortlisted. Waiting for your pick.', 'blocked', null, now - 4 * HOUR, {
      owner: 'agent',
      goalId: 'g1',
      blocker: 'Which guesthouse should I book?',
    }),
    task('a3', 'Book a hire car', 'After the guesthouse is chosen.', 'todo', null, now - 4 * HOUR, { owner: 'agent', goalId: 'g1' }),
    task('a4', 'Shortlist 3 universities', 'Looked at entrance requirements and deadlines.', 'done', null, now - 9 * DAY, { owner: 'agent', goalId: 'g2' }),
    task('a5', 'Check entry requirements', 'Transcripts and references are listed.', 'todo', null, now - 9 * DAY, { owner: 'agent', goalId: 'g2' }),
    task('a6', 'Draft the personal statement', 'Start with the why.', 'todo', null, now - 9 * DAY, { owner: 'agent', goalId: 'g2' }),
    task('a7', 'Request references', 'Two academic references.', 'todo', null, now - 9 * DAY, { owner: 'agent', goalId: 'g2' }),
    task('a8', 'Submit applications', 'Before the end of March.', 'todo', null, now - 9 * DAY, { owner: 'agent', goalId: 'g2' }),
    task('a9', "Collect last month's receipts", 'From the shared Acme folder.', 'done', null, now - 11 * DAY, { owner: 'agent', goalId: 'g3' }),
    task('a10', 'Match them to bank lines', 'Twelve receipts matched.', 'done', null, now - 10 * DAY, { owner: 'agent', goalId: 'g3' }),
    task('a11', 'Send the summary to Lerato', 'Waits for the invoice run on the 25th.', 'todo', null, now - 10 * DAY, { owner: 'agent', goalId: 'g3' }),
  ]

  const memories: MemoryRow[] = [
    {
      id: 'm1',
      createdAt: now - 3 * DAY,
      title: 'Sam',
      body: 'Sam Dlamini runs product at [[Acme]] and lives in Johannesburg. Prefers short answers and window seats. [[Lerato]] is his sister.',
      kind: 'person',
      topics: 'sam, work',
      pinned: true,
      source: 'agent',
      updatedAt: now - 3 * DAY,
    },
    {
      id: 'm2',
      createdAt: now - 2 * DAY,
      title: 'Lerato',
      body: "Lerato is Sam's sister. She runs the books at [[Acme]]; invoices go to her on the 25th.",
      kind: 'person',
      topics: 'family, acme',
      pinned: false,
      source: 'agent',
      updatedAt: now - 1 * HOUR,
    },
    {
      id: 'm3',
      createdAt: now - 8 * DAY,
      title: 'Acme',
      body: 'A fintech company where [[Sam]] works. Office in Rosebank. Invoices are handled by [[Lerato]].',
      kind: 'fact',
      topics: 'work, acme',
      pinned: false,
      source: 'agent',
      updatedAt: now - DAY,
    },
    {
      id: 'm4',
      createdAt: now - 10 * DAY,
      title: 'Seat preference',
      body: 'Window seats, no red-eye flights. Applies to [[Sam]] on every trip.',
      kind: 'preference',
      topics: 'travel, flights',
      pinned: false,
      source: 'user',
      updatedAt: now - 10 * 60_000,
    },
    {
      id: 'm5',
      createdAt: now - 4 * DAY,
      title: 'Nomsa',
      body: "Sam's friend. Turns 30 on Saturday 31 October. Likes ceramics and local makers.",
      kind: 'person',
      topics: 'friends, birthdays',
      pinned: false,
      source: 'agent',
      updatedAt: now - 2 * DAY,
    },
    {
      id: 'm6',
      createdAt: now - 20 * DAY,
      title: 'Invoice day',
      body: 'Invoices go out on the 25th, always as PDF, copied to [[Sam]]. [[Lerato]] sends them from [[Acme]].',
      kind: 'preference',
      topics: 'finance, invoices',
      pinned: false,
      source: 'user',
      updatedAt: now - 7 * DAY,
    },
  ]

  const triggers: TriggerRow[] = [
    {
      id: 'r1',
      createdAt: now - 30 * DAY,
      name: 'Morning brief',
      kind: 'daily',
      spec: '07:00',
      prompt: 'Look at my calendar, inbox and to-dos, then tell me what needs me today.',
      enabled: true,
      lastRunAt: now - 9 * HOUR,
      lastResult: 'Found 3 things that need you',
    },
    {
      id: 'r2',
      createdAt: now - 30 * DAY,
      name: 'Inbox sweep',
      kind: 'daily',
      spec: '12:30',
      prompt: 'Clear the noise from my inbox and flag anything that needs a reply.',
      enabled: true,
      lastRunAt: now - 3 * HOUR,
      lastResult: 'Archived 14, flagged 2',
    },
    {
      id: 'r3',
      createdAt: now - 30 * DAY,
      name: 'Weekly review',
      kind: 'at',
      spec: new Date(soon(3, 16)).toISOString(),
      prompt: 'Summarise the week: what moved, what is stuck, and what is next.',
      enabled: false,
      lastRunAt: null,
      lastResult: 'Not run yet',
    },
  ]

  const chat: ChatItem[] = [
    {
      id: 'c0',
      createdAt: now - 30_000,
      kind: 'branch',
      text: 'Durban trip: flights',
      meta: JSON.stringify({ title: 'Durban trip: flights', device: 'phone', at: now - 30_000, active: true }),
    },
    {
      id: 'c0b',
      createdAt: now - 4 * HOUR,
      kind: 'branch',
      text: 'Acme invoices',
      meta: JSON.stringify({ title: 'Acme invoices', device: 'desk', at: now - HOUR, active: false }),
    },
    {
      id: 'c0c',
      createdAt: now - DAY,
      kind: 'branch',
      text: 'Gift ideas for Nomsa',
      meta: JSON.stringify({ title: 'Gift ideas for Nomsa', device: 'phone', at: now - DAY, active: false }),
    },
    {
      id: 'c0d',
      createdAt: now - 2 * DAY,
      kind: 'branch',
      text: 'Weekly review',
      meta: JSON.stringify({ title: 'Weekly review', device: 'desk', at: now - 2 * DAY, active: false }),
    },
    {
      id: 'c0e',
      createdAt: now - 4 * DAY,
      kind: 'branch',
      text: "Driver's licence renewal",
      meta: JSON.stringify({ title: "Driver's licence renewal", device: 'phone', at: now - 4 * DAY, active: false }),
    },
    {
      id: 'c1',
      createdAt: now - 3 * HOUR + 60_000,
      kind: 'question',
      text: 'Which guesthouse should I book?',
      meta: JSON.stringify({ options: ['Ocean Breeze', 'The Palms'], answer: '', context: 'home' }),
    },
    {
      id: 'c2',
      createdAt: now - 2 * HOUR,
      kind: 'notice',
      text: 'Started on your phone at 09:12, continued here',
      meta: JSON.stringify({ from: 'phone', startedAt: '09:12' }),
    },
    {
      id: 'c3',
      createdAt: now - 2 * HOUR + 60_000,
      kind: 'user',
      text: 'Find me the three cheapest flights from Joburg to Durban on Friday 30 October, morning only',
      meta: JSON.stringify({
        attachments: [
          { path: 'C:\\Users\\You\\Pictures\\october-trip.png', name: 'october-trip.png', mime: 'image/png' },
        ],
      }),
    },
    {
      id: 'c4',
      createdAt: now - 2 * HOUR + 2 * 60_000,
      kind: 'activity',
      text: 'Searched memory for “flight preferences”, 2 found',
      meta: JSON.stringify({ tool: 'memory_search', status: 'done', summary: 'Searched memory for “flight preferences”, 2 found' }),
    },
    {
      id: 'c5',
      createdAt: now - 2 * HOUR + 3 * 60_000,
      kind: 'agent',
      text: "Here's what I found for **Friday 30 October**, before noon:\n\n1. **SkyHop 06:05**, R 899 (window seats left)\n2. **Breeze Air 07:30**, R 1,020\n3. **SkyHop 09:40**, R 1,049\n\nPrices checked just now. Want me to hold the 06:05?",
      meta: '{}',
    },
    {
      id: 'c5v',
      createdAt: now - 2 * HOUR + 3 * 60_000 + 10_000,
      kind: 'voice_note',
      text: "Hey Sam. Good news on Durban. <short pause> The cheapest morning flight is SkyHop at five past six, eight hundred and ninety nine rand, and there are still window seats. The other two are a bit pricier and later. <short pause> I can hold the early one for you, just say the word.",
      meta: JSON.stringify({ file: 'demo.wav', durationMs: 14_000, style: 'upbeat and pleased, quick' }),
    },
    {
      id: 'c5b',
      createdAt: now - 2 * HOUR + 3 * 60_000 + 30_000,
      kind: 'report',
      text: 'Durban trip: what I found',
      meta: JSON.stringify({
        title: 'Durban trip: what I found',
        markdown:
          '# Durban trip: what I found\n\n## Morning flights\n\n- **SkyHop 06:05**, R 899, window seats left\n- **Breeze Air 07:30**, R 1,020\n- **SkyHop 09:40**, R 1,049\n\nPrices were checked just now. The 06:05 is the best value and gives you the whole morning.\n\n## Guesthouse\n\nOcean Breeze has a quiet room from R 1,150 a night, two minutes from the beach.',
        words: 68,
      }),
    },
    {
      id: 'c6',
      createdAt: now - 2 * HOUR + 4 * 60_000,
      kind: 'user',
      text: 'Yes, hold the 06:05',
      meta: '{}',
    },
    {
      id: 'c6b',
      createdAt: now - 2 * HOUR + 4 * 60_000 + 30_000,
      kind: 'question',
      text: 'Do you want a window seat on the way back too?',
      meta: JSON.stringify({ options: ['Yes, a window', 'No preference'], answer: '' }),
    },
    {
      id: 'c6a',
      createdAt: now - 2 * HOUR + 4 * 60_000 + 40_000,
      kind: 'approval',
      text: 'Read C:\\Users\\sam\\Documents',
      meta: JSON.stringify({ summary: 'Read C:\\Users\\sam\\Documents', details: '', decision: 'approve', scope: 'computer' }),
    },
    {
      id: 'c6b',
      createdAt: now - 2 * HOUR + 4 * 60_000 + 42_000,
      kind: 'activity',
      text: 'Read 3 files',
      meta: JSON.stringify({ tool: 'files_read', status: 'done', summary: 'Read 3 files in Documents' }),
    },
    {
      id: 'c6c',
      createdAt: now - 2 * HOUR + 4 * 60_000 + 44_000,
      kind: 'approval',
      text: 'Run python code',
      meta: JSON.stringify({ summary: 'Run python code', details: 'print(1)', decision: 'approve', scope: 'computer' }),
    },
    {
      id: 'c6d',
      createdAt: now - 2 * HOUR + 4 * 60_000 + 50_000,
      kind: 'approval',
      text: 'Run python code',
      meta: JSON.stringify({
        summary: 'Run python code',
        details: "import urllib.request\nUA = 'Mozilla/5.0'\ndef get(u):\n    req = urllib.request.Request(u, headers={'User-Agent': UA})\n    return urllib.request.urlopen(req, timeout=20).read()[:600]\nfor u in ['https://example.com', 'https://www.takealot.com/']:\n    print(u, get(u))\n    print('---')",
        decision: '',
        scope: 'computer',
      }),
    },
    {
      id: 'c7',
      createdAt: now - 2 * HOUR + 5 * 60_000,
      kind: 'approval',
      text: 'Book SkyHop SH 151, Fri 30 Oct, 06:05',
      meta: JSON.stringify({
        summary: 'Book SkyHop SH 151, Fri 30 Oct, 06:05',
        details: 'Passenger: Sam Dlamini\nSeat: 14A (window)\nFare: R 899 incl. taxes\nPay with: card ending 4821',
        decision: '',
      }),
    },
    {
      id: 'c8',
      createdAt: now - 80_000,
      kind: 'helper',
      text: 'Check Ocean Breeze and The Palms for a quiet room near the beach, two nights, under R 1,400 a night.',
      meta: JSON.stringify({
        id: 'c8',
        label: 'Guesthouse check',
        state: 'working',
        summary: 'Checking The Palms',
        queued: false,
        startedAt: now - 80_000,
        model: 'claude-sonnet-5-5',
      }),
    },
    {
      id: 'c8a',
      createdAt: now - 70_000,
      kind: 'activity',
      text: 'Opened Ocean Breeze, 2 rooms free',
      meta: JSON.stringify({
        tool: 'web_fetch',
        status: 'done',
        summary: 'Opened Ocean Breeze, 2 rooms free',
        helper: 'c8',
        by: 'Guesthouse check',
      }),
    },
    {
      id: 'c8b',
      createdAt: now - 60_000,
      kind: 'activity',
      text: 'Checking The Palms',
      meta: JSON.stringify({
        tool: 'web_fetch',
        status: 'running',
        summary: 'Checking The Palms',
        helper: 'c8',
        by: 'Guesthouse check',
      }),
    },
    {
      id: 'c9',
      createdAt: now - 50_000,
      kind: 'helper',
      text: 'Compare the three cheapest morning flights from Joburg to Durban on Friday 30 October.',
      meta: JSON.stringify({
        id: 'c9',
        label: 'Airline comparison',
        state: 'done',
        summary: 'Compared 3 airlines',
        queued: false,
        startedAt: now - 6 * 60_000,
        endedAt: now - 40_000,
        model: 'claude-sonnet-5-5',
        result: 'SkyHop 06:05 is the best value at R 899, with window seats left.',
      }),
    },
    {
      id: 'c9a',
      createdAt: now - 45_000,
      kind: 'activity',
      text: 'Read SkyHop, Breeze Air and FlySA fares',
      meta: JSON.stringify({
        tool: 'web_fetch',
        status: 'done',
        summary: 'Read SkyHop, Breeze Air and FlySA fares',
        helper: 'c9',
        by: 'Airline comparison',
      }),
    },
    // Answers drawn as cards (OpenUI), the way the agent writes them.
    ...openUiDemo(now),
  ]

  return {
    chat_item: chat,
    turn: [],
    memory: memories,
    goal: goals,
    task: tasks,
    trigger: triggers,
  }
}

const LONG_ONE =
  'Quarterlyreconciliationofeveryoutstandinginvoiceandsupplierstatementacrossthreebusinessunitsbeforetheaudit'

/** Extra rows for `?demo=big`: long titles, long lists, and enough data to scroll every view. */
export function bigRows(base: SeedResult['rows']): SeedResult['rows'] {
  const now = Date.now()
  const tasks: TaskRow[] = [...base.task]
  for (let i = 0; i < 40; i += 1) {
    const long = i % 7 === 0
    const title = long
      ? i === 0
        ? `${LONG_ONE}${i}`
        : `${LONG_ONE} number ${i}`
      : i % 5 === 0
        ? `Follow up with the supplier about the outstanding delivery note and the revised quote number ${i}`
        : `Follow up on task ${i + 1}`
    tasks.push(
      task(`big-t${i}`, title, 'A longer note so the detail view has something real to show.', i % 4 === 0 ? 'done' : 'todo', now + (i - 10) * DAY, now - i * HOUR, {
        owner: i % 6 === 0 ? 'agent' : 'user',
        goalId: i % 6 === 0 ? 'g1' : null,
      }),
    )
  }

  const memories: MemoryRow[] = [...base.memory]
  for (let i = 0; i < 40; i += 1) {
    const long = i % 8 === 0
    memories.push({
      id: `big-m${i}`,
      createdAt: now - i * HOUR,
      title: long ? `Notes from the long planning session number ${i} about suppliers and invoices` : `Page ${i + 1}`,
      body: `A note the agent keeps about the world. It links to [[Sam]] and [[Acme]] when the topic comes up. Added for the long-list state, entry ${i + 1}.`,
      kind: i % 5 === 0 ? 'decision' : i % 3 === 0 ? 'how-to' : 'fact',
      topics: 'demo, long list',
      pinned: false,
      source: 'agent',
      updatedAt: now - i * HOUR,
    })
  }

  const triggers: TriggerRow[] = [...base.trigger]
  for (let i = 0; i < 12; i += 1) {
    triggers.push({
      id: `big-r${i}`,
      createdAt: now - i * DAY,
      name: `Routine number ${i + 1}`,
      kind: i % 3 === 0 ? 'interval' : 'daily',
      spec: i % 3 === 0 ? String(30 + i * 15) : `0${(i % 6) + 1}:15`,
      prompt: 'A routine for the long-list state.',
      enabled: i % 4 !== 0,
      lastRunAt: i % 2 === 0 ? now - i * HOUR : null,
      lastResult: i % 3 === 0 ? 'Not run yet' : `Last: found ${i + 1} things`,
    })
  }

  const chat: ChatItem[] = [...base.chat_item]
  for (let i = 0; i < 60; i += 1) {
    chat.push({
      id: `big-c${i}`,
      createdAt: now - (60 - i) * 60_000,
      kind: i % 2 === 0 ? 'user' : 'agent',
      text:
        i % 2 === 0
          ? i % 9 === 0
            ? `${LONG_ONE} and what to do about it`
            : `Message ${i + 1} in a longer conversation about the trip and the invoices.`
          : `Reply ${i + 1}. Everything is on track. I will tell you when something needs your approval.`,
      meta: '{}',
    })
  }

  return { ...base, task: tasks, memory: memories, trigger: triggers, chat_item: chat }
}

export function seedFor(mode: DemoMode): SeedResult {
  if (mode === 'fresh') {
    return {
      settings: freshSettings(),
      rows: { chat_item: [], turn: [], memory: [], goal: [], task: [], trigger: [] },
    }
  }
  if (mode === 'empty') {
    return {
      settings: demoSettings(),
      rows: { chat_item: [], turn: [], memory: [], goal: [], task: [], trigger: [] },
    }
  }
  const rows = demoRows()
  return { settings: demoSettings(), rows: mode === 'big' ? bigRows(rows) : rows }
}
