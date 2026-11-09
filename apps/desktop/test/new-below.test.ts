/** The chat's "new messages" pill counts messages, never tool steps, helper events, cards, notices or dividers. */
import { describe, expect, it } from 'vitest'

import type { ChatItem } from '@agent/core'

import { countNewMessages, isMessageRow, newBelowLabel } from '../src/renderer/lib/new-below'

let clock = 1_000
function row(id: string, kind: string, text = 'x', meta: Record<string, unknown> = {}): ChatItem {
  clock += 1
  return { id, kind, text, meta: JSON.stringify(meta), createdAt: clock, updatedAt: clock } as ChatItem
}

describe('countNewMessages', () => {
  it('counts only his messages and the agent replies in a chat full of tool and helper events', () => {
    const before = [row('u1', 'user', 'Do the thing'), row('t1', 'activity', 'Reading files', { status: 'running' })]
    const seen = new Set(before.map((item) => item.id))
    const after: ChatItem[] = [
      ...before,
      // 40 tool steps of the main run
      ...Array.from({ length: 40 }, (_, index) => row(`tool-${index}`, 'activity', `Ran step ${index}`, { status: 'done', tool: 'shell_run' })),
      // a helper, its card and 60 of its steps
      row('h1', 'helper', 'Audit helper', { state: 'working', brief: 'Audit' }),
      ...Array.from({ length: 60 }, (_, index) => row(`hs-${index}`, 'activity', `Helper step ${index}`, { helper: 'h1', status: 'done' })),
      row('h1-say', 'agent', 'A line inside the helper', { helper: 'h1' }),
      // status rows, notices, a divider, cards, a branch marker, a change line, a call log
      row('n1', 'notice', 'Helper finished'),
      row('n2', 'notice', 'From your phone', { from: 'phone' }),
      row('d1', 'notice', 'New chat', { divider: true }),
      row('q1', 'question', 'Which one?', { options: ['A', 'B'] }),
      row('a1', 'approval', 'Send the mail', { summary: 'Send the mail', details: 'To: x' }),
      row('b1', 'branch', '', { active: true }),
      row('c1', 'activity', 'Rule added', { line: true }),
      row('call1', 'call', 'Call, 2 min'),
      row('empty', 'agent', '   '),
      // the three real messages
      row('m1', 'agent', 'Here is what I found.'),
      row('u2', 'user', 'Thanks, and the second part?'),
      row('r1', 'report', 'Audit report', { title: 'Audit' }),
    ]
    expect(countNewMessages(after, seen)).toBe(3)
  })

  it('does not count a row that was already there and changed, or the same id twice', () => {
    const first = row('m1', 'agent', 'Draft')
    const seen = new Set(['m1'])
    const edited = { ...first, text: 'Draft, now longer', updatedAt: first.updatedAt + 50 }
    const twice = row('m2', 'agent', 'Reply')
    expect(countNewMessages([edited, twice, { ...twice, text: 'Reply, edited' }], seen)).toBe(1)
  })

  it('counts voice notes, media and a visual reply as messages', () => {
    const items = [row('v1', 'voice_note', ''), row('p1', 'media', '', { kind: 'image', src: 'a.png' }), row('g1', 'agent', '', { visual: { type: 'table' } })]
    expect(items.every(isMessageRow)).toBe(true)
    expect(countNewMessages(items, new Set())).toBe(3)
  })

  it('is zero when nothing but work arrived', () => {
    const items = Array.from({ length: 500 }, (_, index) => row(`s-${index}`, 'activity', 'step', { status: 'done' }))
    expect(countNewMessages(items, new Set())).toBe(0)
  })
})

describe('newBelowLabel', () => {
  it('says the way down with no count, and the count in plain words', () => {
    expect(newBelowLabel(0)).toBe('Jump to latest')
    expect(newBelowLabel(1)).toBe('1 new message')
    expect(newBelowLabel(12)).toBe('12 new messages')
  })
})
