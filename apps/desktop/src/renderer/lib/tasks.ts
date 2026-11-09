import type { TaskRow } from '@agent/core'

/** Open work first, then soonest due date, then the oldest item. */
export function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => {
    const aDone = a.status === 'done' ? 1 : 0
    const bDone = b.status === 'done' ? 1 : 0
    if (aDone !== bDone) return aDone - bDone
    if (a.dueAt === null && b.dueAt === null) return a.createdAt - b.createdAt
    if (a.dueAt === null) return 1
    if (b.dueAt === null) return -1
    if (a.dueAt !== b.dueAt) return a.dueAt - b.dueAt
    return a.createdAt - b.createdAt
  })
}

export function userTasks(tasks: TaskRow[]): TaskRow[] {
  return sortTasks(tasks.filter((task) => task.owner === 'user'))
}

export function openUserTasks(tasks: TaskRow[]): TaskRow[] {
  return userTasks(tasks).filter((task) => task.status !== 'done')
}

/** Still open and past its date. Shown in the error colour with the word, so it is not read as "due soon". */
export function overdue(task: Pick<TaskRow, 'dueAt' | 'status'>, now = Date.now()): boolean {
  return task.status !== 'done' && task.dueAt !== null && task.dueAt < now
}

/** The class of a due line: late, soon or nothing. */
export function dueTone(task: Pick<TaskRow, 'dueAt' | 'status'>, now = Date.now()): '' | ' soon' | ' late' {
  return overdue(task, now) ? ' late' : dueSoon(task, now) ? ' soon' : ''
}

/** A due date within the next day is shown in amber. */
export function dueSoon(task: Pick<TaskRow, 'dueAt' | 'status'>, now = Date.now()): boolean {
  return task.status !== 'done' && task.dueAt !== null && task.dueAt - now < 86_400_000
}
