/**
 * Task and goal tools, ported from reference/phone/tools/TaskTools.kt.
 *
 * Two kinds of task: the person's own to-do list (`owner: 'user'`) and the agent's working steps
 * (`owner: 'agent'`). A task that points at a goal (`goalId`) is one of that goal's steps, and the
 * goal is achieved when every step under it is done.
 */
import {
  enumOf,
  schema,
  str,
  type GoalRow,
  type TaskRow,
  type Tool,
} from '@agent/core'

import type { DataStore } from '../runtime/data'

const STATUSES: Array<TaskRow['status']> = ['todo', 'doing', 'done', 'blocked']

export function taskTools(store: DataStore): Tool[] {
  return [taskAdd(store), taskList(store), taskUpdate(store), goalCreate(store)]
}

function goalCreate(store: DataStore): Tool {
  return {
    spec: {
      name: 'goal_create',
      description:
        "Start a goal for something bigger the user wants (e.g. 'Plan the Durban trip'). The user sees goals and tasks in the Tasks view.",
      schema: schema(['title'], {
        title: str("The goal, in the user's words"),
        why: str('Why it matters, or the outcome they want'),
      }),
    },
    run: async (input) => {
      const title = text(input['title']).trim()
      if (title === '') return 'A goal needs a title.'
      const goal = await store.upsert('goal', {
        title,
        why: text(input['why']).trim(),
        status: 'open',
      })
      return `Goal #${goal.id} created: ${goal.title}`
    },
  }
}

function taskAdd(store: DataStore): Tool {
  return {
    spec: {
      name: 'task_add',
      description:
        "Add a task. owner 'user' puts it on the user's own to-do list (things THEY must do, or reminders they asked for); owner 'agent' is a step you will do yourself. Optional goal and due date.",
      schema: schema(
        ['title', 'owner'],
        {
          title: str('The task'),
          owner: enumOf('Whose task it is', 'user', 'agent'),
          goalId: str('Id of the goal it belongs to, when it is a step under one'),
          dueAt: str('Due, ISO like 2026-10-06T14:00 or 2026-10-06'),
          notes: str('Details'),
        },
      ),
    },
    run: async (input) => {
      const title = text(input['title']).trim()
      if (title === '') return 'A task needs a title.'
      const owner = input['owner'] === 'agent' ? 'agent' : 'user'
      const task = await store.upsert('task', {
        title,
        owner,
        notes: text(input['notes']).trim(),
        goalId: text(input['goalId']).trim() || null,
        dueAt: parseWhen(input['dueAt']),
        status: 'todo',
        blocker: '',
      })
      const prefix = owner === 'agent' ? 'Planned' : 'Added to your to-dos'
      return `Task #${task.id} added (${prefix}: ${task.title})`
    },
  }
}

function taskList(store: DataStore): Tool {
  return {
    spec: {
      name: 'task_list',
      description:
        'List goals and tasks. With no status it shows everything still open; pass a status to see just those.',
      schema: schema([], {
        status: enumOf('Only this status', ...STATUSES),
      }),
    },
    run: async (input) => {
      const status = statusOf(input['status'])
      const goals = (await store.list('goal')).filter((goal) => goal.status === 'open')
      const all = await store.list('task')
      const tasks = all.filter((task) => (status === null ? task.status !== 'done' : task.status === status))
      if (goals.length === 0 && tasks.length === 0) return 'No open goals or tasks.'

      const goalIds = new Set(goals.map((goal) => goal.id))
      const lines: string[] = []
      for (const goal of goals) {
        const steps = tasks.filter((task) => task.goalId === goal.id)
        if (steps.length === 0 && status !== null) continue
        lines.push(`Goal #${goal.id}: ${goal.title}`)
        steps.forEach((task) => lines.push(`  ${taskLine(task)}`))
      }
      tasks
        .filter((task) => task.goalId === null || !goalIds.has(task.goalId))
        .forEach((task) => lines.push(taskLine(task)))
      return lines.length === 0 ? 'Nothing matches that status.' : lines.join('\n')
    },
  }
}

function taskUpdate(store: DataStore): Tool {
  return {
    spec: {
      name: 'task_update',
      description:
        "Change a task's status (todo, doing, done, blocked), title, notes or blocker. Mark your steps doing and done as you go. When blocked, say exactly what would unblock it in blocker.",
      schema: schema(
        ['id'],
        {
          id: str('Task id'),
          status: enumOf('New status', ...STATUSES),
          title: str('New title'),
          notes: str('New notes'),
          blocker: str('What is needed to unblock it, and from whom'),
        },
      ),
    },
    run: async (input) => {
      const id = text(input['id']).trim()
      const task = (await store.list('task')).find((row) => row.id === id)
      if (task === undefined) return `No task #${id}.`

      const status = statusOf(input['status']) ?? task.status
      const notes = text(input['notes']).trim()
      const blocker = text(input['blocker']).trim()
      const updated = await store.upsert('task', {
        id: task.id,
        title: text(input['title']).trim() || task.title,
        status,
        notes: notes === '' ? task.notes : notes,
        blocker:
          status === 'blocked' ? blocker || task.blocker : input['status'] === undefined ? task.blocker : '',
      })

      if (task.goalId !== null) await achieveGoalWhenDone(store, task.goalId)
      return `Task #${updated.id} is ${updated.status}`
    },
  }
}

async function achieveGoalWhenDone(store: DataStore, goalId: string): Promise<void> {
  const steps = (await store.list('task')).filter((task) => task.goalId === goalId)
  if (steps.length === 0 || !steps.every((task) => task.status === 'done')) return
  const goal: GoalRow | undefined = (await store.list('goal')).find((row) => row.id === goalId)
  if (goal === undefined || goal.status !== 'open') return
  await store.upsert('goal', { id: goal.id, status: 'achieved' })
}

function taskLine(task: TaskRow): string {
  const owner = task.owner === 'user' ? ", user's" : ''
  const blocker = task.blocker.trim() === '' ? '' : ` (blocked: ${task.blocker.trim()})`
  const due = task.dueAt === null ? '' : ` (due ${new Date(task.dueAt).toISOString().slice(0, 10)})`
  return `#${task.id} [${task.status}${owner}] ${task.title}${due}${blocker}`
}

function statusOf(value: unknown): TaskRow['status'] | null {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
    ? (value as TaskRow['status'])
    : null
}

/** "2026-10-06T14:00" or "2026-10-06" in local time. Ported from parseWhen in TaskTools.kt. */
export function parseWhen(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const raw = text(value).trim()
  if (raw === '') return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const dateOnly = new Date(`${raw}T09:00:00`)
    return Number.isNaN(dateOnly.getTime()) ? null : dateOnly.getTime()
  }
  const withTime = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T'))
  if (!Number.isNaN(withTime.getTime())) return withTime.getTime()
  const dateOnly = new Date(`${raw}T09:00:00`)
  return Number.isNaN(dateOnly.getTime()) ? null : dateOnly.getTime()
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
