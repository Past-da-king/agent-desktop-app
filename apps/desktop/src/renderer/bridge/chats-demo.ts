import type { ChatItem } from '@agent/core'

/** Chat ids the demo uses, so screenshots can open one (?chat=...). */
export const DEMO_CHATS = {
  acme: 'cacmeinvoices01',
  gifts: 'cnomsagifts0001',
  review: 'cweeklyreview01',
  licence: 'clicencerenew01',
} as const

const MIN = 60_000
const HOUR = 60 * MIN

/**
 * Several chats for the browser preview: one busy with a job that took a message in and started another one
 * alongside, one with a reply not read yet, one waiting on an approval, and an older quiet one.
 */
export function multiChatDemo(now: number): ChatItem[] {
  const acme = { chat: DEMO_CHATS.acme }
  const gifts = { chat: DEMO_CHATS.gifts }
  const review = { chat: DEMO_CHATS.review }
  const licence = { chat: DEMO_CHATS.licence }
  return [
    {
      id: 'ma1',
      createdAt: now - 12 * MIN,
      kind: 'user',
      text: 'Go through the Acme invoices folder and tell me which ones are overdue',
      meta: JSON.stringify({
        ...acme,
        attachments: [
          { path: 'C:\\Users\\You\\Documents\\Acme\\statement-september.pdf', name: 'statement-september.pdf', mime: 'application/pdf', size: 412_000 },
          { path: 'C:\\Users\\You\\Documents\\Acme\\aging.xlsx', name: 'aging.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 38_400 },
        ],
      }),
    },
    {
      id: 'ma2',
      createdAt: now - 11 * MIN,
      kind: 'activity',
      text: 'Read statement-september.pdf',
      meta: JSON.stringify({ ...acme, tool: 'files_read', status: 'done', summary: 'Read statement-september.pdf' }),
    },
    {
      id: 'ma3',
      createdAt: now - 10 * MIN,
      kind: 'agent',
      text: 'Found 14 invoices in the folder. Checking each due date against the statement now.\n\n```text\nINV-2041  due 12 Sep  R 4,200\nINV-2047  due 19 Sep  R 12,850\nINV-2052  due 26 Sep  R 1,100\n```',
      meta: JSON.stringify(acme),
    },
    {
      id: 'ma4',
      createdAt: now - 6 * MIN,
      kind: 'user',
      text: 'Also flag anything over R 10,000 for me to call about',
      meta: JSON.stringify({ ...acme, route: 'join' }),
    },
    {
      id: 'ma5',
      createdAt: now - 5 * MIN,
      kind: 'activity',
      text: 'Read aging.xlsx',
      meta: JSON.stringify({ ...acme, tool: 'files_read', status: 'done', summary: 'Read aging.xlsx' }),
    },
    {
      id: 'ma6',
      createdAt: now - 4 * MIN,
      kind: 'user',
      text: "What's the weather in Durban on Friday?",
      meta: JSON.stringify({ ...acme, route: 'alongside', helper: 'ma7' }),
    },
    {
      id: 'ma7',
      createdAt: now - 4 * MIN + 2000,
      kind: 'helper',
      text: "What's the weather in Durban on Friday?",
      meta: JSON.stringify({
        ...acme,
        id: 'ma7',
        label: 'Weather in Durban',
        side: true,
        ask: 'ma6',
        state: 'done',
        summary: 'Done',
        startedAt: now - 4 * MIN,
        endedAt: now - 2 * MIN,
        result:
          'Friday in Durban looks warm and mostly dry: **26°C** high, **19°C** low, light north-easterly wind.\n\nThere is a 20% chance of a shower after 4 pm, so pack a light jacket for the evening.',
      }),
    },
    {
      id: 'ma7a',
      createdAt: now - 3 * MIN,
      kind: 'activity',
      text: 'Read the weather service forecast',
      meta: JSON.stringify({ ...acme, tool: 'web_fetch', status: 'done', summary: 'Read the weather service forecast', helper: 'ma7', by: 'Weather in Durban' }),
    },
    {
      id: 'ma7b',
      createdAt: now - 3 * MIN + 5000,
      kind: 'activity',
      text: 'Checked the rain radar',
      meta: JSON.stringify({ ...acme, tool: 'web_fetch', status: 'done', summary: 'Checked the rain radar', helper: 'ma7', by: 'Weather in Durban' }),
    },
    {
      id: 'mg1',
      createdAt: now - 40 * MIN,
      kind: 'user',
      text: 'Gift ideas for Nomsa, she loves gardening, under R 600',
      meta: JSON.stringify(gifts),
    },
    {
      id: 'mg2',
      createdAt: now - 8 * MIN,
      kind: 'agent',
      text: 'Three ideas under R 600:\n\n1. **A herb starter kit** with basil, coriander and mint, R 349\n2. **Japanese pruning shears**, R 520\n3. **A kneeling pad and tool belt**, R 410\n\nThe shears ship by Thursday.',
      meta: JSON.stringify(gifts),
    },
    {
      id: 'ml1',
      createdAt: now - 30 * MIN,
      kind: 'user',
      text: "Renew my driver's licence: book the first slot at the Randburg testing centre",
      meta: JSON.stringify(licence),
    },
    {
      id: 'ml2',
      createdAt: now - 29 * MIN,
      kind: 'approval',
      text: 'Book Randburg DLTC, Tue 3 Nov, 08:30',
      meta: JSON.stringify({ ...licence, summary: 'Book Randburg DLTC, Tue 3 Nov, 08:30', details: 'Fee: R 250, paid at the centre', decision: '' }),
    },
    {
      id: 'mr1',
      createdAt: now - 2 * 24 * HOUR,
      kind: 'user',
      text: 'Weekly review: what moved, what is stuck, what is next',
      meta: JSON.stringify(review),
    },
    {
      id: 'mr2',
      createdAt: now - 2 * 24 * HOUR + MIN,
      kind: 'agent',
      text: 'Moved: the Acme contract and the Durban trip. Stuck: the licence renewal. Next: the quarterly invoices.',
      meta: JSON.stringify(review),
    },
  ]
}
