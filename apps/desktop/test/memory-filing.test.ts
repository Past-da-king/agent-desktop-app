import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ChatItem } from '@agent/core'

import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { chatSegments, latestDividerAt, memoryNote } from '../src/main/memory/chats'
import { MemoryService } from '../src/main/memory/service'
import { fileEntries, findSame, mergeBodies, parseDigest, type DraftEntry } from '../src/main/memory/summarise'
import { UpkeepFile } from '../src/main/memory/upkeep-log'

let store: Store
let index: ChatIndex
let clock = 1_760_000_000_000

beforeEach(() => {
  clock = 1_760_000_000_000
  store = new Store(':memory:', () => (clock += 10))
  index = new ChatIndex(':memory:')
})

afterEach(() => {
  index.close()
  store.close()
})

async function say(kind: 'user' | 'agent', text: string): Promise<void> {
  await store.upsert('chat_item', { kind, text, meta: '{}' })
}

async function seedChat(): Promise<void> {
  await say('user', 'Can you help me plan the invoices with Lerato Dlamini at Acme this month please?')
  await say('agent', 'Yes. Lerato sends them on the 25th as PDF, copied to you.')
  await say('user', 'Great, and remember the Acme billing password is Hunter2024! for later.')
  await say('agent', 'I will not keep passwords, but noted the process.')
}

function reply(entries: Array<Partial<DraftEntry> & { kind: string }>, extra: Record<string, unknown> = {}): string {
  return 'Here you go:\n```json\n' + JSON.stringify({ title: 'Acme invoices', summary: 'Planned the Acme invoice run with Lerato.', memories: entries, ...extra }) + '\n```'
}

function deferred(): { promise: Promise<string>; resolve: (value: string) => void; reject: (error: Error) => void } {
  let resolve: (value: string) => void = () => undefined
  let reject: (error: Error) => void = () => undefined
  const promise = new Promise<string>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

function service(complete: (system: string, prompt: string) => Promise<string>, extra: { forget?: () => void } = {}): MemoryService {
  return new MemoryService({
    store,
    index,
    upkeep: new UpkeepFile(null),
    complete,
    ...(extra.forget === undefined ? {} : { forgetSession: extra.forget }),
    now: () => clock,
  })
}

async function divider(): Promise<ChatItem> {
  const rows = await store.list('chat_item')
  const found = rows.filter((row) => row.kind === 'notice').at(-1)
  if (found === undefined) throw new Error('no divider')
  return found
}

describe('New Chat filing', () => {
  it('gives a fresh chat at once and files the old one in the background', async () => {
    await seedChat()
    const model = deferred()
    let prompt = ''
    let forgot = 0
    const memory = service(
      (_system, text) => {
        prompt = text
        return model.promise
      },
      { forget: () => (forgot += 1) },
    )

    const result = await memory.newChat()
    // The divider is there before the model has answered.
    expect(result.saving).toBe(true)
    const first = await divider()
    expect(memoryNote(first)).toEqual({ chat: chatSegments(await store.list('chat_item'))[0]?.id, status: 'saving' })
    expect(forgot).toBe(1)
    expect(await store.list('memory')).toHaveLength(0)
    expect(prompt).toContain('Person: Can you help me plan the invoices')

    model.resolve(
      reply([
        { kind: 'person', title: 'Lerato Dlamini', body: 'Runs the books at [[Acme]]. Sends the invoices on the 25th as PDF.', topics: 'acme, finance' },
        { kind: 'how-to', title: 'Send the Acme invoices', body: '1. On the 25th export the invoices as PDF.\n2. Lerato sends them, copied to the user.', topics: 'invoices' },
        { kind: 'fact', title: 'Acme billing login', body: 'password: Hunter2024!' },
        { kind: 'state', title: 'Working on invoices now', body: 'Currently checking the invoices for this month.' },
      ]),
    )
    await memory.idle()

    const memories = await store.list('memory')
    expect(memories.map((row) => row.title).sort()).toEqual(['Lerato Dlamini', 'Send the Acme invoices'])
    expect(JSON.stringify(memories)).not.toContain('Hunter2024')
    const done = memoryNote(await divider())
    expect(done?.status).toBe('done')
    expect(done?.saved).toHaveLength(2)
    expect(done?.added).toBe(2)
    const meta = JSON.parse((await divider()).meta) as Record<string, unknown>
    expect(meta['summary']).toBe('Planned the Acme invoice run with Lerato.')
    expect(meta['title']).toBe('Acme invoices')
  })

  it('updates the existing page on the same subject instead of adding a near-duplicate', async () => {
    const lerato = await store.upsert('memory', { title: 'Lerato Dlamini', body: "Sam's sister.\nLives in Durban.", kind: 'person', topics: 'family', pinned: true, source: 'user' })
    await seedChat()
    let prompt = ''
    const memory = service(async (_system, text) => {
      prompt = text
      return reply([
        // The model names the page it updates and writes the merged body.
        { kind: 'person', title: 'Lerato Dlamini', update: lerato.id, body: "Sam's sister.\nLives in Durban.\nRuns the books at [[Acme]].", topics: 'acme' },
        // Same subject again under a looser title, without an id: merged by title, not added.
        { kind: 'person', title: 'Lerato', body: 'Sends the invoices on the 25th.' },
      ])
    })

    await memory.newChat()
    await memory.idle()

    expect(prompt).toContain(`id ${lerato.id} [person] Lerato Dlamini`)
    const memories = await store.list('memory')
    expect(memories).toHaveLength(1)
    const page = memories[0]
    expect(page?.id).toBe(lerato.id)
    expect(page?.body).toBe("Sam's sister.\nLives in Durban.\nRuns the books at [[Acme]].\nSends the invoices on the 25th.")
    expect(page?.topics).toBe('family, acme')
    expect(page?.pinned).toBe(true)
    expect(memoryNote(await divider())).toMatchObject({ status: 'done', added: 0, updated: 1, saved: [lerato.id] })
  })

  it('never lets a merged body drop facts from a page the model only saw part of', async () => {
    const long = `${'Background on the client. '.repeat(80)}\nKey fact: renews in March.`
    const page = await store.upsert('memory', { title: 'Acme', body: long, kind: 'organisation', topics: 'work', pinned: false, source: 'user' })
    const result = await fileEntries(store, [{ kind: 'organisation', title: 'Acme', update: page.id, body: 'A fintech in Rosebank.', topics: '' }])
    expect(result.updated).toEqual([page.id])
    const after = await store.get('memory', page.id)
    expect(after?.body).toContain('Key fact: renews in March.')
    expect(after?.body).toContain('A fintech in Rosebank.')
  })

  it('does not file a chat with no substance, and New Chat twice adds one divider', async () => {
    await say('user', 'hi')
    await say('agent', 'Hello!')
    let calls = 0
    const memory = service(async () => {
      calls += 1
      return reply([])
    })
    const first = await memory.newChat()
    const second = await memory.newChat()
    await memory.idle()
    expect(first.saving).toBe(false)
    expect(second.dividerId).toBe(first.dividerId)
    expect(calls).toBe(0)
    expect((await store.list('chat_item')).filter((row) => row.kind === 'notice')).toHaveLength(1)
  })

  it('surfaces a failure quietly and files it on retry', async () => {
    await seedChat()
    let fail = true
    const memory = service(async () => {
      if (fail) throw new Error('Add an AI key in Settings to start')
      return reply([{ kind: 'preference', title: 'Invoices as PDF', body: 'The user wants invoices sent as PDF, never Word.' }])
    })
    await memory.newChat()
    await memory.idle()
    const failed = await divider()
    expect(memoryNote(failed)).toMatchObject({ status: 'failed', error: 'Add an AI key in Settings to start' })

    fail = false
    await memory.retrySave(failed.id)
    await memory.idle()
    expect(memoryNote(await divider())).toMatchObject({ status: 'done', added: 1 })
    expect((await store.list('memory'))[0]?.title).toBe('Invoices as PDF')
  })

  it('files again after a restart when the app closed mid-save', async () => {
    await seedChat()
    const never = service(() => new Promise<string>(() => undefined))
    await never.newChat()
    const later = service(async () => reply([{ kind: 'fact', title: 'Acme office', body: 'Acme has its office in Rosebank, Johannesburg.' }]))
    await later.restore()
    await later.idle()
    expect(memoryNote(await divider())?.status).toBe('done')
  })

  it('takes the old chat out of the model context but keeps every row', async () => {
    await seedChat()
    const memory = service(async () => reply([]))
    await memory.newChat()
    await memory.idle()
    const rows = await store.list('chat_item')
    expect(rows.filter((row) => row.kind === 'user')).toHaveLength(2)
    expect(latestDividerAt(rows)).toBe((await divider()).createdAt)
    expect(chatSegments(rows)).toHaveLength(2)
  })
})

describe('merge and dedupe rules', () => {
  it('reads a fenced or chatty reply and maps kind names', () => {
    const digest = parseDigest('Sure!\n```json\n{"title":"t","summary":"s","memories":[{"kind":"Organization","title":"Acme","body":"A company.","topics":["a","b"]},{"kind":"event","title":"x","body":"y"}]}\n```')
    expect(digest.entries).toEqual([{ kind: 'organisation', title: 'Acme', body: 'A company.', topics: 'a, b', update: '' }])
    expect(() => parseDigest('no json here')).toThrow('did not reply')
  })

  it('appends only lines the page does not already say', () => {
    expect(mergeBodies('- Lives in Durban.\n- Likes ceramics.', 'Lives in Durban.\nTurns 30 on 31 October.')).toBe('- Lives in Durban.\n- Likes ceramics.\nTurns 30 on 31 October.')
    expect(mergeBodies('Same.', 'same')).toBe('Same.')
  })

  it('matches the same subject by id, exact title, first name and close titles', () => {
    const now = Date.now()
    const base = { createdAt: now, updatedAt: now, pinned: false, source: 'agent' as const, topics: '' }
    const rows = [
      { ...base, id: 'p1', title: 'Alex Meyer', body: 'CEO.', kind: 'person' as const },
      { ...base, id: 'h1', title: 'Deploy the Creek sites to Cloudflare', body: '1. Build.', kind: 'how-to' as const },
      { ...base, id: 'f1', title: 'Acme', body: 'A company.', kind: 'fact' as const },
    ]
    const entry = (kind: DraftEntry['kind'], title: string, update = ''): DraftEntry => ({ kind, title, body: 'x', topics: '', update })
    expect(findSame(entry('person', 'Someone', 'p1'), rows)?.id).toBe('p1')
    expect(findSame(entry('person', 'Ben'), rows)?.id).toBe('p1')
    expect(findSame(entry('how-to', 'Deploy the Creek sites on Cloudflare'), rows)?.id).toBe('h1')
    expect(findSame(entry('organisation', 'ACME'), rows)?.id).toBe('f1')
    expect(findSame(entry('person', 'Ben Smith'), rows)).toBeNull()
    expect(findSame(entry('decision', 'Deploy the Creek sites to Cloudflare'), rows)).toBeNull()
  })

  it('takes the sharper kind when a fact page turns out to be an organisation', async () => {
    const page = await store.upsert('memory', { title: 'Acme', body: 'Where Sam works.', kind: 'fact', topics: '', pinned: false, source: 'agent' })
    await fileEntries(store, [{ kind: 'organisation', title: 'Acme', body: 'A fintech in Rosebank.', topics: 'work', update: '' }])
    expect((await store.get('memory', page.id))?.kind).toBe('organisation')
  })
})
