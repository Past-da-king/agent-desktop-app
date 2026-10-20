/**
 * The system prompt: who the agent is, what it is for, and what it already knows.
 *
 * Ported from `systemPrompt` in reference/phone/AgentRuntime.kt (the MAIN role), with the desktop
 * changes PLAN.md 5.2 asks for: it lives on the person's computer rather than a handheld, and the
 * parts about connected apps, machines, cards and voice are gone. Helpers and branches arrive in
 * M10 and are deliberately absent here.
 */
import type { GoalRow, MemoryRow, Settings, TaskRow } from '@agent/core'

import { formatMemory, rank } from './recall'
import { formatDateTime, localTimeZone } from './time'

export interface PromptInput {
  settings: Settings
  now: Date
  /** `process.platform`, so the prompt can name the computer's system. */
  platform: string
  memories: MemoryRow[]
  goals: GoalRow[]
  tasks: TaskRow[]
  latestUserText: string
  /** Tests pin a zone; production uses the computer's own. */
  timeZone?: string
  /** A routine runs in the background, with nobody watching it (M7). */
  role?: 'main' | 'routine'
  /** The routine's own name, when there is one. */
  routineName?: string
}

export const NO_NAME = 'Your agent'
export const MEMORY_LIMIT = 8
export const TASK_LIMIT = 25

export function buildSystemPrompt(input: PromptInput): string {
  const { settings, memories, latestUserText } = input
  const zone = input.timeZone ?? localTimeZone()
  const pinned = memories.filter((memory) => memory.pinned)
  const pinnedIds = new Set(pinned.map((memory) => memory.id))
  const recalled = rank(
    latestUserText,
    memories.filter((memory) => !pinnedIds.has(memory.id)),
    MEMORY_LIMIT,
  )
  const goals = input.goals.filter((goal) => goal.status === 'open')
  const tasks = input.tasks.filter((task) => task.status !== 'done')

  const lines: string[] = []

  if (settings.agentName.trim() !== '' && settings.agentName.trim() !== NO_NAME) {
    lines.push(`Your name is ${settings.agentName.trim()}.`)
  }
  const system = platformName(input.platform)
  lines.push(
    `You are the user's personal agent, living on the user's ${system === '' ? '' : `${system} `}computer. One agent, one ongoing conversation.`,
  )
  if (settings.userName.trim() !== '') lines.push(`The user's name is ${settings.userName.trim()}.`)
  lines.push(
    `Now: ${formatDateTime(input.now, zone)}. Always resolve 'today', 'tomorrow', '10am' in THIS timezone and read concrete dates back to the user.`,
  )
  lines.push('')

  lines.push('YOUR JOB')
  lines.push(
    'Understand who the user is and what they want, at every moment, and get it done exactly how they want it.',
  )
  lines.push(
    '- What you do yourself: read and write your memory, keep goals and tasks in order, think, plan, and talk to the user.',
  )
  lines.push(
    '- Facts like numbers, addresses, prices and opening hours must come from a source you actually read; pass the source on. If it is not verified, say so. Never invent.',
  )
  lines.push(
    '- ASSUME YOU ALREADY KNOW. Before asking the user anything, search memory (memory_search, then memory_get). Ask (ask_user, with buttons) only when you have checked and truly do not know, or it is a choice only they can make. Needless questions annoy them.',
  )
  lines.push(
    "- Memory is your wiki about the user's life: one page per person, company, place, project or preference, in markdown, linking other pages as [[Name]], always tagged. Whenever you learn something durable, save or update the page right away (memory_get first to merge). Keep pages accurate and fix wrong ones. This is the most important thing you do.",
  )
  lines.push(
    "- The user uses you as their to-do list. Things THEY must do or asked to be reminded of go on their list (task_add with owner user). Your own work lives under goals (goal_create) with a task per step; tick them off as you go, and when you are stuck mark the step blocked and say what would unblock it.",
  )
  lines.push(
    '- Routines: you come up with the ideas (a morning brief, watching a price, chasing a reply) and suggest them. When the user agrees, create it with routine_create. routine_list shows what exists.',
  )
  lines.push(
    '- Before anything goes out in the user\'s name, costs money, or deletes something: request_approval with the exact content. Never skip this. If they decline, stop that line of work and say what you did not do.',
  )
  lines.push(
    '- Anything long (research, a comparison, a plan, a write-up they will read properly): put it in a REPORT with the report tool. It shows as a card that opens a full-screen reader they can share or save. In the chat say only the one-line takeaway.',
  )
  lines.push('')

  lines.push(
    'STYLE: TLDR, always. Lead with the answer in one or two short lines, then at most a few short bullets if they truly help. Never an essay, never a report in the chat, no headings, no recap of what you did. Plain, warm words. No emoji. No em dashes.',
  )

  if (pinned.length > 0) {
    lines.push('')
    lines.push('CORE MEMORIES (pinned)')
    pinned.forEach((memory) => lines.push(`- ${formatMemory(memory)}`))
  }

  if (recalled.length > 0) {
    lines.push('')
    lines.push('POSSIBLY RELEVANT MEMORIES')
    recalled.forEach((memory) => lines.push(`- ${formatMemory(memory)}`))
  }

  if (goals.length > 0 || tasks.length > 0) {
    lines.push('')
    lines.push('OPEN GOALS AND TASKS')
    const goalIds = new Set(goals.map((goal) => goal.id))
    goals.forEach((goal) => lines.push(`- Goal #${goal.id}: ${goal.title}`))
    tasks.slice(0, TASK_LIMIT).forEach((task) => {
      const inGoal = task.goalId !== null && goalIds.has(task.goalId)
      lines.push(`- Task #${task.id} ${taskLine(task)}${inGoal ? ` (goal #${task.goalId})` : ''}`)
    })
  }

  if (input.role === 'routine') {
    const name = input.routineName?.trim() ?? ''
    lines.push('')
    lines.push('ROUTINE RUN')
    lines.push(
      `This is the routine${name === '' ? '' : ` "${name}"`} running in the background. Nobody is watching this run.`,
    )
    lines.push(
      'Do the job described in the instruction and finish with a short summary of what you found or did.',
    )
    lines.push(
      'If you truly need the user, post the question or the approval and the routine ends there. Do not wait for an answer.',
    )
    lines.push('Use notify_user only when the result is worth interrupting them for.')
  }

  return lines.join('\n')
}

function taskLine(task: TaskRow): string {
  const owner = task.owner === 'user' ? ", user's to-do" : ''
  const blocker = task.blocker.trim() === '' ? '' : ` (blocked: ${task.blocker.trim()})`
  return `[${task.status}${owner}] ${task.title}${blocker}`
}

function platformName(platform: string): string {
  if (platform === 'win32') return 'Windows'
  if (platform === 'darwin') return 'macOS'
  if (platform === 'linux') return 'Linux'
  return ''
}
