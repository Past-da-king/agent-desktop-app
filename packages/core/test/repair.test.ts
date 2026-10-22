import { describe, expect, it } from 'vitest'

import { flatten, repair } from '../src/repair'
import type { Msg } from '../src/model'

function userText(text: string): Msg {
  return { role: 'USER', blocks: [{ t: 'text', text }] }
}

describe('repair', () => {
  it('gives a missing tool result an interrupted stub', () => {
    const msgs: Msg[] = [
      userText('hi'),
      {
        role: 'ASSISTANT',
        blocks: [
          { t: 'call', id: 'a', name: 'now', input: {} },
          { t: 'call', id: 'b', name: 'now', input: {} },
        ],
      },
    ]

    const out = repair(msgs)

    expect(out).toHaveLength(3)
    expect(out[2]).toEqual({
      role: 'USER',
      blocks: [
        { t: 'result', id: 'a', content: expect.stringContaining('Interrupted'), err: true },
        { t: 'result', id: 'b', content: expect.stringContaining('Interrupted'), err: true },
      ],
    })
  })

  it('moves results found after an unrelated user message to straight after the call', () => {
    const msgs: Msg[] = [
      userText('hi'),
      { role: 'ASSISTANT', blocks: [{ t: 'call', id: 'a', name: 'now', input: {} }] },
      userText('still there?'),
      {
        role: 'USER',
        blocks: [{ t: 'result', id: 'a', content: 'noon', err: false }],
      },
    ]

    const out = repair(msgs)

    expect(out[2]).toEqual({
      role: 'USER',
      blocks: [{ t: 'result', id: 'a', content: 'noon', err: false }],
    })
    expect(out[3]).toEqual(userText('still there?'))
    expect(out).toHaveLength(4)
  })

  it('drops a result no call claims', () => {
    const msgs: Msg[] = [
      userText('hi'),
      {
        role: 'USER',
        blocks: [
          { t: 'result', id: 'stray', content: 'nothing asked for this', err: false },
          { t: 'text', text: 'kept' },
        ],
      },
    ]

    expect(repair(msgs)[1]).toEqual(userText('kept'))
  })

  it('keeps text before the last user message and drops its tool exchange', () => {
    const msgs: Msg[] = [
      userText('first'),
      { role: 'ASSISTANT', blocks: [{ t: 'call', id: 'a', name: 'now', input: {} }] },
      {
        role: 'USER',
        blocks: [
          { t: 'result', id: 'a', content: 'noon', err: false },
          { t: 'text', text: 'tool said noon' },
        ],
      },
      { role: 'ASSISTANT', blocks: [{ t: 'text', text: 'first answer' }] },
      userText('second'),
      { role: 'ASSISTANT', blocks: [{ t: 'call', id: 'b', name: 'now', input: {} }] },
    ]

    const out = flatten(msgs)

    expect(out).toEqual([
      userText('first'),
      userText('tool said noon'),
      { role: 'ASSISTANT', blocks: [{ t: 'text', text: 'first answer' }] },
      userText('second'),
      { role: 'ASSISTANT', blocks: [{ t: 'call', id: 'b', name: 'now', input: {} }] },
    ])
  })

  it('flatten leaves the current turn whole when it is the only user text', () => {
    const msgs: Msg[] = [
      userText('only'),
      { role: 'ASSISTANT', blocks: [{ t: 'call', id: 'a', name: 'now', input: {} }] },
      { role: 'USER', blocks: [{ t: 'result', id: 'a', content: 'noon', err: false }] },
    ]

    expect(flatten(msgs)).toEqual(msgs)
  })

  it('keeps reasoning with the words it explains, and drops a turn that was only thinking', () => {
    const msgs: Msg[] = [
      userText('first'),
      {
        role: 'ASSISTANT',
        blocks: [
          { t: 'reasoning', text: 'plan' },
          { t: 'text', text: 'looking' },
          { t: 'call', id: 'a', name: 'now', input: {} },
        ],
      },
      { role: 'USER', blocks: [{ t: 'result', id: 'a', content: 'noon', err: false }] },
      {
        role: 'ASSISTANT',
        blocks: [
          { t: 'reasoning', text: 'only thoughts' },
          { t: 'call', id: 'b', name: 'now', input: {} },
        ],
      },
      { role: 'USER', blocks: [{ t: 'result', id: 'b', content: 'one', err: false }] },
      userText('second'),
    ]
    expect(flatten(msgs)).toEqual([
      userText('first'),
      {
        role: 'ASSISTANT',
        blocks: [
          { t: 'reasoning', text: 'plan' },
          { t: 'text', text: 'looking' },
        ],
      },
      userText('second'),
    ])
  })
})
