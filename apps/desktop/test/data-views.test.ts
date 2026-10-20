import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemoryRow, TaskRow } from '@agent/core'
import { dateInputValue, dueAtFromDateInput, nextRun, scheduleLabel } from '../src/renderer/lib/format'
import { findPage, linkedNames, linkTargets, newPage, plainBody, searchMemories } from '../src/renderer/lib/memory'
import { dueSoon, openUserTasks, sortTasks, userTasks } from '../src/renderer/lib/tasks'
import { clearToasts, toast, useToast } from '../src/renderer/state/useToast'

function memory(partial: Partial<MemoryRow> & { id: string; title: string }): MemoryRow {
  return {
    createdAt: 1,
    body: '',
    kind: 'fact',
    topics: '',
    pinned: false,
    source: 'agent',
    updatedAt: 1,
    ...partial,
  }
}

function task(partial: Partial<TaskRow> & { id: string; title: string }): TaskRow {
  return {
    createdAt: 1,
    goalId: null,
    notes: '',
    status: 'todo',
    dueAt: null,
    owner: 'user',
    blocker: '',
    updatedAt: 1,
    ...partial,
  }
}

describe('memory search', () => {
  const rows = [
    memory({ id: 'm1', title: 'Sam', body: 'Runs product at [[Acme]]', topics: 'work', updatedAt: 10 }),
    memory({ id: 'm2', title: 'Invoice day', body: 'Always the 25th', topics: 'finance, acme', updatedAt: 30, pinned: true }),
    memory({ id: 'm3', title: 'Nomsa', body: 'Likes ceramics', topics: 'friends', updatedAt: 20 }),
  ]

  it('matches title, body and topics, ignoring case', () => {
    expect(searchMemories(rows, 'acme').map((row) => row.id)).toEqual(['m2', 'm1'])
    expect(searchMemories(rows, 'CERAMICS').map((row) => row.id)).toEqual(['m3'])
    expect(searchMemories(rows, 'finance').map((row) => row.id)).toEqual(['m2'])
  })

  it('filters by kind before sorting and keeps pinned pages first', () => {
    expect(searchMemories(rows, '', 'fact').map((row) => row.id)).toEqual(['m2', 'm3', 'm1'])
    const decisions = [memory({ id: 'd1', title: 'A', kind: 'decision', updatedAt: 50 }), rows[0]!]
    expect(searchMemories(decisions, '', 'decision').map((row) => row.id)).toEqual(['d1'])
  })

  it('sorts the rest newest first', () => {
    expect(searchMemories(rows, '').map((row) => row.id)).toEqual(['m2', 'm3', 'm1'])
  })
})

describe('memory links', () => {
  const all = [
    memory({ id: 'sam', title: 'Sam', body: 'Works at [[Acme]] and knows [[Nomsa]]' }),
    memory({ id: 'acme', title: 'Acme', body: 'A company' }),
    memory({ id: 'nomsa', title: 'Nomsa', body: '' }),
  ]

  it('reads linked names once each, in order', () => {
    expect(linkedNames('[[Sam]] and [[Acme]] and [[Sam]]')).toEqual(['Sam', 'Acme'])
    expect(plainBody('Works at [[Acme]]')).toBe('Works at Acme')
  })

  it('resolves links case-insensitively and ignores missing pages', () => {
    expect(findPage(all, 'acme')?.id).toBe('acme')
    expect(linkTargets(all[0]!, all).map((row) => row.id)).toEqual(['acme', 'nomsa'])
    expect(linkTargets(all[0]!, all.slice(0, 1))).toEqual([])
  })

  it('makes a plain page for a create-on-click link', () => {
    const page = newPage('Cape Town', 123)
    expect(page).toMatchObject({ title: 'Cape Town', body: '', kind: 'fact', pinned: false, source: 'user', createdAt: 123 })
  })
})

describe('task ordering', () => {
  const rows = [
    task({ id: 'later', title: 'Later', dueAt: 300 }),
    task({ id: 'done', title: 'Done', status: 'done', dueAt: 100 }),
    task({ id: 'none', title: 'No date' }),
    task({ id: 'soon', title: 'Soon', dueAt: 200 }),
    task({ id: 'agent', title: 'Agent step', owner: 'agent', dueAt: 50 }),
  ]

  it('puts open work first, then soonest due, with no date last', () => {
    expect(sortTasks(rows).map((row) => row.id)).toEqual(['agent', 'soon', 'later', 'none', 'done'])
  })

  it('keeps only the person\'s own to-dos', () => {
    expect(userTasks(rows).map((row) => row.id)).toEqual(['soon', 'later', 'none', 'done'])
    expect(openUserTasks(rows).map((row) => row.id)).toEqual(['soon', 'later', 'none'])
  })
})

describe('date input', () => {
  it('round trips a local date and keeps the time of day', () => {
    const previous = new Date(2026, 9, 20, 19, 43).getTime()
    const value = dateInputValue(previous)
    expect(value).toBe('2026-10-20')
    expect(dueAtFromDateInput('2026-10-24', previous)).toBe(new Date(2026, 9, 24, 19, 43).getTime())
  })

  it('uses 09:00 for a new date and clears on an empty value', () => {
    expect(dueAtFromDateInput('2026-10-24', null)).toBe(new Date(2026, 9, 24, 9, 0).getTime())
    expect(dueAtFromDateInput('', 123)).toBeNull()
    expect(dateInputValue(null)).toBe('')
  })

  it('flags a due date within the next day, but not a done one', () => {
    const now = new Date(2026, 9, 20, 9, 0).getTime()
    expect(dueSoon({ dueAt: now + 3600_000, status: 'todo' }, now)).toBe(true)
    expect(dueSoon({ dueAt: now + 3600_000, status: 'done' }, now)).toBe(false)
    expect(dueSoon({ dueAt: null, status: 'todo' }, now)).toBe(false)
  })

  it('names routine schedules in plain words', () => {
    expect(scheduleLabel({ kind: 'daily', spec: '07:00' })).toBe('Every day at 07:00')
    expect(scheduleLabel({ kind: 'interval', spec: '90' })).toBe('Every 90 minutes')
    expect(nextRun({ kind: 'interval', spec: '30', enabled: false, lastRunAt: null })).toBeNull()
  })
})

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    clearToasts()
  })

  afterEach(() => {
    clearToasts()
    vi.useRealTimers()
  })

  it('adds a toast and expires it on its own', () => {
    toast('Saved')
    expect(useToast.getState().toasts).toHaveLength(1)
    vi.advanceTimersByTime(7000)
    expect(useToast.getState().toasts).toHaveLength(0)
  })

  it('dismisses one without touching the others', () => {
    const first = toast('First', { actionLabel: 'Undo', onAction: vi.fn() })
    toast('Second')
    useToast.getState().dismiss(first)
    expect(useToast.getState().toasts.map((item) => item.message)).toEqual(['Second'])
  })
})
