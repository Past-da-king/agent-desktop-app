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

/** A due date within the next day is shown in amber. */
export function dueSoon(task: Pick<TaskRow, 'dueAt' | 'status'>, now = Date.now()): boolean {
  return task.status !== 'done' && task.dueAt !== null && task.dueAt - now < 86_400_000
}
