/** "Show me the lender select" said to the agent puts that project's page on screen (22 Oct 2026). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { toolNamed, testContext } from './support'
import { Store } from '../src/main/db'
import { findProject, projectTools } from '../src/main/tools/projects'

let store: Store
let opened: string[]

beforeEach(async () => {
  store = new Store(':memory:')
  opened = []
  const icon = { glyph: 'folder', color: 'iris' as const }
  for (const [name, extra] of [
    ['Guavas Lender Selector', {}],
    ['Strat Edge Website', {}],
    ['The Creek Collection', {}],
    ['Creek Retreats', {}],
    ['RMBLR', { aliases: ['Rumbler'] }],
  ] as const) {
    await store.upsert('project', { name, description: '', icon, path: '', profile: '', hidden: false, chats: [], ...extra })
  }
  // A row from an older build: no aliases field at all.
  await store.upsert('project', { name: 'StudyCanvas', description: 'Voice tutor', icon, path: 'C:\\projects\\study-canvas', profile: '', hidden: true, chats: [] })
})

afterEach(() => store.close())

function tools(withOpen = true): ReturnType<typeof projectTools> {
  return projectTools({
    store,
    post: async () => undefined,
    state: () => ({ running: false, waiting: [] }),
    agentName: () => 'Nova',
    ...(withOpen ? { open: (id: string) => opened.push(id) } : {}),
  })
}

async function nameOf(id: string | undefined): Promise<string | undefined> {
  return (await store.list('project')).find((p) => p.id === id)?.name
}

describe('project_open', () => {
  it('opens the one clear winner and says which', async () => {
    const out = await toolNamed(tools(), 'project_open').run({ project: 'show me the lender select' }, testContext())
    expect(out).toContain('Opened Guavas Lender Selector')
    expect(await nameOf(opened[0])).toBe('Guavas Lender Selector')
  })

  it('opens Strat Edge Website for "strategic website", RMBLR for "open rumbler", and a hidden old row', async () => {
    const open = toolNamed(tools(), 'project_open')
    await open.run({ project: 'strategic website' }, testContext())
    await open.run({ project: 'open rumbler' }, testContext())
    const out = await open.run({ project: 'study canvas' }, testContext())
    expect(out).toContain('hidden')
    expect(await Promise.all(opened.map(nameOf))).toEqual(['Strat Edge Website', 'RMBLR', 'StudyCanvas'])
  })

  it('two close ones: opens neither and names both to ask about', async () => {
    const out = await toolNamed(tools(), 'project_open').run({ project: 'creek' }, testContext())
    expect(opened).toEqual([])
    expect(out).toContain('The Creek Collection')
    expect(out).toContain('Creek Retreats')
    expect(out).toContain('ask_user')
  })

  it('none: says so and lists what there is', async () => {
    const out = await toolNamed(tools(), 'project_open').run({ project: 'banana smoothie' }, testContext())
    expect(opened).toEqual([])
    expect(out).toContain('No project matches')
    expect(out).toContain('Guavas Lender Selector')
  })

  it('opens by id, and only exists when the window can be told', async () => {
    const [first] = await store.list('project')
    await toolNamed(tools(), 'project_open').run({ project: first!.id }, testContext())
    expect(opened).toEqual([first!.id])
    expect(tools(false).some((tool) => tool.spec.name === 'project_open')).toBe(false)
  })

  it('project_update keeps other names, and the other tools find a project the way it is said', async () => {
    const out = await toolNamed(tools(), 'project_update').run({ project: 'lender select', aliases: 'the lender tool, Ruan app' }, testContext())
    expect(out).toContain('Guavas Lender Selector')
    const projects = await store.list('project')
    expect(findProject(projects, 'ruan app')?.name).toBe('Guavas Lender Selector')
    // Never a guess between two close ones.
    expect(findProject(projects, 'creak')).toBeNull()
  })
})
