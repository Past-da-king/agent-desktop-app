/**
 * The chat view's split selection: a helper's step row (or a row of another chat) leaves the conversation's rows the
 * very same objects, so the view's shallow compare says "nothing new" and no message row is drawn again; a reply
 * shows at once. And a step left "running" in an idle chat reads as interrupted, never while a card waits.
 */
import { describe, expect, it } from 'vitest'
import { shallow } from 'zustand/shallow'

import type { ChatItem } from '@agent/core'

import { chatIsIdle, helperStepRowsOf, mergeRows, rowsSelector, shownStepStatus, threadRowsOf } from '../src/renderer/lib/chat-rows'
import { patched } from '../src/renderer/lib/patch'

let clock = 1_000
function row(id: string, kind: string, meta: Record<string, unknown> = {}, text = id): ChatItem {
  clock += 10
  return { id, kind, text, meta: JSON.stringify(meta), createdAt: clock, updatedAt: clock } as ChatItem
}

const seed = (): ChatItem[] => [
  row('u1', 'user'),
  row('t1', 'activity', { tool: 'shell_run', status: 'done' }),
  row('h1', 'helper', { state: 'working', label: 'Audit' }),
  row('hs1', 'activity', { helper: 'h1', status: 'done' }),
  row('a1', 'agent'),
  row('p1', 'agent', { chat: 'proj-1' }),
]

describe('threadRowsOf', () => {
  it('keeps the conversation and leaves out helper steps and other chats', () => {
    expect(threadRowsOf(seed(), 'main').map((item) => item.id)).toEqual(['u1', 't1', 'h1', 'a1'])
    expect(helperStepRowsOf(seed(), 'main').map((item) => item.id)).toEqual(['hs1'])
  })

  it('a helper step write changes nothing the conversation is drawn from', () => {
    let all = seed()
    const before = threadRowsOf(all, 'main')
    // 200 new helper steps, each also rewritten once (running, then done): 400 row writes.
    for (let i = 0; i < 200; i += 1) {
      const step = row(`hs-new-${i}`, 'activity', { helper: 'h1', status: 'running' })
      all = patched(all, { row: step })
      all = patched(all, { row: { ...step, meta: JSON.stringify({ helper: 'h1', status: 'done' }) } })
      const now = threadRowsOf(all, 'main')
      // What zustand's useShallow compares: same length, every row the very same object.
      expect(shallow(before, now)).toBe(true)
    }
    expect(threadRowsOf(all, 'main').every((item, index) => item === before[index])).toBe(true)
    expect(helperStepRowsOf(all, 'main')).toHaveLength(201)
  })

  it('a row written in another chat changes nothing either', () => {
    const all = seed()
    const before = threadRowsOf(all, 'main')
    const after = threadRowsOf(patched(all, { row: row('p2', 'agent', { chat: 'proj-1' }) }), 'main')
    expect(shallow(before, after)).toBe(true)
  })

  it('a reply, a main tool step and a changed row show at once', () => {
    const all = seed()
    const before = threadRowsOf(all, 'main')
    expect(shallow(before, threadRowsOf(patched(all, { row: row('a2', 'agent') }), 'main'))).toBe(false)
    expect(shallow(before, threadRowsOf(patched(all, { row: row('t2', 'activity', { tool: 'web_fetch', status: 'running' }) }), 'main'))).toBe(false)
    const edited = { ...(all[4] as ChatItem), text: 'longer' }
    expect(shallow(before, threadRowsOf(patched(all, { row: edited }), 'main'))).toBe(false)
    // The helper's own card row (state, summary) still reaches the thread: a side run draws from it.
    const helper = { ...(all[2] as ChatItem), meta: JSON.stringify({ state: 'done', label: 'Audit' }) }
    expect(shallow(before, threadRowsOf(patched(all, { row: helper }), 'main'))).toBe(false)
  })
})

describe('rowsSelector', () => {
  it('works a selection out once per list and per chat', () => {
    let runs = 0
    const pick = rowsSelector((all, chat) => {
      runs += 1
      return threadRowsOf(all, chat)
    })
    const all = seed()
    const first = pick(all, 'main')
    expect(pick(all, 'main')).toBe(first)
    expect(runs).toBe(1)
    pick(all, 'proj-1')
    pick(patched(all, { row: row('x', 'agent') }), 'proj-1')
    expect(runs).toBe(3)
  })
})

describe('mergeRows', () => {
  it('is the thread itself with no steps, and in time order with them', () => {
    const all = seed()
    const thread = threadRowsOf(all, 'main')
    expect(mergeRows(thread, [])).toBe(thread)
    expect(mergeRows(thread, helperStepRowsOf(all, 'main')).map((item) => item.id)).toEqual(['u1', 't1', 'h1', 'hs1', 'a1'])
  })
})

describe('a step left running', () => {
  const idle = { known: true, running: false, alongside: 0, waiting: 0 }
  it('reads as interrupted only when the chat neither works nor waits', () => {
    expect(shownStepStatus('running', chatIsIdle(idle))).toBe('interrupted')
    expect(shownStepStatus('running', chatIsIdle({ ...idle, running: true }))).toBe('running')
    // Waiting on an approval or a question: the step is truly still open, so it keeps spinning.
    expect(shownStepStatus('running', chatIsIdle({ ...idle, waiting: 1 }))).toBe('running')
    expect(shownStepStatus('running', chatIsIdle({ ...idle, alongside: 1 }))).toBe('running')
  })
  it('never guesses before the run states were read', () => {
    expect(shownStepStatus('running', chatIsIdle({ ...idle, known: false }))).toBe('running')
  })
  it('leaves finished and failed steps as they are', () => {
    expect(shownStepStatus('done', true)).toBe('done')
    expect(shownStepStatus('error', true)).toBe('error')
  })
})
