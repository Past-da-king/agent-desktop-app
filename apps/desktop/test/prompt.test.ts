import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type GoalRow, type MemoryRow, type Settings, type TaskRow } from '@agent/core'

import { buildSystemPrompt, MEMORY_LIMIT } from '../src/main/runtime/prompt'

const NOW = new Date('2026-10-20T14:58:00Z')

function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, grantedFolders: [], ...patch }
}

function memory(partial: Partial<MemoryRow> & { title: string }): MemoryRow {
  return {
    id: partial.id ?? partial.title.toLowerCase(),
    body: '',
    kind: 'fact',
    topics: '',
    pinned: false,
    source: 'agent',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  }
}

function task(partial: Partial<TaskRow> & { title: string }): TaskRow {
  return {
    id: partial.id ?? partial.title,
    goalId: null,
    notes: '',
    status: 'todo',
    dueAt: null,
    owner: 'user',
    blocker: '',
    updatedAt: 0,
    createdAt: 0,
    ...partial,
  }
}

function goal(partial: Partial<GoalRow> & { title: string }): GoalRow {
  return { id: partial.id ?? partial.title, why: '', status: 'open', createdAt: 0, ...partial }
}

function prompt(patch: Partial<Parameters<typeof buildSystemPrompt>[0]> = {}): string {
  return buildSystemPrompt({
    settings: settings({ agentName: 'Scout', userName: 'Sam' }),
    now: NOW,
    platform: 'win32',
    memories: [],
    goals: [],
    tasks: [],
    latestUserText: 'Where does Lerato live?',
    timeZone: 'Africa/Johannesburg',
    ...patch,
  })
}

describe('buildSystemPrompt', () => {
  it('names the agent and the person', () => {
    const text = prompt()
    expect(text).toContain('Your name is Scout.')
    expect(text).toContain("The user's name is Sam.")
  })

  it('leaves out the name line when the agent has no name yet', () => {
    const text = prompt({ settings: settings({ agentName: 'Your agent', userName: '' }) })
    expect(text).not.toContain('Your name is')
    expect(text).not.toContain("The user's name is")
  })

  it('gives the date with the computer timezone', () => {
    expect(prompt()).toContain('Now: Tuesday 20 October 2026, 16:58 (Africa/Johannesburg).')
  })

  it('names the operating system from the platform', () => {
    expect(prompt({ platform: 'win32' })).toContain("the user's Windows computer")
    expect(prompt({ platform: 'darwin' })).toContain("the user's macOS computer")
    expect(prompt({ platform: 'linux' })).toContain("the user's Linux computer")
  })

  it('includes pinned memories', () => {
    const text = prompt({
      memories: [memory({ title: 'Home', body: '42 Sea View Road.', pinned: true })],
    })
    expect(text).toContain('CORE MEMORIES (pinned')
    expect(text).toContain('42 Sea View Road.')
  })

  it('includes memories that match what the person just said', () => {
    const text = prompt({
      memories: [
        memory({ title: 'Lerato', body: 'Lives in Durban and works at the bakery.' }),
        memory({ title: 'Bakery', body: 'The one on the corner.', topics: 'food' }),
      ],
    })
    expect(text).toContain('BACKGROUND MEMORIES')
    expect(text).toContain('Lives in Durban')
  })

  it('does not repeat a pinned memory in the relevant list', () => {
    const text = prompt({
      memories: [memory({ title: 'Lerato', body: 'Lives in Durban.', pinned: true })],
    })
    expect(text.match(/#lerato/g)).toHaveLength(1)
  })

  it('lists open goals and tasks, but not finished ones', () => {
    const text = prompt({
      goals: [goal({ id: 'g1', title: 'Plan the trip' }), goal({ id: 'g2', title: 'Old goal', status: 'achieved' })],
      tasks: [
        task({ id: 't1', title: 'Book the cottage', goalId: 'g1' }),
        task({ id: 't2', title: 'Send deposit', status: 'done' }),
        task({ id: 't3', title: 'Wait for the bank', status: 'blocked', blocker: 'The bank must reply' }),
      ],
    })
    expect(text).toContain('OPEN GOALS AND TASKS')
    expect(text).toContain('Goal #g1: Plan the trip')
    expect(text).toContain('Book the cottage')
    expect(text).toContain('(goal #g1)')
    expect(text).toContain('Wait for the bank')
    expect(text).toContain('blocked: The bank must reply')
    expect(text).not.toContain('Old goal')
    expect(text).not.toContain('Send deposit')
  })

  it('never mentions a phone or Android', () => {
    const text = prompt()
    expect(text).not.toMatch(/phone/i)
    expect(text).not.toMatch(/android/i)
  })

  it('carries no emoji and no em dashes', () => {
    const text = prompt({
      memories: [
        memory({ title: 'Lerato', body: 'Lives in Durban.', pinned: true }),
        memory({ title: 'Trip', body: 'Durban in December.' }),
      ],
      tasks: [task({ title: 'Book the cottage' })],
      goals: [goal({ title: 'Plan the trip' })],
    })
    expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
    expect(text).not.toContain('\u2014')
  })

  it('caps the recalled list', () => {
    const memories = Array.from({ length: MEMORY_LIMIT + 5 }, (_, index) =>
      memory({ id: `m${index}`, title: `Lerato ${index}`, body: 'Durban' }),
    )
    const text = prompt({ memories })
    expect(text.match(/Lerato/g)?.length).toBe(MEMORY_LIMIT)
  })
})
