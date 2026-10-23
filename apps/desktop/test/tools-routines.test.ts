import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { routineTools, specProblem } from '../src/main/tools/routines'
import { buildToolset } from '../src/main/runtime/toolset'
import { testContext, toolNamed } from './support'

let store: Store
const NOW = new Date(2026, 9, 20, 10, 0, 0, 0)
const NOW_MS = NOW.getTime()

beforeEach(() => {
  store = new Store(':memory:')
})

afterEach(() => {
  store.close()
})

function tools() {
  return routineTools(store, () => NOW)
}

describe('routine tools', () => {
  it('creates a routine with no approval card and says when it runs', async () => {
    const approvals: string[] = []
    const create = toolNamed(tools(), 'routine_create')

    const result = await create.run(
      {
        name: 'Morning brief',
        kind: 'daily',
        spec: '07:30',
        prompt: 'Read my calendar and tell me the shape of the day.',
      },
      testContext({
        approve: async (summary, details) => {
          approvals.push(`${summary} | ${details ?? ''}`)
          return true
        },
      }),
    )

    expect(approvals).toEqual([])
    expect(result).toContain('created')
    expect(result).toContain('every day at 07:30')

    const rows = await store.list('trigger')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'Morning brief',
      kind: 'daily',
      spec: '07:30',
      prompt: 'Read my calendar and tell me the shape of the day.',
      enabled: true,
      lastRunAt: null,
      lastResult: '',
    })
  })

  it('creates it even where nobody could approve (a routine run in the background)', async () => {
    const create = toolNamed(tools(), 'routine_create')

    const result = await create.run(
      { name: 'Price watch', kind: 'interval', spec: '120', prompt: 'Check the price.' },
      testContext({ approve: async () => false }),
    )

    expect(result).toContain('created: runs every 120 minutes')
    expect(await store.list('trigger')).toHaveLength(1)
  })

  it('refuses a spec that does not fit its kind', async () => {
    const create = toolNamed(tools(), 'routine_create')
    const ctx = testContext({ approve: async () => true })

    const past = new Date(NOW_MS - 3_600_000).toISOString()
    expect(
      await create.run({ name: 'Late', kind: 'at', spec: past, prompt: 'Too late.' }, ctx),
    ).toContain('in the past')
    expect(
      await create.run({ name: 'Bad clock', kind: 'daily', spec: '7.30', prompt: 'Nope.' }, ctx),
    ).toContain('HH:mm')
    expect(
      await create.run({ name: 'Too often', kind: 'interval', spec: '5', prompt: 'Nope.' }, ctx),
    ).toContain('at least 15')
    expect(
      await create.run({ name: 'Odd kind', kind: 'weekly', spec: 'SUN 18:00', prompt: 'Nope.' }, ctx),
    ).toContain('kind must be')
    expect(await store.list('trigger')).toEqual([])
  })

  it('accepts a future one-off time', () => {
    const future = new Date(NOW_MS + 3_600_000).toISOString()
    expect(specProblem('at', future, NOW_MS)).toBeNull()
    expect(specProblem('daily', '00:00', NOW_MS)).toBeNull()
    expect(specProblem('interval', '15', NOW_MS)).toBeNull()
  })

  it('lists routines with their schedule, paused state and last result', async () => {
    await store.upsert('trigger', {
      name: 'Morning brief',
      kind: 'daily',
      spec: '07:30',
      prompt: 'Read my calendar and tell me the shape of the day.',
      enabled: false,
      lastRunAt: NOW_MS,
      lastResult: 'Two meetings.',
    })
    const list = toolNamed(tools(), 'routine_list')

    const text = await list.run({}, testContext())

    expect(text).toContain('Morning brief')
    expect(text).toContain('[daily 07:30]')
    expect(text).toContain('(paused)')
    expect(text).toContain('Two meetings.')
    expect(await toolNamed(tools(), 'routine_list').run({}, testContext())).not.toBe('No routines.')
  })

  it('deletes a routine and says so when it is already gone', async () => {
    const row = await store.upsert('trigger', {
      name: 'Old routine',
      kind: 'interval',
      spec: '60',
      prompt: 'Check.',
    })
    const remove = toolNamed(tools(), 'routine_delete')

    expect(await remove.run({ id: row.id }, testContext())).toBe('Deleted.')
    expect(await store.list('trigger')).toEqual([])
    expect(await remove.run({ id: row.id }, testContext())).toBe(`No routine #${row.id}.`)
  })

  it('is part of the one toolset the Runner is given', () => {
    const names = buildToolset({ store }).map((tool) => tool.spec.name)
    expect(names).toEqual(expect.arrayContaining(['routine_create', 'routine_list', 'routine_delete']))
  })
})
