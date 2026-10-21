import type { ChatItem } from '@agent/core'
import { describe, expect, it } from 'vitest'

import { seedFor } from '../src/renderer/bridge/seed'
import { cardsForIds } from '../src/renderer/lib/cards'
import { attachmentsOf, isDivider, threadItems, threadTitle } from '../src/renderer/lib/thread'

function row(
  id: string,
  kind: string,
  createdAt: number,
  meta: Record<string, unknown> = {},
  text = id,
): ChatItem {
  return { id, createdAt, kind, text, meta: JSON.stringify(meta) }
}

describe('chat thread', () => {
  it('orders the conversation and leaves branch markers out', () => {
    const items = [
      row('a', 'agent', 300, {}, 'second'),
      row('b', 'branch', 50, { title: 'A branch' }),
      row('c', 'user', 100, {}, 'first'),
    ]
    expect(threadItems(items).map((item) => item.id)).toEqual(['c', 'a'])
  })

  it('keeps Home-only questions out of the thread', () => {
    const items = [
      row('a', 'user', 100),
      row('b', 'question', 200, { options: ['One'], answer: '', context: 'home' }),
      row('c', 'question', 300, { options: ['Two'], answer: '' }),
    ]
    expect(threadItems(items).map((item) => item.id)).toEqual(['a', 'c'])
  })

  it('recognises a New chat divider but not an ordinary notice', () => {
    expect(isDivider(row('a', 'notice', 1, { divider: true }, 'New chat'))).toBe(true)
    expect(isDivider(row('b', 'notice', 2, {}, 'Stopped'))).toBe(false)
  })

  it('titles the chat from the active branch, then from the newest stretch', () => {
    const branched = [
      row('a', 'branch', 1, { title: 'Durban trip: flights', active: true }),
      row('b', 'user', 2, {}, 'Something else entirely'),
    ]
    expect(threadTitle(branched)).toBe('Durban trip: flights')

    const divided = [
      row('a', 'user', 1, {}, 'The first thing I said'),
      row('b', 'notice', 2, { divider: true }, 'New chat'),
      row('c', 'user', 3, {}, 'The newest thing I said'),
    ]
    expect(threadTitle(divided)).toBe('The newest thing I said')
    expect(threadTitle([...branched, row('c', 'notice', 3, { divider: true }, 'New chat')])).toBe('New chat')
    expect(threadTitle([row('a', 'user', 1, {}, 'Hello')])).toBe('Hello')
    expect(threadTitle([])).toBe('New chat')
  })

  it('reads attachment names from real rows and ignores the old count field', () => {
    const withFiles = row('a', 'user', 1, {
      attachments: [
        { path: 'C:\\Users\\You\\brief.pdf', name: 'brief.pdf', mime: 'application/pdf' },
        { name: 'photo.png' },
      ],
    })
    expect(attachmentsOf(withFiles).map((file) => file.name)).toEqual(['brief.pdf', 'photo.png'])
    expect(attachmentsOf(row('b', 'user', 2, { attachments: 2 }))).toEqual([])
    expect(attachmentsOf(row('c', 'user', 3))).toEqual([])
  })
})

describe('waiting cards', () => {
  const items = [
    row('q1', 'question', 100, { options: ['One'], answer: '' }),
    row('q2', 'question', 200, { options: ['Two'], answer: 'Two' }),
    row('a1', 'approval', 300, { summary: 'Send the invoice', decision: '' }),
    row('a2', 'approval', 400, { summary: 'Book the flight', decision: 'decline' }),
    row('h1', 'question', 500, { options: ['Three'], answer: '', context: 'home' }),
  ]

  it('returns only the ids the main process says are waiting', () => {
    expect(cardsForIds(items, ['q1', 'a1', 'a2']).map((item) => item.id)).toEqual(['q1', 'a1'])
  })

  it('still drops cards answered since that reading', () => {
    expect(cardsForIds(items, ['q1', 'q2', 'a1']).map((item) => item.id)).toEqual(['q1', 'a1'])
  })

  it('can leave Home-only cards out for the chat thread', () => {
    expect(cardsForIds(items, ['q1', 'h1'], true).map((item) => item.id)).toEqual(['q1'])
  })
})

describe('demo chat data', () => {
  it('shows every card kind the chat can draw', () => {
    const seed = seedFor('demo')
    const kinds = new Set(seed.rows.chat_item.map((item) => item.kind))
    for (const kind of ['user', 'agent', 'activity', 'question', 'approval', 'notice', 'report']) {
      expect(kinds.has(kind)).toBe(true)
    }
    expect(
      seed.rows.chat_item.some(
        (item) => item.kind === 'question' && (JSON.parse(item.meta) as { context?: string }).context !== 'home',
      ),
    ).toBe(true)
  })
})

describe('the thread window', () => {
  it('draws only the newest rows, keeps cards still waiting, and counts what is above', async () => {
    const { windowThread } = await import('../src/renderer/lib/chat-memory')
    const rows = Array.from({ length: 120 }, (_, i) => row(`r${i}`, i % 2 ? 'agent' : 'user', i + 1))
    rows[3] = row('q', 'question', 4, { options: ['Yes'], answer: '' })
    const { rows: drawn, above } = windowThread(rows, 80)
    expect(drawn).toHaveLength(81)
    expect(drawn[0]?.id).toBe('q')
    expect(drawn[1]?.id).toBe('r40')
    expect(above).toBe(39)
    // Everything fits: nothing hidden.
    expect(windowThread(rows.slice(0, 50), 80)).toEqual({ rows: rows.slice(0, 50), above: 0 })
    expect(windowThread(rows, Number.POSITIVE_INFINITY).above).toBe(0)
  })
})

describe('the boot hint', () => {
  it('remembers the look for the next start and survives junk', async () => {
    const { readBootHint, writeBootHint } = await import('../src/renderer/lib/boot-hint')
    const box = new Map<string, string>()
    const storage = { getItem: (k: string) => box.get(k) ?? null, setItem: (k: string, v: string) => void box.set(k, v) }
    expect(readBootHint(storage)).toBeNull()
    writeBootHint({ mascot: 'bloom', agentName: 'Hina', accent: 'violet', theme: 'dark' }, storage)
    expect(readBootHint(storage)).toEqual({ mascot: 'bloom', agentName: 'Hina', accent: 'violet', theme: 'dark' })
    box.set('agent.boot', '{not json')
    expect(readBootHint(storage)).toBeNull()
    box.set('agent.boot', JSON.stringify({ mascot: 'scout', agentName: 'Nova', theme: 'odd' }))
    expect(readBootHint(storage)).toEqual({ mascot: 'scout', agentName: 'Nova', accent: 'iris', theme: 'system' })
  })
})
