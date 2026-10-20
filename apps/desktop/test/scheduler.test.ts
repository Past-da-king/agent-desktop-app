import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TriggerRow } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'

import { Store } from '../src/main/db'
import {
  LAST_RESULT_CHARS,
  Scheduler,
  WAITING_RESULT,
  isDue,
  startOfLocalDay,
  type RoutineRunner,
} from '../src/main/runtime/scheduler'
import type { RoutineRunResult } from '../src/main/runtime/runner'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})

afterEach(() => {
  store.close()
})

/** 20 Oct 2026, 10:00 local time. Local on purpose: daily times are local to the person. */
const NOW = new Date(2026, 9, 20, 10, 0, 0, 0).getTime()
const HOUR = 3_600_000
const DAY = 86_400_000

class FakeRunner implements RoutineRunner {
  calls: TriggerRow[] = []
  result: (trigger: TriggerRow) => Promise<RoutineRunResult> = async () => ({
    text: 'All quiet.',
    waiting: false,
  })

  async runRoutine(trigger: TriggerRow): Promise<RoutineRunResult> {
    this.calls.push(trigger)
    return this.result(trigger)
  }
}

function trigger(overrides: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: 'routine-' + Math.random().toString(16).slice(2),
    name: 'Morning brief',
    kind: 'daily',
    spec: '08:00',
    prompt: 'Tell me what matters today.',
    enabled: true,
    lastRunAt: null,
    lastResult: '',
    createdAt: NOW - DAY,
    ...overrides,
  }
}

async function save(row: TriggerRow): Promise<TriggerRow> {
  const { id, ...rest } = row
  return store.upsert('trigger', { id, ...rest })
}

function makeScheduler(runner: RoutineRunner, now = () => NOW, notices: string[] = []) {
  return {
    scheduler: new Scheduler({
      store,
      runner,
      now,
      notifyRoutine: (_id, name, result) => notices.push(`${name}: ${result}`),
    }),
    notices,
  }
}

describe('scheduler due logic', () => {
  it('knows when a one-off time has passed', () => {
    const past = trigger({ kind: 'at', spec: new Date(NOW - HOUR).toISOString() })
    expect(isDue(past, NOW)).toBe(true)
    expect(isDue({ ...past, lastRunAt: NOW - 60_000 }, NOW)).toBe(false)

    const future = trigger({ kind: 'at', spec: new Date(NOW + HOUR).toISOString() })
    expect(isDue(future, NOW)).toBe(false)
    expect(isDue(trigger({ kind: 'at', spec: 'not a date' }), NOW)).toBe(false)
  })

  it('knows when today\'s daily time has passed, once a day', () => {
    const after = trigger({ kind: 'daily', spec: '09:00' })
    const before = trigger({ kind: 'daily', spec: '11:00' })
    expect(isDue(after, NOW)).toBe(true)
    expect(isDue(before, NOW)).toBe(false)

    expect(isDue({ ...after, lastRunAt: NOW - HOUR }, NOW)).toBe(false)
    expect(isDue({ ...after, lastRunAt: NOW - DAY }, NOW)).toBe(true)
    expect(isDue(trigger({ kind: 'daily', spec: '25:00' }), NOW)).toBe(false)
  })

  it('counts interval minutes from the last run, or from creation', () => {
    const fresh = trigger({ kind: 'interval', spec: '30', createdAt: NOW - 10 * 60_000 })
    const old = trigger({ kind: 'interval', spec: '30', createdAt: NOW - 40 * 60_000 })
    expect(isDue(fresh, NOW)).toBe(false)
    expect(isDue(old, NOW)).toBe(true)

    expect(isDue({ ...old, lastRunAt: NOW - 5 * 60_000 }, NOW)).toBe(false)
    expect(isDue({ ...old, lastRunAt: NOW - 31 * 60_000 }, NOW)).toBe(true)
    expect(isDue(trigger({ kind: 'interval', spec: 'soon' }), NOW)).toBe(false)
  })
})

describe('Scheduler', () => {
  it('catches up a missed daily run once, then leaves it until tomorrow', async () => {
    await save(trigger({ id: 'daily-1', spec: '09:00', lastRunAt: NOW - 3 * DAY }))
    const runner = new FakeRunner()
    const { scheduler } = makeScheduler(runner)

    await scheduler.tick()
    await scheduler.tick()

    expect(runner.calls.map((row) => row.id)).toEqual(['daily-1'])
    const saved = await store.get('trigger', 'daily-1')
    expect(saved).toMatchObject({ lastRunAt: NOW, lastResult: 'All quiet.', enabled: true })
  })

  it('disables a one-off routine after it runs, and clips the result', async () => {
    await save(trigger({ id: 'once', kind: 'at', spec: new Date(NOW - HOUR).toISOString() }))
    const runner = new FakeRunner()
    runner.result = async () => ({ text: 'x'.repeat(400), waiting: false })
    const { scheduler } = makeScheduler(runner)

    await scheduler.tick()

    const saved = await store.get('trigger', 'once')
    expect(saved?.enabled).toBe(false)
    expect(saved?.lastRunAt).toBe(NOW)
    expect(saved?.lastResult).toHaveLength(LAST_RESULT_CHARS + 3)
    await scheduler.tick()
    expect(runner.calls).toHaveLength(1)
  })

  it('never runs two routines at once', async () => {
    await save(trigger({ id: 'slow', spec: '09:00' }))
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = new FakeRunner()
    runner.result = async () => {
      await held
      return { text: 'Done.', waiting: false }
    }
    const { scheduler } = makeScheduler(runner)

    const first = scheduler.tick()
    const second = scheduler.tick()
    expect(second).toBe(first)
    await waitFor(() => runner.calls.length === 1)
    expect(runner.calls).toHaveLength(1)
    release()
    await Promise.all([first, second])
    expect(runner.calls).toHaveLength(1)
  })

  it('runs a paused routine on demand through Run now', async () => {
    await save(trigger({ id: 'paused', spec: '23:59', enabled: false }))
    const runner = new FakeRunner()
    const { scheduler } = makeScheduler(runner)

    await scheduler.tick()
    expect(runner.calls).toHaveLength(0)

    await scheduler.runNow('paused')
    expect(runner.calls.map((row) => row.id)).toEqual(['paused'])
    expect(await store.get('trigger', 'paused')).toMatchObject({ enabled: false, lastRunAt: NOW })
  })

  it('says "Waiting for you" when a routine stops on a card', async () => {
    await save(trigger({ id: 'asking', spec: '09:00' }))
    const runner = new FakeRunner()
    runner.result = async () => ({ text: WAITING_RESULT, waiting: true })
    const { scheduler, notices } = makeScheduler(runner)

    await scheduler.tick()

    expect(await store.get('trigger', 'asking')).toMatchObject({
      lastResult: WAITING_RESULT,
      lastRunAt: NOW,
    })
    expect(notices).toEqual([])
  })

  it('tells the notifier about a finished routine result', async () => {
    await save(trigger({ id: 'reporting', spec: '09:00' }))
    const runner = new FakeRunner()
    runner.result = async () => ({ text: 'Two bills are due.', waiting: false })
    const { scheduler, notices } = makeScheduler(runner)

    await scheduler.tick()

    expect(notices).toEqual(['Morning brief: Two bills are due.'])
  })

  it('skips paused routines and routines that are not due', async () => {
    await save(trigger({ id: 'paused', spec: '09:00', enabled: false }))
    await save(trigger({ id: 'later', spec: '23:59', enabled: true }))
    const runner = new FakeRunner()
    const { scheduler } = makeScheduler(runner)

    await scheduler.tick()

    expect(runner.calls).toEqual([])
  })

  it('rejects Run now for a routine that is gone', async () => {
    const { scheduler } = makeScheduler(new FakeRunner())
    await expect(scheduler.runNow('missing')).rejects.toThrow('not there any more')
  })

  it('uses the local calendar day for daily routines', () => {
    const stamp = startOfLocalDay(NOW)
    const date = new Date(stamp)
    expect([date.getHours(), date.getMinutes(), date.getSeconds()]).toEqual([0, 0, 0])
  })
})
