import type { WorkerInfo } from '@agent/core'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dueSoon, dueTone, overdue } from '../src/renderer/lib/tasks'
import { createWorkersStore } from '../src/renderer/state/workersStore'

const view = (name: string): string => readFileSync(join(__dirname, '..', 'src', 'renderer', 'views', name), 'utf8')

function fakeSource(): { list: ReturnType<typeof vi.fn>; onChange: (cb: () => void) => () => void; fire: () => void; offs: number; subs: number } {
  const listeners = new Set<() => void>()
  const source = {
    list: vi.fn(async () => [{ id: 'w1', name: 'One' } as WorkerInfo]),
    offs: 0,
    subs: 0,
    onChange(cb: () => void) {
      source.subs += 1
      listeners.add(cb)
      return () => {
        source.offs += 1
        listeners.delete(cb)
      }
    },
    fire: () => listeners.forEach((cb) => cb()),
  }
  return source
}

describe('workers store: one list for the whole window', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads once and listens once however many screens show workers', async () => {
    const source = fakeSource()
    const store = createWorkersStore(source, 20_000)
    const seen = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
    const offs = seen.map((listener) => store.subscribe(listener))
    await vi.advanceTimersByTimeAsync(0)
    expect(source.list).toHaveBeenCalledTimes(1)
    expect(source.subs).toBe(1)
    expect(store.get().loaded).toBe(true)
    expect(store.get().workers.map((w) => w.id)).toEqual(['w1'])
    for (const listener of seen) expect(listener).toHaveBeenCalledTimes(1)

    source.fire()
    await vi.advanceTimersByTimeAsync(0)
    expect(source.list).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(20_000)
    expect(source.list).toHaveBeenCalledTimes(3)

    offs.forEach((off) => off())
    expect(source.offs).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    source.fire()
    expect(source.list).toHaveBeenCalledTimes(3)
  })

  it('says why when the list cannot be read, and keeps the last good list', async () => {
    const source = fakeSource()
    const store = createWorkersStore(source)
    const off = store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    source.list.mockRejectedValueOnce(new Error('The worker service is not running.'))
    store.reload()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().error).toBe('The worker service is not running.')
    expect(store.get().loaded).toBe(true)
    expect(store.get().workers).toHaveLength(1)
    store.reload()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().error).toBe('')
    off()
  })

  it('a slow old answer never overwrites a newer one', async () => {
    const source = fakeSource()
    let releaseOld: (list: WorkerInfo[]) => void = () => undefined
    source.list.mockImplementationOnce(() => new Promise<WorkerInfo[]>((resolve) => (releaseOld = resolve)))
    const store = createWorkersStore(source)
    const off = store.subscribe(() => undefined)
    source.list.mockImplementationOnce(async () => [{ id: 'new' } as WorkerInfo])
    source.fire()
    await vi.advanceTimersByTimeAsync(0)
    releaseOld([{ id: 'old' } as WorkerInfo])
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().workers.map((w) => w.id)).toEqual(['new'])
    off()
  })
})

describe('to-dos past their date', () => {
  const now = Date.UTC(2026, 10, 9, 19, 0)
  it('an open to-do past its date is late, not "soon"', () => {
    const late = { dueAt: now - 9 * 86_400_000, status: 'todo' as const }
    expect(overdue(late, now)).toBe(true)
    expect(dueTone(late, now)).toBe(' late')
  })
  it('due within a day is soon; later, done or undated is plain', () => {
    expect(dueTone({ dueAt: now + 3_600_000, status: 'todo' }, now)).toBe(' soon')
    expect(dueSoon({ dueAt: now + 3_600_000, status: 'todo' }, now)).toBe(true)
    expect(dueTone({ dueAt: now + 3 * 86_400_000, status: 'todo' }, now)).toBe('')
    expect(dueTone({ dueAt: now - 86_400_000, status: 'done' }, now)).toBe('')
    expect(dueTone({ dueAt: null, status: 'todo' }, now)).toBe('')
  })
})

describe('work pages: nothing fails silently', () => {
  it('no page uses a native confirm, alert or prompt', () => {
    for (const name of ['Home.tsx', 'Tasks.tsx', 'Memory.tsx', 'Routines.tsx', 'Workers.tsx', 'TaskDialog.tsx']) {
      expect(view(name), name).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\(/)
    }
  })
  it('every Undo after a delete reports a failure', () => {
    for (const name of ['Home.tsx', 'Tasks.tsx', 'Memory.tsx', 'Routines.tsx']) {
      const undo = /onAction: \(\) => \{\s*void agent\.data\.upsert\([^)]*\)(\.catch)?/g
      const found = [...view(name).matchAll(undo)]
      expect(found.length, name).toBeGreaterThan(0)
      for (const match of found) expect(match[1], name).toBe('.catch')
    }
  })
  it('Run now reports the real error, not a fixed excuse', () => {
    const source = view('Routines.tsx')
    expect(source).not.toContain('not switched on in this build')
    expect(source).toContain('Could not run ${trigger.name}')
  })
  it('worker events and log leave "Reading..." when the read fails', () => {
    const source = view('Workers.tsx')
    expect(source).toContain("'Could not read its events.'")
    expect(source).toContain("'Could not read its log.'")
  })
})
