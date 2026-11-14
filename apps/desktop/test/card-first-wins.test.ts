import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, encodeStamp, providerFor, type Change, type ChatEvent, type Settings } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { HelperManager } from '../src/main/runtime/helpers'
import { cardFailText } from '../src/renderer/lib/cards'
import { Runner, type RunnerDeps } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

let store: Store | null = null
let fake: FakeAi | null = null
const runners: Runner[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  store?.close()
  store = null
  await fake?.close()
  fake = null
})

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

function makeRunner(existing?: Store, clock?: () => number) {
  store = existing ?? store ?? new Store(':memory:')
  const database = store
  const deps: RunnerDeps = {
    store: database,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
    secrets: secretsView('test-key'),
    tools: [...buildToolset({ store: database })],
    providerFactory: (_current, key) => (fake === null ? null : providerFor({ provider: 'openai', key, baseUrl: fake.url, allowHttp: true })),
    emit: (_event: ChatEvent) => undefined,
    notify: () => undefined,
    isFocused: () => false,
    timeZone: 'UTC',
    ...(clock === undefined ? {} : { now: clock }),
  }
  const runner = new Runner(deps)
  runners.push(runner)
  return { runner, store: database }
}

const meta = async (database: Store, id: string): Promise<Record<string, unknown>> => JSON.parse((await database.get('chat_item', id))?.meta ?? '{}') as Record<string, unknown>
const quiet = (ms = 200): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function pendingCard(database: Store, kind: 'approval' | 'question' = 'approval'): Promise<string> {
  const row = await database.upsert('chat_item', {
    kind,
    text: 'Send the email to Lerato',
    meta: JSON.stringify(kind === 'approval' ? { summary: 'Send the email to Lerato', details: '', decision: '' } : {}),
  })
  return row.id
}

const ASK_APPROVAL = (_body: unknown, index: number) =>
  index === 0 ? { toolCalls: [{ name: 'request_approval', input: { summary: 'Send the email to Lerato', details: 'x' } }] } : { text: 'Done.' }

describe('R1: the first decision on a card wins', () => {
  it('desktop and phone decide at the same time: one wins, the card shows what proceeded, the loser is told', async () => {
    fake = await startFakeAi(ASK_APPROVAL)
    const { runner, store: database } = makeRunner()
    const sending = runner.send('Email Lerato').catch(() => undefined)
    const card = await waitFor(async () => (await database.list('chat_item')).find((row) => row.kind === 'approval'))

    const results = await Promise.allSettled([runner.decide(card.id, 'approve', 'desktop'), runner.decide(card.id, 'decline', 'phone')])
    await sending

    expect(results[0].status).toBe('fulfilled')
    expect(results[1].status).toBe('rejected')
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/already decided: approve by desktop/)
    expect(await meta(database, card.id)).toMatchObject({ decision: 'approve', decisionBy: 'desktop' })
    expect(JSON.stringify(fake.requests[1]?.body)).not.toContain('The user declined.')
  })

  it('a later request cannot overwrite the displayed decision after the first released its waiter', async () => {
    fake = await startFakeAi(ASK_APPROVAL)
    const { runner, store: database } = makeRunner()
    const sending = runner.send('Email Lerato').catch(() => undefined)
    const card = await waitFor(async () => (await database.list('chat_item')).find((row) => row.kind === 'approval'))
    await runner.decide(card.id, 'approve', 'desktop')
    await sending
    await expect(runner.decide(card.id, 'decline', 'phone')).rejects.toThrow(/already decided/)
    expect((await meta(database, card.id))['decision']).toBe('approve')
  })

  it('the same decision repeated is quiet and starts nothing more', async () => {
    fake = await startFakeAi(() => ({ text: 'ok' }))
    const { runner, store: database } = makeRunner()
    const id = await pendingCard(database)
    await runner.decide(id, 'approve', 'desktop')
    await expect(runner.decide(id, 'approve', 'desktop')).resolves.toBeUndefined()
    await quiet()
    expect(fake.requests).toHaveLength(1)
  })

  it('several decisions at once with no live waiter enqueue exactly one continuation', async () => {
    fake = await startFakeAi(() => ({ text: 'Carrying on.' }))
    const { runner, store: database } = makeRunner()
    const id = await pendingCard(database)
    const results = await Promise.allSettled([runner.decide(id, 'approve', 'desktop'), runner.decide(id, 'approve', 'phone'), runner.decide(id, 'decline', 'phone')])
    await waitFor(async () => (fake?.requests.length ?? 0) >= 1)
    await quiet()
    expect(fake.requests).toHaveLength(1)
    expect(JSON.stringify(fake.requests[0]?.body)).toContain('approved')
    expect(results[2].status).toBe('rejected')
    expect((await meta(database, id))['decision']).toBe('approve')
  })

  it('a repeat after a restart (fresh runner, same database) starts nothing more', async () => {
    fake = await startFakeAi(() => ({ text: 'Carrying on.' }))
    const first = makeRunner()
    const id = await pendingCard(first.store)
    await first.runner.decide(id, 'approve', 'desktop')
    await waitFor(async () => (fake?.requests.length ?? 0) >= 1)
    first.runner.dispose()
    const second = makeRunner(first.store)
    await second.runner.decide(id, 'approve', 'phone')
    await expect(second.runner.decide(id, 'decline', 'phone')).rejects.toThrow(/already decided/)
    await quiet()
    expect(fake.requests).toHaveLength(1)
  })

  it('a question answered twice at once continues once and keeps the first answer', async () => {
    fake = await startFakeAi(() => ({ text: 'Thanks.' }))
    const { runner, store: database } = makeRunner()
    const id = await pendingCard(database, 'question')
    const results = await Promise.allSettled([runner.answer(id, 'Blue', 'desktop'), runner.answer(id, 'Red', 'phone')])
    await waitFor(async () => (fake?.requests.length ?? 0) >= 1)
    await quiet()
    expect(fake.requests).toHaveLength(1)
    expect(results[1].status).toBe('rejected')
    expect((await meta(database, id))['answer']).toBe('Blue')
  })
})

describe('R1: replicated decisions', () => {
  const change = (id: string, device: string, millis: number, decision: string, decisionAt: number, decisionBy: string): Change => ({
    entity: 'chat_item',
    id,
    deleted: false,
    stamp: encodeStamp({ millis, counter: 0, device }),
    payload: { kind: 'approval', text: 'Send', meta: JSON.stringify({ summary: 'Send', decision, decisionAt, decisionBy }), createdAt: 1 },
  })

  it('a later conflicting decision from another brain never replaces the first, and resumes nothing', async () => {
    fake = await startFakeAi(() => ({ text: 'ok' }))
    const first = makeRunner()
    const id = await pendingCard(first.store)
    await first.runner.decide(id, 'approve', 'desktop')
    await waitFor(async () => (fake?.requests.length ?? 0) >= 1)
    const at = (await meta(first.store, id))['decisionAt'] as number
    await first.store.applyRemote([change(id, 'phone-device', 9_000_000_000_000, 'decline', at + 5000, 'phone')])
    expect((await meta(first.store, id))['decision']).toBe('approve')
    await quiet()
    expect(fake.requests).toHaveLength(1)
  })

  it('an earlier remote decision beats our later one, and a pending write never undoes a decision', async () => {
    fake = await startFakeAi(() => ({ text: 'ok' }))
    const { runner, store: database } = makeRunner()
    const id = await pendingCard(database)
    await runner.decide(id, 'approve', 'desktop')
    const at = (await meta(database, id))['decisionAt'] as number
    await database.applyRemote([change(id, 'phone-device', 9_000_000_000_000, '', 0, '')])
    expect((await meta(database, id))['decision']).toBe('approve')
    await database.applyRemote([change(id, 'phone-device', 9_000_000_000_001, 'decline', at - 1000, 'phone')])
    expect((await meta(database, id))['decision']).toBe('decline')
  })

  it('same instant: the lower device name wins, whatever order the changes arrive in', async () => {
    store = new Store(':memory:')
    const id = await pendingCard(store)
    await store.applyRemote([change(id, 'zzz', 9_000_000_000_000, 'decline', 5000, 'zzz')])
    await store.applyRemote([change(id, 'aaa', 9_000_000_000_001, 'approve', 5000, 'aaa')])
    expect((await meta(store, id))['decision']).toBe('approve')
    await store.applyRemote([change(id, 'zzz', 9_000_000_000_002, 'decline', 5000, 'zzz')])
    expect((await meta(store, id))['decision']).toBe('approve')
  })
})

describe('F2: a button tap is delivered once', () => {
  const agentMessage = async (database: Store): Promise<string> => (await database.upsert('chat_item', { kind: 'agent', text: 'Pick one', meta: '{}' })).id

  it('the same tap id twice (and again later) dispatches once', async () => {
    fake = await startFakeAi(() => ({ text: 'Noted.' }))
    const { runner, store: database } = makeRunner()
    const id = await agentMessage(database)
    await Promise.all([runner.tap(id, 'Yes', 'I pick yes', 'tap-1'), runner.tap(id, 'Yes', 'I pick yes', 'tap-1')])
    await runner.tap(id, 'Yes', 'I pick yes', 'tap-1')
    await quiet()
    expect(fake.requests).toHaveLength(1)
  })

  it('two different ids dispatch twice', async () => {
    fake = await startFakeAi(() => ({ text: 'Noted.' }))
    const { runner, store: database } = makeRunner()
    const id = await agentMessage(database)
    await runner.tap(id, 'Yes', 'I pick yes', 'tap-1')
    await runner.tap(id, 'Yes', 'I pick yes', 'tap-2')
    expect(fake.requests).toHaveLength(2)
  })

  it('a retry after a restart dispatches once', async () => {
    fake = await startFakeAi(() => ({ text: 'Noted.' }))
    const first = makeRunner()
    const id = await agentMessage(first.store)
    await first.runner.tap(id, 'Yes', 'I pick yes', 'tap-1')
    first.runner.dispose()
    const second = makeRunner(first.store)
    await second.runner.tap(id, 'Yes', 'I pick yes', 'tap-1')
    expect(fake.requests).toHaveLength(1)
  })

  it('an old client without an id: a duplicate inside a few seconds is one tap, a later tap is a new one', async () => {
    fake = await startFakeAi(() => ({ text: 'Noted.' }))
    let now = 1_000_000
    const { runner, store: database } = makeRunner(undefined, () => now)
    const id = await agentMessage(database)
    await runner.tap(id, 'Yes', 'I pick yes')
    now += 1500
    await runner.tap(id, 'Yes', 'I pick yes')
    expect(fake.requests).toHaveLength(1)
    now += 60_000
    await runner.tap(id, 'Yes', 'I pick yes')
    expect(fake.requests).toHaveLength(2)
  })
})

describe('R1: a helper card is decided once too', () => {
  it('two decisions at once on a helper approval: the first wins, the helper proceeds with it, the other is told', async () => {
    fake = await startFakeAi((_body, index) =>
      index === 0 ? { toolCalls: [{ name: 'request_approval', input: { summary: 'Delete the old backups', details: 'x' } }] } : { text: 'Finished.' },
    )
    const database = new Store(':memory:')
    store = database
    const manager = new HelperManager({
      store: database,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake!.url, allowHttp: true }),
      workerTools: [...buildWorkerToolset({ store: database })],
      deliver: () => undefined,
      platform: 'linux',
      timeZone: 'UTC',
    })
    try {
      await manager.delegate([{ label: 'Clean up', brief: 'Remove old backups.' }])
      const card = await waitFor(async () => (await database.list('chat_item')).find((row) => row.kind === 'approval'))
      const results = await Promise.allSettled([manager.decide(card.id, 'approve', 'desktop'), manager.decide(card.id, 'decline', 'phone')])
      expect(results[0].status).toBe('fulfilled')
      expect(results[1].status).toBe('rejected')
      expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/already decided: approve by desktop/)
      expect(await meta(database, card.id)).toMatchObject({ decision: 'approve', decisionBy: 'desktop' })
      await waitFor(async () => (fake?.requests.length ?? 0) >= 2)
      expect(JSON.stringify(fake.requests[1]?.body)).not.toContain('The user declined.')
    } finally {
      await manager.stopAll()
    }
  })
})

describe('the words a card shows when someone else settled it first', () => {
  it('shows the already-decided line from an IPC-wrapped error and a plain retry for anything else', () => {
    expect(cardFailText(new Error("Error invoking remote method 'agent:chat.decide': Error: already decided: approve by Pixel 9"))).toBe('Already decided: approve by Pixel 9.')
    expect(cardFailText(new Error('socket closed'))).toBe('That did not go through. Try again.')
  })
})
