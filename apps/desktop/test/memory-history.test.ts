/**
 * Memory keeps every version of a page (who, when, why, what changed) whoever writes it, pages can be closed off
 * and stay searchable, and the other names a page answers to (a dictation's mis-hearing) find it and are spelled
 * right in the next dictation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { encodeStamp, type MemoryRow } from '@agent/core'

import { testContext, toolNamed } from './support'
import { cleanupRequest } from '../src/main/dictation/cleanup'
import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { asWriter } from '../src/main/memory/history'
import { restoreVersion } from '../src/main/memory/history-ipc'
import { MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'
import { applyAliases, vocabularyBrief, vocabularyFrom } from '../src/main/memory/vocabulary'
import { buildSystemPrompt } from '../src/main/runtime/prompt'
import { namedPages, rank, recallFor } from '../src/main/runtime/recall'
import { memoryTools } from '../src/main/tools/memory'
import { DEFAULT_SETTINGS } from '@agent/core'

let store: Store
let clock = 1_790_000_000_000

beforeEach(() => {
  clock = 1_790_000_000_000
  store = new Store(':memory:', () => (clock += 1000))
})

afterEach(() => store.close())

const tools = (): ReturnType<typeof memoryTools> => memoryTools(store)

describe('every change to a memory page is kept', () => {
  it('numbers versions and says who made each and why: the agent, a helper, the person, filing, sync', async () => {
    const saved = await toolNamed(tools(), 'memory_save').run(
      { title: 'Fly TAP direct to Lisbon', body: 'Looking at a one-stop via Madrid.', kind: 'decision', topics: 'travel', reason: 'first look' },
      testContext({ agentLabel: 'main' }),
    )
    expect(saved).toMatch(/^Saved page #(\S+) 'Fly TAP direct to Lisbon', now version 1: created\.$/)
    const id = /#(\S+) /.exec(saved)?.[1] ?? ''

    const update = toolNamed(tools(), 'memory_update')
    const byHelper = await update.run({ id, body: 'TAP direct chosen: no red-eyes.', reason: 'Sam chose TAP' }, testContext({ agentLabel: 'Airline comparison' }))
    expect(byHelper).toBe(`Updated #${id} 'Fly TAP direct to Lisbon', now version 2: body.`)
    // The gate: a write that changes nothing says so, and keeps no version.
    expect(await update.run({ id, body: 'TAP direct chosen: no red-eyes.' }, testContext({ agentLabel: 'main' }))).toBe(
      `Nothing changed on #${id} 'Fly TAP direct to Lisbon' (still version 2).`,
    )

    await asWriter('chat filing', 'Lisbon trip', () => store.upsert('memory', { id, topics: 'travel, lisbon' }))
    await store.applyRemote([
      {
        entity: 'memory',
        id,
        deleted: false,
        stamp: encodeStamp({ millis: clock + 60_000, counter: 0, device: 'other-device' }),
        payload: { ...(await store.get('memory', id)), title: 'Fly TAP direct to Lisbon (booked)' },
      },
    ])

    const history = store.memoryHistory(id)
    expect(history.map((v) => [v.n, v.by, v.reason, v.changed])).toEqual([
      [4, 'another device', '', ['title']],
      [3, 'chat filing', 'Lisbon trip', ['topics']],
      [2, 'helper Airline comparison', 'Sam chose TAP', ['body']],
      [1, 'agent', 'first look', ['created']],
    ])
    expect(history[3]?.body).toBe('Looking at a one-stop via Madrid.')

    const told = await toolNamed(tools(), 'memory_history').run({ id }, testContext())
    expect(told.split('\n')[0]).toMatch(/^v4 .* by another device: title$/)
    expect(told).toContain('by helper Airline comparison (Sam chose TAP): body')
    expect(told).toContain('Looking at a one-stop via Madrid.')
  })

  it('keeps a page written before versions existed as version 1 the first time it changes', async () => {
    const page = await store.upsert('memory', { title: 'Acme', body: 'A fintech.', kind: 'organisation' })
    // Simulate an older database: no versions yet for this page.
    ;(store as unknown as { db: { exec(sql: string): void } }).db.exec('DELETE FROM memory_versions')
    await asWriter('end of day', undefined, () => store.upsert('memory', { id: page.id, body: 'A fintech in Rosebank.' }))
    const history = store.memoryHistory(page.id)
    expect(history.map((v) => [v.n, v.by, v.body])).toEqual([
      [2, 'end of day', 'A fintech in Rosebank.'],
      [1, 'earlier', 'A fintech.'],
    ])
  })

  it('records a deletion and keeps the history after it', async () => {
    const page = await store.upsert('memory', { title: 'Old plan', body: 'x' })
    await toolNamed(tools(), 'memory_update').run({ id: page.id, delete: true }, testContext({ agentLabel: 'main' }))
    expect(store.memoryHistory(page.id)[0]).toMatchObject({ n: 2, by: 'agent', deleted: true, changed: ['deleted'], title: 'Old plan' })
  })

  it('files a chat as "chat filing" through the memory service', async () => {
    const index = new ChatIndex(':memory:')
    const service = new MemoryService({
      store,
      index,
      upkeep: new UpkeepFile(null),
      complete: async () =>
        JSON.stringify({ title: 'Acme invoices', summary: 'Planned.', memories: [{ kind: 'person', title: 'Lerato Dlamini', body: 'Runs the books at Acme.' }] }),
      now: () => clock,
    })
    await store.upsert('chat_item', { kind: 'user', text: 'Lerato Dlamini at Acme sends the invoices on the 25th, please remember that.', meta: '{}' })
    await store.upsert('chat_item', { kind: 'agent', text: 'Noted.', meta: '{}' })
    await service.newChat()
    await service.idle()
    const lerato = (await store.list('memory')).find((row) => row.title === 'Lerato Dlamini')
    expect(lerato).toBeDefined()
    expect(store.memoryHistory(lerato?.id ?? '')[0]).toMatchObject({ by: 'chat filing', reason: 'Acme invoices', changed: ['created'] })
    index.close()
  })

  it('puts an earlier version back as a new version, so nothing is lost', async () => {
    const page = await store.upsert('memory', { title: 'Budget', body: 'R18,000' })
    await store.upsert('memory', { id: page.id, body: 'R25,000' })
    expect(await restoreVersion(store, page.id, 1, 'you')).toBe(true)
    expect((await store.get('memory', page.id))?.body).toBe('R18,000')
    expect(store.memoryHistory(page.id).map((v) => [v.n, v.by, v.reason, v.body])).toEqual([
      [3, 'you', 'restored version 1', 'R18,000'],
      [2, 'app', '', 'R25,000'],
      [1, 'app', '', 'R18,000'],
    ])
    expect(await restoreVersion(store, page.id, 9, 'you')).toBe(false)
  })
})

describe('closing a page', () => {
  it('keeps it searchable but out of what the agent is reminded of', async () => {
    const done = await store.upsert('memory', { title: 'February receipts', body: 'Lerato owes the February receipts.', kind: 'decision', topics: 'receipts', pinned: true })
    const update = toolNamed(tools(), 'memory_update')
    const closed = await update.run({ id: done.id, status: 'closed', reason: 'she sent them' }, testContext({ agentLabel: 'main' }))
    expect(closed).toBe(`Closed #${done.id} 'February receipts', now version 2: status.`)
    const row = (await store.get('memory', done.id)) as MemoryRow
    expect(row.status).toBe('closed')
    expect(typeof row.closedAt).toBe('number')

    const all = await store.list('memory')
    expect(recallFor('the February receipts from Lerato', all, 8)).toEqual([])
    const prompt = buildSystemPrompt({ settings: DEFAULT_SETTINGS, memories: all, goals: [], tasks: [], latestUserText: 'receipts' } as never)
    expect(prompt).not.toContain('Lerato owes the February receipts')
    expect(await toolNamed(tools(), 'memory_search').run({ query: 'February receipts' }, testContext())).toContain(', closed] February receipts')

    expect(await update.run({ id: done.id, status: 'open' }, testContext({ agentLabel: 'main' }))).toContain('now version 3: status')
    expect((await store.get('memory', done.id))?.closedAt).toBeNull()
  })
})

describe('other names a page answers to', () => {
  it('finds a page by a mis-heard name once it is an alias, and the agent can add one', async () => {
    const londa = await store.upsert('memory', { title: 'Initech', body: 'Construction client of Strat Edge.', kind: 'organisation', topics: 'client' })
    expect(namedPages('send the Londercorp estimate', await store.list('memory'))).toEqual([])

    const added = await toolNamed(tools(), 'memory_update').run({ id: londa.id, add_alias: 'Londercorp', reason: 'dictation mis-heard it' }, testContext({ agentLabel: 'main' }))
    expect(added).toContain('now version 2: aliases')
    await toolNamed(tools(), 'memory_update').run({ id: londa.id, add_alias: 'londercorp' }, testContext({ agentLabel: 'main' }))
    expect((await store.get('memory', londa.id))?.aliases).toBe('Londercorp')

    const rows = await store.list('memory')
    expect(namedPages('send the Londercorp estimate', rows).map((row) => row.title)).toEqual(['Initech'])
    expect(rank('Londercorp', rows, 5).map((row) => row.title)).toEqual(['Initech'])
    expect(await toolNamed(tools(), 'memory_get').run({ id: londa.id }, testContext())).toContain('also called: Londercorp')
  })

  it('gives dictation the names memory knows, and puts known mis-hearings right', async () => {
    const rows = [
      { id: 'a', title: 'Initech', body: '', kind: 'organisation', topics: '', pinned: false, source: 'agent', createdAt: 1, updatedAt: 3, aliases: 'Londercorp, London Corp' },
      { id: 'b', title: 'Thandi Mokoena', body: '', kind: 'person', topics: '', pinned: false, source: 'agent', createdAt: 1, updatedAt: 2, aliases: 'Bo' },
      { id: 'c', title: 'Seat preference', body: 'Window seats.', kind: 'preference', topics: '', pinned: false, source: 'user', createdAt: 1, updatedAt: 1 },
      { id: 'd', title: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', body: '', kind: 'project', topics: '', pinned: false, source: 'user', createdAt: 1, updatedAt: 4 },
    ] as MemoryRow[]
    const vocabulary = vocabularyFrom(rows)
    expect(vocabulary.names).toEqual(['Initech', 'Thandi Mokoena'])
    expect(vocabulary.aliases).toEqual([
      { heard: 'Londercorp', name: 'Initech' },
      { heard: 'London Corp', name: 'Initech' },
      { heard: 'Bo', name: 'Thandi Mokoena' },
    ])
    expect(applyAliases('Email londercorp and London  Corp today, Bo said so.', vocabulary)).toBe('Email Initech and Initech today, Bo said so.')
    const brief = vocabularyBrief(vocabulary)
    expect(brief).toContain('Initech, Thandi Mokoena')
    expect(brief).toContain('Londercorp = Initech')
    const request = cleanupRequest('send it to londercorp', brief) as { systemInstruction: { parts: Array<{ text: string }> } }
    expect(request.systemInstruction.parts[0]?.text).toContain('Londercorp = Initech')
    expect(vocabularyBrief({ names: [], aliases: [] })).toBe('')
  })
})
