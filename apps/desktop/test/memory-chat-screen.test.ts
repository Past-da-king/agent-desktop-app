import { describe, expect, it } from 'vitest'

import type { ChatItem } from '@agent/core'

import { dividerNote, noteLine, visibleThread } from '../src/renderer/lib/chat-memory'

let at = 0
const row = (kind: string, text: string, meta: Record<string, unknown> = {}): ChatItem => ({ id: `r${(at += 1)}`, createdAt: at, kind, text, meta: JSON.stringify(meta) })

describe('the chat screen after New chat', () => {
  it('shows only the newest chat, keeps waiting cards, and hides nothing for good', () => {
    const old1 = row('user', 'old question')
    const old2 = row('agent', 'old answer')
    const waiting = row('approval', 'Send the email?', { summary: 'Send the email' })
    const answered = row('question', 'Which one?', { answer: 'Blue' })
    const divider = row('notice', 'New chat', { divider: true, memory: { chat: old1.id, status: 'done', saved: ['a', 'b', 'c'] } })
    const fresh = row('user', 'new question')
    const all = [old1, old2, waiting, answered, divider, fresh]
    expect(visibleThread(all, false)).toEqual({ rows: [waiting, divider, fresh], earlier: 3 })
    expect(visibleThread(all, true)).toEqual({ rows: all, earlier: 0 })
    expect(visibleThread([old1, old2], false)).toEqual({ rows: [old1, old2], earlier: 0 })
  })

  it('words the saved note plainly', () => {
    const note = (memory: unknown): ReturnType<typeof dividerNote> => dividerNote(row('notice', 'New chat', { divider: true, memory }))
    expect(noteLine(note({ chat: 'c', status: 'saving' }) ?? { status: 'saving', saved: [], error: '' })).toBe('Saving the last chat to memory')
    expect(noteLine(note({ chat: 'c', status: 'done', saved: ['a', 'b', 'c'] })!)).toBe('Saved 3 memories from the last chat')
    expect(noteLine(note({ chat: 'c', status: 'done', saved: ['a'] })!)).toBe('Saved 1 memory from the last chat')
    expect(noteLine(note({ chat: 'c', status: 'done', saved: [] })!)).toBe('Nothing in the last chat needed remembering')
    expect(noteLine(note({ chat: 'c', status: 'failed', error: 'x' })!)).toBe('Could not save the last chat to memory')
    expect(note(undefined)).toBeNull()
  })
})
