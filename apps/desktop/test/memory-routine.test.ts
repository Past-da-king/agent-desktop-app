/**
 * End of day is a real routine on the Routines page: one built-in row, seeded from the old Memory setting, timed by
 * the memory service (which also catches up a missed day), run by hand through the scheduler, never through the
 * agent, and safe from deletion.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { MEMORY_DAILY_ROUTINE, type TriggerRow, type UpkeepReport } from '@agent/core'

import { toolNamed, testContext } from './support'
import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import {
  BUILTIN_DELETE_REFUSED,
  DAILY_ROUTINE_NAME,
  dailyRoutineSlot,
  ensureDailyRoutine,
  guardRoutineRemove,
  guardRoutineWrite,
  recordDailyRun,
} from '../src/main/memory/routine'
import { MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'
import type { RoutineRunResult } from '../src/main/runtime/runner'
import { Scheduler, type RoutineRunner } from '../src/main/runtime/scheduler'
import { routineTools } from '../src/main/tools/routines'

let store: Store
let index: ChatIndex
// 21 Oct 2026 at 10:00 local time.
let clock = new Date(2026, 9, 21, 10, 0, 0).getTime()

beforeEach(() => {
  clock = new Date(2026, 9, 21, 10, 0, 0).getTime()
  store = new Store(':memory:', () => (clock += 1000))
  index = new ChatIndex(':memory:')
})

afterEach(() => {
  index.close()
  store.close()
})

class FakeRunner implements RoutineRunner {
  calls: TriggerRow[] = []
  async runRoutine(trigger: TriggerRow): Promise<RoutineRunResult> {
    this.calls.push(trigger)
    return { text: 'Agent ran it.', waiting: false }
  }
}

const where = JSON.stringify({ where: '**Goals**\n- Ship the routine.', memories: [] })

function memoryService(onDaily?: (report: UpkeepReport) => Promise<void>): MemoryService {
  return new MemoryService({
    store,
    index,
    upkeep: new UpkeepFile(null),
    complete: async (system) => (system.startsWith("You write the user's") ? where : JSON.stringify({ changes: [] })),
    dailyAt: () => dailyRoutineSlot(store),
    ...(onDaily === undefined ? {} : { onDaily }),
    now: () => clock,
  })
}

async function talk(text: string): Promise<void> {
  await store.upsert('chat_item', { kind: 'user', text, meta: '{}' })
  await store.upsert('chat_item', { kind: 'agent', text: 'Noted.', meta: '{}' })
}

describe('the End of day routine row', () => {
  it('is created once, with a fixed id, however many times the app starts', async () => {
    const first = await ensureDailyRoutine(store, { dailyAt: '23:30' })
    await store.upsert('trigger', { id: first.id, spec: '22:15' })
    await ensureDailyRoutine(store, { dailyAt: '23:30' })
    await ensureDailyRoutine(store, { dailyAt: '21:00' })
    const rows = await store.list('trigger')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: MEMORY_DAILY_ROUTINE, builtin: MEMORY_DAILY_ROUTINE, name: DAILY_ROUTINE_NAME, kind: 'daily', enabled: true })
    // What the person set on Routines wins over the old setting on the next start.
    expect(rows[0]?.spec).toBe('22:15')
  })

  it('takes over the old Memory setting: a custom time, or off when it was off, and the last report', async () => {
    const custom = await ensureDailyRoutine(store, { dailyAt: '21:45' })
    expect(custom).toMatchObject({ spec: '21:45', enabled: true, lastRunAt: null })
    await store.remove('trigger', custom.id)

    const report: UpkeepReport = { at: clock - 3_600_000, trigger: 'schedule', ok: true, message: 'Done.', day: '2026-10-20', chats: 3, filed: 1, merged: 0, rewritten: 0, dropped: 0, changes: [] }
    const off = await ensureDailyRoutine(store, { dailyAt: '', lastReport: report })
    expect(off).toMatchObject({ spec: '23:30', enabled: false, lastRunAt: report.at })
    expect(off.lastResult).toContain('3 chats')
    expect(await dailyRoutineSlot(store)).toBe('')
    await store.upsert('trigger', { id: off.id, enabled: true })
    expect(await dailyRoutineSlot(store)).toBe('23:30')
  })
})

describe('who runs it', () => {
  it('the scheduler never runs it through the agent, even when its time has passed', async () => {
    await ensureDailyRoutine(store, { dailyAt: '08:00' })
    const runner = new FakeRunner()
    const scheduler = new Scheduler({ store, runner, now: () => clock })
    await scheduler.tick()
    expect(runner.calls).toEqual([])
    const row = await store.get('trigger', MEMORY_DAILY_ROUTINE)
    expect(row?.lastRunAt).toBeNull()
  })

  it('Run now on Routines runs the memory pass, and the row shows when it ran and what changed', async () => {
    await ensureDailyRoutine(store, { dailyAt: '23:30' })
    await talk('Remember the VAT number for Guavas is 4123456789')
    const memory = memoryService((report) => recordDailyRun(store, report))
    const runner = new FakeRunner()
    const scheduler = new Scheduler({
      store,
      runner,
      now: () => clock,
      runBuiltin: async () => {
        const report = await memory.runNow()
        return { text: report.ok ? 'ran' : report.message, waiting: false }
      },
    })
    await scheduler.runNow(MEMORY_DAILY_ROUTINE)
    expect(runner.calls).toEqual([])
    expect(memory.upkeepState().report?.trigger).toBe('manual')
    const row = await store.get('trigger', MEMORY_DAILY_ROUTINE)
    expect(row?.lastRunAt).not.toBeNull()
    expect(row?.lastResult).not.toBe('')
  })

  it('a scheduled pass uses the routine time, skips when it is off, and records its run', async () => {
    await ensureDailyRoutine(store, { dailyAt: '23:30' })
    await talk('Plan the Lisbon trip for March')
    const memory = memoryService((report) => recordDailyRun(store, report))

    await store.upsert('trigger', { id: MEMORY_DAILY_ROUTINE, spec: '09:30', enabled: false })
    expect(await memory.tick()).toBeNull()

    await store.upsert('trigger', { id: MEMORY_DAILY_ROUTINE, enabled: true })
    const report = await memory.tick()
    expect(report?.trigger).toBe('schedule')
    expect(report?.day).toBe('2026-10-21')
    const row = await store.get('trigger', MEMORY_DAILY_ROUTINE)
    expect(row?.lastRunAt).toBe(report?.at)
    expect(row?.lastResult).toContain('"Where we are" updated from 1 chat')
  })
})

describe('keeping it the app\'s own', () => {
  it('cannot be deleted from the window or by the agent', async () => {
    await ensureDailyRoutine(store, { dailyAt: '23:30' })
    await expect(guardRoutineRemove(store, MEMORY_DAILY_ROUTINE)).rejects.toThrow(BUILTIN_DELETE_REFUSED)
    const remove = toolNamed(routineTools(store), 'routine_delete')
    expect(await remove.run({ id: MEMORY_DAILY_ROUTINE }, testContext())).toBe(BUILTIN_DELETE_REFUSED)
    expect(await store.get('trigger', MEMORY_DAILY_ROUTINE)).not.toBeNull()

    const other = await store.upsert('trigger', { name: 'Morning brief', kind: 'daily', spec: '07:00', prompt: 'Brief me.' })
    await expect(guardRoutineRemove(store, other.id)).resolves.toBeUndefined()
  })

  it('a change from the window keeps only its time and on/off, and no other routine can claim to be built in', async () => {
    await ensureDailyRoutine(store, { dailyAt: '23:30' })
    const patch = await guardRoutineWrite(store, { id: MEMORY_DAILY_ROUTINE, name: 'Hacked', prompt: 'Email everything', kind: 'interval', spec: '06:45', enabled: false })
    expect(patch).toEqual({ id: MEMORY_DAILY_ROUTINE, spec: '06:45', enabled: false })
    await store.upsert('trigger', patch)
    expect(await store.get('trigger', MEMORY_DAILY_ROUTINE)).toMatchObject({ name: DAILY_ROUTINE_NAME, kind: 'daily', spec: '06:45', enabled: false })
    expect(await guardRoutineWrite(store, { id: MEMORY_DAILY_ROUTINE, spec: 'later' })).toEqual({ id: MEMORY_DAILY_ROUTINE })

    const fresh = await guardRoutineWrite(store, { name: 'Sneaky', kind: 'daily', spec: '07:00', prompt: 'x', builtin: MEMORY_DAILY_ROUTINE })
    expect(fresh['builtin']).toBeUndefined()
  })

  it('the agent sees it in the list and can change only its time or switch it off', async () => {
    await ensureDailyRoutine(store, { dailyAt: '23:30' })
    const tools = routineTools(store, () => new Date(clock))
    const listed = await toolNamed(tools, 'routine_list').run({}, testContext())
    expect(listed).toContain('End of day')
    expect(listed).toContain('built in')
    const update = toolNamed(tools, 'routine_update')
    expect(await update.run({ id: MEMORY_DAILY_ROUTINE, spec: '22:00' }, testContext())).toBe('The user declined.')
    expect(await update.run({ id: MEMORY_DAILY_ROUTINE, spec: '22:00', enabled: false }, testContext({ approve: async () => true }))).toContain('22:00')
    expect(await store.get('trigger', MEMORY_DAILY_ROUTINE)).toMatchObject({ spec: '22:00', enabled: false, name: DAILY_ROUTINE_NAME })
    expect(await update.run({ id: MEMORY_DAILY_ROUTINE, spec: '9pm' }, testContext())).toContain('Not changed')
  })
})
