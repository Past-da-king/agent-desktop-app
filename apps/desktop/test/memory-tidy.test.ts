/**
 * Tidying a memory bank with the agent: the export is read project by project, the model's pages are filed so the
 * same subject merges, a failing step is recorded and skipped, a stopped run carries on where it stopped, and the
 * whole import can be undone. The model is a fake that answers from the notes it is shown.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { parseExport } from '../src/main/memory/importer'
import { foldExtras, MemoryTidy, parseTidy, planTidy, TidyFile, TIDY_SYSTEM, type TidyEntry } from '../src/main/memory/tidy'
import { UpkeepFile } from '../src/main/memory/upkeep-log'

let store: Store
let clock = 1_790_000_000_000
const DAY = 86_400_000

beforeEach(() => {
  clock = 1_790_000_000_000
  store = new Store(':memory:', () => (clock += 10))
})

afterEach(() => {
  store.close()
})

/** An export shaped like the A.O.S Memory Bank one: two projects, general notes, retired and old state notes. */
function fixture(): string {
  const memories: Array<Record<string, unknown>> = []
  const add = (id: string, project: string, kind: string, title: string, text: string, daysAgo: number, status = 'active'): void => {
    memories.push({ id, project, kind, title, text, topics: [project || 'misc'], life: 'work', date: new Date(clock - daysAgo * DAY).toISOString(), status })
  }
  add('m1', 'creek', 'decision', 'Creek sites move to Astro', 'Decided to move the three Creek sites off Wix onto Astro because Wix was slow.', 40)
  add('m2', 'creek', 'person', 'Neesha Nadar', 'Neesha Nadar runs bookings for Creek Retreats. Sometimes written Nisha Nadar.', 30)
  for (let i = 0; i < 15; i += 1) add(`s${i}`, 'creek', 'state', `Creek state ${i}`, `State of the Creek sites on day ${i}: ${'x'.repeat(200)}`, 20 - i)
  add('m3', 'creek', 'how-to', 'Deploy a Creek site', '1. npm run build\n2. wrangler pages deploy dist', 10)
  add('m4', 'londacorp-erp', 'project', 'LondaCorp ERP', 'An ERP for Londa Corp. Speech-to-text writes it Londercorp.', 5)
  add('m5', '', 'fact', 'Ayanda lives in Durban', 'Ayanda lives in Durban, South Africa.', 50)
  add('r1', 'creek', 'decision', 'Creek stays on Wix', 'Old decision, replaced.', 60, 'retired')
  return JSON.stringify({ format: 'agent-memory-export', version: 1, source: 'A.O.S Memory Bank', memories })
}

/** A fake model: a project page for the project in the prompt, plus one page per note title it sees. */
function fakeModel(options: { failOn?: string; garbleOnce?: string } = {}): { complete: (system: string, prompt: string) => Promise<string>; prompts: string[] } {
  const prompts: string[] = []
  const garbled = new Set<string>()
  return {
    prompts,
    complete: async (system, prompt) => {
      expect(system).toBe(TIDY_SYSTEM)
      prompts.push(prompt)
      const project = /PROJECT: (\S+)/.exec(prompt)?.[1] ?? ''
      if (options.failOn !== undefined && project === options.failOn) throw new Error('The model is overloaded.')
      if (options.garbleOnce !== undefined && project === options.garbleOnce && !garbled.has(project)) {
        garbled.add(project)
        return 'Sure! Here is a summary of the notes, in words.'
      }
      const update = /already exists as id (\S+):/.exec(prompt)?.[1] ?? ''
      const memories: Array<Record<string, unknown>> = []
      if (project !== '') {
        memories.push({ kind: 'project', title: project === 'creek' ? 'Creek Retreats sites' : 'LondaCorp ERP', body: `Goal: ship ${project}.\nWhere it stands: notes read ${prompts.length}.`, topics: project, update })
      }
      if (prompt.includes('Neesha Nadar')) memories.push({ kind: 'person', title: 'Neesha Nadar', body: 'Runs bookings for Creek Retreats.', topics: 'creek', aliases: ['Nisha Nadar'] })
      if (prompt.includes('Creek sites move to Astro')) memories.push({ kind: 'decision', title: 'Creek sites move to Astro', body: 'Decided 2026-09-01: move to Astro.\nWhy: Wix was slow.', topics: 'creek' })
      if (prompt.includes('Creek stays on Wix')) memories.push({ kind: 'decision', title: 'Creek stays on Wix', body: 'This retired note should never be shown.', topics: 'creek' })
      if (prompt.includes('Ayanda lives in Durban')) memories.push({ kind: 'fact', title: 'Ayanda lives in Durban', body: 'Ayanda lives in Durban, South Africa.', topics: 'personal' })
      return JSON.stringify({ memories })
    },
  }
}

function tidy(complete: (system: string, prompt: string) => Promise<string>, file = new TidyFile(null), upkeep = new UpkeepFile(null), stepChars?: number): { runner: MemoryTidy; upkeep: UpkeepFile; file: TidyFile } {
  return { runner: new MemoryTidy({ store, complete, upkeep, file, now: () => clock, ...(stepChars === undefined ? {} : { stepChars }) }), upkeep, file }
}

describe('planning', () => {
  it('leaves out retired notes and older state, keeps the newest state, biggest project first, general last', () => {
    const { plan, steps, projects } = planTidy(parseExport(fixture()), { stepChars: 600, recentState: 3 })
    expect(plan.retired).toBe(1)
    expect(plan.olderState).toBe(12)
    expect(projects).toEqual(['creek', 'londacorp-erp', ''])
    expect(steps.flatMap((step) => step.notes.map((note) => note.id))).not.toContain('r1')
    const creekStates = steps.flatMap((step) => step.notes).filter((note) => note.kind === 'state').map((note) => note.id)
    expect(creekStates.sort()).toEqual(['s12', 's13', 's14'])
    // Small steps: creek takes several, each under the budget unless one note alone is bigger.
    expect(steps.filter((step) => step.project === 'creek').length).toBeGreaterThan(1)
    expect(steps.every((step) => step.chars <= 600 || step.notes.length === 1)).toBe(true)
    // The same notes always give the same step ids, so a finished step is recognised next time.
    expect(planTidy(parseExport(fixture()), { stepChars: 600, recentState: 3 }).key).toBe(planTidy(parseExport(fixture()), { stepChars: 600, recentState: 3 }).key)
  })
})

describe('the reply', () => {
  it('reads aliases and status, and keeps them out of the page text (they go on the page itself)', () => {
    const [entry] = parseTidy('{"memories": [{"kind": "organisation", "title": "LondaCorp", "body": "Construction client.", "aliases": ["Londercorp", "London Corp"], "status": "closed"}]}')
    expect(entry).toMatchObject({ kind: 'organisation', aliases: 'Londercorp, London Corp', status: 'closed' })
    expect(foldExtras(entry as TidyEntry).body).toBe('Construction client.')
    expect(() => parseTidy('No JSON here.')).toThrow('did not reply with pages')
  })
})

describe('tidying', () => {
  it('writes one page per project, merges the same subject, never shows retired notes, and logs every page', async () => {
    const model = fakeModel({ garbleOnce: 'londacorp-erp' })
    const { runner, upkeep, file } = tidy(model.complete)
    runner.start(parseExport(fixture()), false)
    await runner.idle()

    const rows = await store.list('memory')
    const titles = rows.map((row) => row.title).sort()
    expect(titles).toEqual(['Ayanda lives in Durban', 'Creek Retreats sites', 'Creek sites move to Astro', 'LondaCorp ERP', 'Neesha Nadar'])
    expect(rows.find((row) => row.title === 'Neesha Nadar')?.aliases).toContain('Nisha Nadar')
    expect(model.prompts.join('\n')).not.toContain('Creek stays on Wix')
    // The second creek step updated the page the first one wrote instead of adding another.
    const creekPrompts = model.prompts.filter((prompt) => prompt.includes('PROJECT: creek'))
    expect(creekPrompts.length).toBeGreaterThan(0)
    // A garbled reply was asked for again and the step still succeeded.
    const progress = runner.progress()
    expect(progress).toMatchObject({ running: false, finished: true, failed: 0, canUndo: true })
    expect(progress.added).toBe(5)
    expect(upkeep.read().log.filter((change) => change.reason.startsWith('From the memory bank import')).length).toBeGreaterThanOrEqual(5)
    expect(Object.keys(file.read()?.projectPages ?? {})).toEqual(expect.arrayContaining(['creek', 'londacorp-erp']))
  })

  it('updates the project page across steps of the same project', async () => {
    const model = fakeModel()
    // A small budget splits creek into several steps.
    const { runner } = tidy(model.complete, new TidyFile(null), new UpkeepFile(null), 1_200)
    const parsed = parseExport(fixture())
    expect(planTidy(parsed, { stepChars: 1_200 }).steps.filter((step) => step.project === 'creek').length).toBeGreaterThan(1)
    runner.start(parsed, false)
    await runner.idle()
    const pages = (await store.list('memory')).filter((row) => row.kind === 'project')
    expect(pages.map((row) => row.title).sort()).toEqual(['Creek Retreats sites', 'LondaCorp ERP'])
    // Every creek step after the first was told to update the page the first one wrote.
    const creek = model.prompts.filter((prompt) => prompt.includes('PROJECT: creek'))
    expect(creek.slice(1).every((prompt) => prompt.includes(`already exists as id ${pages.find((row) => row.title === 'Creek Retreats sites')?.id}`))).toBe(true)
  })

  it('records a failing step, carries on with the rest, and retries only that step when started again', async () => {
    const failing = fakeModel({ failOn: 'creek' })
    const file = new TidyFile(null)
    const upkeep = new UpkeepFile(null)
    const first = tidy(failing.complete, file, upkeep)
    first.runner.start(parseExport(fixture()), false)
    await first.runner.idle()
    const after = first.runner.progress()
    expect(after.failed).toBeGreaterThan(0)
    expect(after.errors[0]).toEqual({ project: 'creek', error: 'The model is overloaded.' })
    expect((await store.list('memory')).map((row) => row.title)).toContain('LondaCorp ERP')

    const working = fakeModel()
    const second = tidy(working.complete, file, upkeep)
    second.runner.start(parseExport(fixture()), false)
    await second.runner.idle()
    // Only the failed creek steps ran again; londacorp and the general notes were already done.
    expect(working.prompts.every((prompt) => prompt.includes('PROJECT: creek'))).toBe(true)
    expect(second.runner.progress()).toMatchObject({ failed: 0, finished: true })
    expect((await store.list('memory')).map((row) => row.title)).toContain('Neesha Nadar')
  })

  it('stops after the step in progress and carries on from there', async () => {
    const model = fakeModel()
    let calls = 0
    let runner: MemoryTidy | null = null
    const file = new TidyFile(null)
    const stopping = tidy(async (system, prompt) => {
      calls += 1
      if (calls === 1) runner?.stop()
      return model.complete(system, prompt)
    }, file)
    runner = stopping.runner
    runner.start(parseExport(fixture()), false)
    await runner.idle()
    const stopped = runner.progress()
    expect(stopped).toMatchObject({ running: false, finished: false, done: 1 })
    expect(stopped.message).toContain('Stopped')

    const resumed = fakeModel()
    const again = tidy(resumed.complete, file)
    again.runner.start(parseExport(fixture()), false)
    await again.runner.idle()
    expect(again.runner.progress()).toMatchObject({ finished: true, done: again.runner.progress().steps })
    // The finished first step was not asked for again.
    expect(resumed.prompts.length).toBe(again.runner.progress().steps - 1)
  })

  it('undoes the whole import: added pages go, changed pages come back as they were', async () => {
    const mine = await store.upsert('memory', { title: 'Neesha Nadar', body: 'Neesha is my contact at Creek.', kind: 'person', topics: 'creek', pinned: true, source: 'user' })
    const model = fakeModel()
    const { runner } = tidy(model.complete)
    runner.start(parseExport(fixture()), false)
    await runner.idle()
    expect((await store.get('memory', mine.id))?.body).toContain('Runs bookings')

    const undone = await runner.undo()
    expect(undone.restored).toBe(1)
    expect(undone.removed).toBe(4)
    const rows = await store.list('memory')
    expect(rows.map((row) => row.title)).toEqual(['Neesha Nadar'])
    expect(rows[0]).toMatchObject({ body: 'Neesha is my contact at Creek.', pinned: true })
    expect(runner.progress().canUndo).toBe(false)
  })
})
