import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { parseWhen, taskTools } from '../src/main/tools/tasks'
import { testContext, toolNamed } from './support'

let store: Store

beforeEach(() => {
  store = new Store(':memory:')
})

afterEach(() => {
  store.close()
})

describe('task tools', () => {
  it('adds a person to-do by default and an agent step when asked', async () => {
    const add = toolNamed(taskTools(store), 'task_add')
    await add.run({ title: 'Call the bank', owner: 'user' }, testContext())
    await add.run({ title: 'Compare the quotes', owner: 'agent' }, testContext())

    const tasks = await store.list('task')
    expect(tasks.map((task) => [task.title, task.owner, task.status])).toEqual([
      ['Call the bank', 'user', 'todo'],
      ['Compare the quotes', 'agent', 'todo'],
    ])
  })

  it('treats an unknown owner as the person', async () => {
    const add = toolNamed(taskTools(store), 'task_add')
    await add.run({ title: 'Buy milk', owner: 'somebody' }, testContext())
    const [task] = await store.list('task')
    expect(task?.owner).toBe('user')
  })

  it('keeps a due date it can understand and ignores one it cannot', async () => {
    const add = toolNamed(taskTools(store), 'task_add')
    await add.run({ title: 'Renew the licence', owner: 'user', dueAt: '2026-11-02' }, testContext())
    await add.run({ title: 'Someday', owner: 'user', dueAt: 'next blue moon' }, testContext())

    const tasks = await store.list('task')
    expect(tasks[0]?.dueAt).toBe(new Date('2026-11-02T09:00:00').getTime())
    expect(tasks[1]?.dueAt).toBeNull()
  })

  it('lists a goal with the steps under it', async () => {
    const goal = toolNamed(taskTools(store), 'goal_create')
    const add = toolNamed(taskTools(store), 'task_add')
    const list = toolNamed(taskTools(store), 'task_list')

    const created = await goal.run({ title: 'Plan the trip', why: 'A week away' }, testContext())
    const goalId = created.split('#')[1]?.split(' ')[0] ?? ''
    await add.run({ title: 'Book the cottage', owner: 'agent', goalId }, testContext())
    await add.run({ title: 'Pack', owner: 'user', goalId }, testContext())

    const text = await list.run({}, testContext())
    expect(text).toContain('Goal #')
    expect(text).toContain('Plan the trip')
    expect(text).toContain('Book the cottage')
    expect(text).toContain("Pack")
  })

  it('filters the list by status and leaves finished work out by default', async () => {
    const add = toolNamed(taskTools(store), 'task_add')
    const update = toolNamed(taskTools(store), 'task_update')
    const list = toolNamed(taskTools(store), 'task_list')

    const first = await add.run({ title: 'Done thing', owner: 'agent' }, testContext())
    const firstId = first.split('#')[1]?.split(' ')[0] ?? ''
    await update.run({ id: firstId, status: 'done' }, testContext())
    await add.run({ title: 'Open thing', owner: 'agent' }, testContext())

    expect(await list.run({}, testContext())).not.toContain('Done thing')
    expect(await list.run({ status: 'done' }, testContext())).toContain('Done thing')
    expect(await list.run({ status: 'done' }, testContext())).not.toContain('Open thing')
  })

  it('keeps a blocker while blocked and clears it when work starts again', async () => {
    const add = toolNamed(taskTools(store), 'task_add')
    const update = toolNamed(taskTools(store), 'task_update')
    const saved = await add.run({ title: 'Wait for the bank', owner: 'agent' }, testContext())
    const id = saved.split('#')[1]?.split(' ')[0] ?? ''

    expect(await update.run({ id, status: 'blocked', blocker: 'The bank must reply' }, testContext())).toContain(
      'blocked',
    )
    let [task] = await store.list('task')
    expect(task?.blocker).toBe('The bank must reply')

    await update.run({ id, status: 'doing' }, testContext())
    ;[task] = await store.list('task')
    expect(task?.blocker).toBe('')
  })

  it('finishes a goal once every step under it is done', async () => {
    const goal = toolNamed(taskTools(store), 'goal_create')
    const add = toolNamed(taskTools(store), 'task_add')
    const update = toolNamed(taskTools(store), 'task_update')

    const created = await goal.run({ title: 'Plan the trip' }, testContext())
    const goalId = created.split('#')[1]?.split(' ')[0] ?? ''
    const one = await add.run({ title: 'Book the cottage', owner: 'agent', goalId }, testContext())
    const two = await add.run({ title: 'Pack', owner: 'agent', goalId }, testContext())
    const ids = [one, two].map((answer) => answer.split('#')[1]?.split(' ')[0] ?? '')

    await update.run({ id: ids[0], status: 'done' }, testContext())
    expect((await store.list('goal'))[0]?.status).toBe('open')

    await update.run({ id: ids[1], status: 'done' }, testContext())
    expect((await store.list('goal'))[0]?.status).toBe('achieved')
  })

  it('explains a miss on update instead of throwing', async () => {
    const update = toolNamed(taskTools(store), 'task_update')
    expect(await update.run({ id: 'nope', status: 'done' }, testContext())).toBe('No task #nope.')
  })

  it('parses the date shapes the model is told to send', () => {
    expect(parseWhen('2026-11-02T14:00')).toBe(new Date('2026-11-02T14:00:00').getTime())
    expect(parseWhen('2026-11-02')).toBe(new Date('2026-11-02T09:00:00').getTime())
    expect(parseWhen('')).toBeNull()
    expect(parseWhen('not a date')).toBeNull()
  })
})
