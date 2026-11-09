import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createWorkersChanged, type WorkersChanged } from '../src/main/workers/changed'
import { finishTime, typeTime } from '../src/renderer/lib/time-input'
import { workBadge } from '../src/renderer/lib/work-badge'
import { aboutWorker } from '../src/renderer/state/workersStore'

const src = (...parts: string[]): string => readFileSync(join(__dirname, '..', 'src', ...parts), 'utf8')

describe('one "Needs you" count everywhere', () => {
  it('the title bar number counts what its word names, never working plus waiting', () => {
    // The case on screen: 3 cards working, 6 waiting. It read "9 Needs you" beside a rail badge of 6.
    expect(workBadge({ working: 3, held: 0, replied: 0, waiting: 6 })).toEqual({ n: 6, word: 'Needs you' })
    expect(workBadge({ working: 3, held: 1, replied: 2, waiting: 0 })).toEqual({ n: 3, word: 'Working' })
    expect(workBadge({ working: 0, held: 2, replied: 1, waiting: 0 })).toEqual({ n: 2, word: 'Waiting' })
    expect(workBadge({ working: 0, held: 0, replied: 4, waiting: 0 })).toEqual({ n: 4, word: 'Replied' })
  })
  it('title bar, rail badge and Home all count the one waiting list (state/useWaiting)', () => {
    const menu = src('renderer', 'shell', 'WorkMenu.tsx')
    expect(menu).toContain('workBadge({ working, held, replied, waiting: waiting.length })')
    expect(menu).toContain('const waiting = useWaiting()')
    expect(menu).not.toContain('count + waiting.length')
    expect(src('renderer', 'shell', 'Shell.tsx')).toMatch(/export function useNeeds\(\): number \{\s*return useWaiting\(\)\.length/)
    const home = src('renderer', 'views', 'Home.tsx')
    expect(home).toContain('const needs = useWaiting()')
    expect(home).toContain('`${needs.length} things`')
  })
})

describe('worker change events name their worker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a burst is told once, with the workers it was about', () => {
    const sent: WorkersChanged[] = []
    const changed = createWorkersChanged((payload) => sent.push(payload), 300)
    changed('w_a')
    changed('w_a')
    changed('w_b')
    expect(sent).toEqual([])
    vi.advanceTimersByTime(300)
    expect(sent).toEqual([{ workers: ['w_a', 'w_b'] }])
    changed('w_c')
    vi.advanceTimersByTime(300)
    expect(sent[1]).toEqual({ workers: ['w_c'] })
  })
  it('a change with no worker means any of them', () => {
    const sent: WorkersChanged[] = []
    const changed = createWorkersChanged((payload) => sent.push(payload), 300)
    changed('w_a')
    changed()
    vi.advanceTimersByTime(300)
    expect(sent).toEqual([null])
  })
  it('a card reads again only for its own worker', () => {
    expect(aboutWorker(['w_a'], 'w_a')).toBe(true)
    expect(aboutWorker(['w_b'], 'w_a')).toBe(false)
    expect(aboutWorker(null, 'w_a')).toBe(true)
    const view = src('renderer', 'views', 'Workers.tsx')
    expect(view.match(/if \(aboutWorker\(changed, worker\.id\)\) read\(\)/g)).toHaveLength(2)
    expect(src('main', 'workers', 'supervisor.ts')).not.toContain('this.onChange()')
    expect(src('preload', 'index.ts')).toContain('callback(payload?.workers ?? null)')
  })
})

describe('24-hour time field', () => {
  it('puts the colon in while typing', () => {
    expect(typeTime('0')).toBe('0')
    expect(typeTime('073')).toBe('07:3')
    expect(typeTime('0730')).toBe('07:30')
    expect(typeTime('7:5')).toBe('7:5')
    expect(typeTime('07:30 PM')).toBe('07:30')
    expect(typeTime('123456')).toBe('12:34')
  })
  it('finishes to HH:MM on the 24-hour clock or refuses', () => {
    expect(finishTime('7')).toBe('07:00')
    expect(finishTime('7:5')).toBe('07:05')
    expect(finishTime('2330')).toBe('23:30')
    expect(finishTime('00:00')).toBe('00:00')
    expect(finishTime('24:00')).toBe('')
    expect(finishTime('12:60')).toBe('')
    expect(finishTime('')).toBe('')
  })
  it('the routine dialog has no native time field left', () => {
    const view = src('renderer', 'views', 'Routines.tsx')
    expect(view).not.toMatch(/'time'|"time"|datetime-local/)
    expect(view).toContain('<TimeField')
  })
})

describe('memory history and the narrow to-do detail', () => {
  it('a failed history read is an error with Try again, not "No changes yet"', () => {
    const view = src('renderer', 'views', 'MemoryHistory.tsx')
    expect(view).toContain('setError(historyError(cause))')
    expect(view).toMatch(/error !== '' \? \([\s\S]*?Try again[\s\S]*?\) : loading && versions\.length === 0 \?[\s\S]*?No changes yet/)
  })
  it('on a narrow window the to-do detail opens over the list, at the width the layout collapses', () => {
    const view = src('renderer', 'views', 'Tasks.tsx')
    expect(view).toContain("TASKS_NARROW = '(max-width:1180px)'")
    expect(view).toContain('{narrow ? null : detail}')
    expect(view).toMatch(/narrow && sheet && detail !== null && dialog === null \? \(\s*<Dialog/)
    const css = src('renderer', 'styles', 'responsive.css')
    expect(css).toMatch(/@media \(max-width:1180px\)\{[\s\S]*?\.list-detail\{grid-template-columns:minmax\(0,1fr\)\}/)
  })
})
