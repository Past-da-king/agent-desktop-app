/**
 * Review findings R2, R3 and F1 (14 Nov 2026): the scheduler's completion write, the due check inside the queue, and
 * the daily time on days the clock changes. Real SQLite store (in memory), a controlled clock, TZ forced per test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TriggerRow } from '@agent/core'

import { Store } from '../src/main/db'
import { ifStillThere, updateLive } from '../src/main/runtime/data'
import { recordDailyRun, ensureDailyRoutine } from '../src/main/memory/routine'
import { advanceMeetingJob } from '../src/main/presence/meeting-jobs'
import { Scheduler, isDue, type RoutineRunner } from '../src/main/runtime/scheduler'
import type { RoutineRunResult } from '../src/main/runtime/runner'

let store: Store
const originalTz = process.env.TZ

beforeEach(() => {
  store = new Store(':memory:')
})

afterEach(() => {
  store.close()
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
})

const MIN = 60_000
const NOW = Date.UTC(2026, 9, 20, 8, 0, 0)

/** A runner that waits until the test lets it finish, so the test can act while the run is awaiting. */
class GatedRunner implements RoutineRunner {
  calls: string[] = []
  private release: (() => void) | null = null
  private started: (() => void) | null = null
  entered = new Promise<void>((resolve) => {
    this.started = resolve
  })
  async runRoutine(trigger: TriggerRow): Promise<RoutineRunResult> {
    this.calls.push(trigger.id)
    this.started?.()
    await new Promise<void>((resolve) => {
      this.release = resolve
    })
    return { text: 'Done.', waiting: false }
  }
  finish(): void {
    this.release?.()
  }
}

async function recurring(overrides: Partial<TriggerRow> = {}): Promise<TriggerRow> {
  return store.upsert('trigger', { name: 'Brief', kind: 'interval', spec: '15', prompt: 'Do it', enabled: true, lastRunAt: NOW - 60 * MIN, lastResult: '', createdAt: NOW - 600 * MIN, ...overrides })
}

describe('R2: the completion write only records the run', () => {
  it('a pause made while the run awaits is not overwritten', async () => {
    const runner = new GatedRunner()
    const row = await recurring()
    const scheduler = new Scheduler({ store, runner, now: () => NOW })
    const tick = scheduler.tick()
    await runner.entered
    await store.upsert('trigger', { id: row.id, enabled: false })
    runner.finish()
    await tick
    const after = await store.get('trigger', row.id)
    expect(after?.enabled).toBe(false)
    expect(after?.lastResult).toBe('Done.')
  })

  it('an edit made while the run awaits is kept, with the run recorded beside it', async () => {
    const runner = new GatedRunner()
    const row = await recurring()
    const scheduler = new Scheduler({ store, runner, now: () => NOW })
    const tick = scheduler.tick()
    await runner.entered
    await store.upsert('trigger', { id: row.id, name: 'Renamed', spec: '45', prompt: 'New prompt' })
    runner.finish()
    await tick
    const after = await store.get('trigger', row.id)
    expect(after).toMatchObject({ name: 'Renamed', spec: '45', prompt: 'New prompt', enabled: true, lastResult: 'Done.' })
  })

  it('a routine deleted while the run awaits stays deleted: the tombstone is not cleared', async () => {
    const runner = new GatedRunner()
    const row = await recurring()
    const scheduler = new Scheduler({ store, runner, now: () => NOW })
    const tick = scheduler.tick()
    await runner.entered
    await store.remove('trigger', row.id)
    runner.finish()
    await tick
    expect(await store.get('trigger', row.id)).toBeNull()
    expect((await store.list('trigger')).map((each) => each.id)).not.toContain(row.id)
    expect(store.deletedIds('trigger').has(row.id)).toBe(true)
  })

  it('a one-off is switched off by its own run, but not when it was moved to a later time meanwhile', async () => {
    const runner = new GatedRunner()
    const at = new Date(NOW - 5 * MIN).toISOString()
    const row = await store.upsert('trigger', { name: 'Once', kind: 'at', spec: at, prompt: 'Once', enabled: true, lastRunAt: null, lastResult: '', createdAt: NOW - 600 * MIN })
    const scheduler = new Scheduler({ store, runner, now: () => NOW })
    const tick = scheduler.tick()
    await runner.entered
    runner.finish()
    await tick
    expect((await store.get('trigger', row.id))?.enabled).toBe(false)

    const runner2 = new GatedRunner()
    const moved = await store.upsert('trigger', { name: 'Moved', kind: 'at', spec: at, prompt: 'Once', enabled: true, lastRunAt: null, lastResult: '', createdAt: NOW - 600 * MIN })
    const scheduler2 = new Scheduler({ store, runner: runner2, now: () => NOW })
    const tick2 = scheduler2.tick()
    await runner2.entered
    const later = new Date(NOW + 3 * 60 * MIN).toISOString()
    await store.upsert('trigger', { id: moved.id, spec: later })
    runner2.finish()
    await tick2
    expect(await store.get('trigger', moved.id)).toMatchObject({ spec: later, enabled: true })
  })
})

describe('R2: the store never clears a tombstone by itself', () => {
  it('an upsert of a deleted row is refused; an explicit restore brings back a clean row', async () => {
    const row = await recurring({ name: 'Old name', prompt: 'Old prompt' })
    await store.remove('trigger', row.id)
    await expect(store.upsert('trigger', { id: row.id, lastResult: 'late' })).rejects.toThrow()
    expect(await store.get('trigger', row.id)).toBeNull()
    expect(store.deletedIds('trigger').has(row.id)).toBe(true)
    const back = await store.upsert('trigger', { id: row.id, name: 'Back', kind: 'interval', spec: '30', prompt: 'New', enabled: true, lastRunAt: null, lastResult: '' }, { restore: true })
    expect(back).toMatchObject({ name: 'Back', prompt: 'New' })
    expect(store.deletedIds('trigger').has(row.id)).toBe(false)
  })

  it('updateLive writes from the current row and drops a write to a row deleted meanwhile', async () => {
    const row = await recurring()
    await store.upsert('trigger', { id: row.id, enabled: false })
    const seen: boolean[] = []
    await updateLive(store, 'trigger', row.id, (current) => {
      seen.push(current.enabled)
      return { lastResult: 'x' }
    })
    expect(seen).toEqual([false])
    expect(await store.get('trigger', row.id)).toMatchObject({ enabled: false, lastResult: 'x' })
    await store.remove('trigger', row.id)
    expect(await updateLive(store, 'trigger', row.id, () => ({ lastResult: 'y' }))).toBeNull()
    expect(await store.get('trigger', row.id)).toBeNull()
  })
})

describe('R2: the same rule for the other writers that finish after a wait', () => {
  it('ifStillThere drops a write to a row deleted since it was read, and rethrows anything else', async () => {
    const row = await recurring()
    await store.remove('trigger', row.id)
    expect(await ifStillThere(store.upsert('trigger', { id: row.id, lastResult: 'late' }))).toBeNull()
    expect(await store.get('trigger', row.id)).toBeNull()
    await expect(ifStillThere(Promise.reject(new Error('other')))).rejects.toThrow('other')
  })

  it('the End of day report after its routine was deleted does not bring the routine back', async () => {
    await ensureDailyRoutine(store, { dailyAt: '23:30' })
    await store.remove('trigger', 'memory-daily')
    await recordDailyRun(store, { at: NOW, trigger: 'schedule', ok: true, message: 'Done.', day: '2026-10-20', chats: 0, filed: 0, merged: 0, rewritten: 0, dropped: 0, changes: [] })
    expect(await store.get('trigger', 'memory-daily')).toBeNull()
    expect(store.deletedIds('trigger').has('memory-daily')).toBe(true)
  })

  it('a routine that was run or deleted before its meeting follow-up is moved is not moved or brought back', async () => {
    const at = new Date(NOW + 3 * 60 * MIN).toISOString()
    const job = await store.upsert('trigger', { name: 'Follow up: Standup', kind: 'at', spec: at, prompt: 'p', enabled: true, lastRunAt: null, lastResult: '', createdAt: NOW - MIN, eventId: 'ev1' })
    await store.remove('trigger', job.id)
    const moved = await advanceMeetingJob(store, { eventId: 'ev1', title: 'Standup', endedAt: NOW } as never, NOW, 'ended early')
    expect(moved.moved).toBe(false)
    expect(await store.get('trigger', job.id)).toBeNull()
  })
})

describe('R3: a slot is checked again inside the queue', () => {
  it('a recurring routine that finished a manual run after the tick looked does not run again when its queued job reaches the front', async () => {
    const blocker = await store.upsert('trigger', { name: 'Blocker', kind: 'interval', spec: '15', prompt: 'Block', enabled: false, lastRunAt: null, lastResult: '', createdAt: NOW - 600 * MIN })
    const due = await recurring({ name: 'Due one' })
    const runner = new GatedRunner()
    const scheduler = new Scheduler({ store, runner, now: () => NOW })
    // Something already occupies the queue (a manual run of another routine).
    const manual = scheduler.runNow(blocker.id)
    await runner.entered
    // The tick decides the due routine is due and queues it behind the manual run.
    const tick = scheduler.tick()
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Meanwhile the due routine finished a run by hand elsewhere (its lastRunAt is now).
    await store.upsert('trigger', { id: due.id, lastRunAt: NOW, lastResult: 'ran by hand' })
    runner.finish()
    await manual
    await tick
    expect(runner.calls).toEqual([blocker.id])
  })

  it('Run now still runs a routine that is not due, and a paused one', async () => {
    const row = await recurring({ lastRunAt: NOW, enabled: false })
    const runner = new GatedRunner()
    const scheduler = new Scheduler({ store, runner, now: () => NOW })
    const manual = scheduler.runNow(row.id)
    await runner.entered
    runner.finish()
    await manual
    expect(runner.calls).toEqual([row.id])
  })
})

function daily(spec: string, overrides: Partial<TriggerRow> = {}): TriggerRow {
  return { id: 'd1', name: 'Daily', kind: 'daily', spec, prompt: 'p', enabled: true, lastRunAt: null, lastResult: '', createdAt: 0, ...overrides } as TriggerRow
}

describe('F1: a daily routine runs at its wall-clock time on the days the clock changes', () => {
  it('New York, spring forward (8 Mar 2026): 09:00 is 09:00 EDT, not 10:00', () => {
    process.env.TZ = 'America/New_York'
    const nineEdt = Date.UTC(2026, 2, 8, 13, 0, 0)
    expect(isDue(daily('09:00'), nineEdt - MIN)).toBe(false)
    expect(isDue(daily('09:00'), nineEdt + 5 * MIN)).toBe(true)
  })

  it('New York, fall back (1 Nov 2026): 09:00 is 09:00 EST, not 08:00', () => {
    process.env.TZ = 'America/New_York'
    const nineEst = Date.UTC(2026, 10, 1, 14, 0, 0)
    expect(isDue(daily('09:00'), nineEst - 55 * MIN)).toBe(false)
    expect(isDue(daily('09:00'), nineEst + 5 * MIN)).toBe(true)
  })

  it('a time inside the spring gap runs at the first valid minute after it', () => {
    process.env.TZ = 'America/New_York'
    const threeEdt = Date.UTC(2026, 2, 8, 7, 0, 0)
    expect(isDue(daily('02:30'), threeEdt - MIN)).toBe(false)
    expect(isDue(daily('02:30'), threeEdt + MIN)).toBe(true)
  })

  it('a time that happens twice in the fall runs once, at the first occurrence', () => {
    process.env.TZ = 'America/New_York'
    const firstOneThirty = Date.UTC(2026, 10, 1, 5, 30, 0)
    expect(isDue(daily('01:30'), firstOneThirty - MIN)).toBe(false)
    expect(isDue(daily('01:30'), firstOneThirty + MIN)).toBe(true)
    // It ran at the first one; the same wall-clock time an hour later (EST) is the same day: not again.
    expect(isDue(daily('01:30', { lastRunAt: firstOneThirty + MIN }), firstOneThirty + 61 * MIN)).toBe(false)
  })

  it('catch-up across the change: late by more than 15 minutes runs only when the routine says catch up', () => {
    process.env.TZ = 'America/New_York'
    const nineEdt = Date.UTC(2026, 2, 8, 13, 0, 0)
    expect(isDue(daily('09:00'), nineEdt + 10 * MIN)).toBe(true)
    expect(isDue(daily('09:00'), nineEdt + 20 * MIN)).toBe(false)
    expect(isDue(daily('09:00', { catchUp: true }), nineEdt + 20 * MIN)).toBe(true)
    // The app slept through the fall change and woke at 09:20 EST; the previous run was the day before.
    const nineEst = Date.UTC(2026, 10, 1, 14, 0, 0)
    const yesterday = Date.UTC(2026, 9, 31, 13, 0, 0)
    expect(isDue(daily('09:00', { lastRunAt: yesterday }), nineEst + 20 * MIN)).toBe(false)
    expect(isDue(daily('09:00', { lastRunAt: yesterday, catchUp: true }), nineEst + 20 * MIN)).toBe(true)
    // Not before its time, even with catch up.
    expect(isDue(daily('09:00', { lastRunAt: yesterday, catchUp: true }), nineEst - 30 * MIN)).toBe(false)
  })

  it('Johannesburg has no change: 09:00 SAST is 07:00 UTC all year', () => {
    process.env.TZ = 'Africa/Johannesburg'
    for (const [month, day] of [[2, 8], [10, 1], [5, 20]] as const) {
      const nine = Date.UTC(2026, month, day, 7, 0, 0)
      expect(isDue(daily('09:00'), nine - MIN)).toBe(false)
      expect(isDue(daily('09:00'), nine + 5 * MIN)).toBe(true)
    }
  })

  it('the scheduler takes the zone it is given, not only the computer zone', () => {
    process.env.TZ = 'Africa/Johannesburg'
    const nineEdt = Date.UTC(2026, 2, 8, 13, 0, 0)
    expect(isDue(daily('09:00'), nineEdt + 5 * MIN, 'America/New_York')).toBe(true)
    expect(isDue(daily('09:00'), nineEdt - MIN, 'America/New_York')).toBe(false)
  })
})
