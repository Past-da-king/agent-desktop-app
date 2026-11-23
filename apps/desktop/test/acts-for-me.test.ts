import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, MAIN_CHAT } from '@agent/core'
import { Store } from '../src/main/db'
import { ActsForMe } from '../src/main/runtime/acts-for-me'
import { classifyCard } from '../src/shared/approval-policy'
import { metaOfCard, needsHim, stampCard } from '../src/shared/card-state'
import { staleReason, type StaleFacts } from '../src/shared/stale-card'
import { mayAnswerCards } from '../src/main/tools/cards'
import { claimCard } from '../src/main/runtime/card-claim'

const stores: Store[] = []
afterEach(() => { stores.splice(0).forEach((s) => s.close()); vi.useRealTimers() })
const facts = (tool: string, input: Record<string, unknown> = {}, summary = 'Update a setting') => ({ kind: 'approval' as const, asker: 'helper' as const, summary, origin: { tool, input } })
const base: StaleFacts = { hasWaiter: false, askerElsewhere: false, helperLive: false, chatNewer: { user: false, agent: false }, helperProgressed: false, newerCard: false, chatRunning: false, now: 1_000_000, createdAt: 1 }
function setup(on = true) {
  const store = new Store(':memory:'); stores.push(store)
  let current = { ...DEFAULT_SETTINGS, actsForMe: on }
  const told = vi.fn(async () => undefined)
  const notices = vi.fn()
  const posted = vi.fn(async (_text: string) => undefined)
  const acts = new ActsForMe({ store, settings: { get: () => current }, now: () => Date.now() + 60_000,
    decide: async (id, decision, by) => { await claimCard(store, id, 'decision', decision, by, 1_000_000) },
    answerQuestion: async (id, answer, by) => { await claimCard(store, id, 'answer', answer, by, 1_000_000) },
    postToMain: posted, tellAsker: told,
    setSettings: async (patch) => { current = { ...current, ...patch } },
    hasWaiter: () => false, liveHelpers: () => new Set(), chatRunning: () => false,
    needsYou: notices, changed: vi.fn(),
  })
  async function card(tool = 'shell_run', input: Record<string, unknown> = { command: 'npm run deploy' }, asker: 'main' | 'helper' = 'helper') {
    return store.upsert('chat_item', { kind: 'approval', text: 'Update a setting', meta: JSON.stringify({ decision: '', helper: 'helper1', ...acts.stamp({ ...facts(tool, input, typeof input['summary'] === 'string' ? input['summary'] : 'Update a setting'), asker, askerKey: 'helper1' }) }) })
  }
  return { store, acts, card, told, notices, posted, current: () => current, off: () => { current.actsForMe = false } }
}

describe('real call policy, never the helper summary', () => {
  it.each([
    ['apps_run', { slug: 'GMAIL_SEND_EMAIL' }], ['apps_run', { slug: 'SLACK_CHAT_POST_MESSAGE' }],
    ['apps_run', { slug: 'FILES_DELETE', actions: ['FILES_DELETE', 'GMAIL_SEND_EMAIL'] }],
    ['webapp_run', { tool: 'update_settings', description: 'change setting', sends: true }],
    ['browser_fetch', { method: 'POST', url: 'https://slack.com/api/chat.postMessage' }],
    ['send_file', { recipient: 'lerato@example.com' }], ['shell_run', { command: 'curl -X POST https://slack.com/api/chat.postMessage' }],
    ['shell_run', { command: 'rm -rf ~' }], ['vault_passkey', {}], ['unknown_tool', {}],
  ])('keeps %s with him despite update-setting relabel', (tool, input) => {
    expect(classifyCard(facts(tool as string, input)).lane).toBe('him')
  })
  it.each([
    ['shell_run', { command: 'npm run deploy' }], ['shell_run', { command: 'npm run migrate' }],
    ['settings_set', { values: { notifications: false } }], ['files_delete', { path: '/home/impetix/project/temp.txt' }],
  ])('routes task %s to the main agent', (tool, input) => { expect(classifyCard(facts(tool as string, input)).lane).toBe('agent') })
  it('cannot put the main agent own card in its lane', () => { expect(classifyCard({ ...facts('shell_run', { command: 'npm run deploy' }), asker: 'main' }).lane).toBe('him') })
  it('missing origin and changing actsForMe are his', () => {
    expect(classifyCard({ kind: 'approval', asker: 'helper', summary: 'Deploy it' }).lane).toBe('him')
    expect(classifyCard(facts('settings_set', { values: { actsForMe: false } })).lane).toBe('him')
  })
  it('an explicit request may only become more restrictive on sent text, payment or hands', () => {
    for (const summary of ['Send the email', 'Buy credits', 'Use the passkey', 'Sign in', 'Enter 2FA']) expect(classifyCard(facts('request_approval', {}, summary)).lane).toBe('him')
  })
  it('helpers and project chats cannot answer', () => {
    for (const ctx of [{ owner: 'helper:x', agentLabel: 'main', chat: MAIN_CHAT }, { owner: 'routine', agentLabel: 'main', chat: MAIN_CHAT }, { owner: 'main', agentLabel: 'main', chat: 'project1' }]) expect(mayAnswerCards(ctx)).toMatch(/Refused/)
    expect(mayAnswerCards({ owner: 'main', agentLabel: 'main', chat: MAIN_CHAT })).toBeNull()
  })
})

describe('routing, audit, Undo and off', () => {
  it('stamps callOrigin separately from a message origin and hides only routed cards', () => {
    const meta = stampCard({ ...facts('shell_run', { command: 'npm run deploy' }), actsForMe: true, now: 1_000_000 })
    expect(meta['callOrigin']).toMatchObject({ tool: 'shell_run' }); expect(meta['origin']).toBeUndefined()
    expect(needsHim({ kind: 'approval', meta: JSON.stringify(meta) })).toBe(false)
  })
  it('logs the main agent decision with reason and undo withdraws a decline', async () => {
    const x = setup(); const row = await x.card()
    expect((await x.acts.answer({ id: row.id, action: 'decline', reason: 'Already deployed' })).ok).toBe(true)
    expect(await x.acts.list()).toMatchObject([{ decision: 'decline', reason: 'Already deployed', undo: 'retry' }])
    expect((await x.acts.undo(row.id)).ok).toBe(true); expect(x.told).toHaveBeenCalledOnce()
    expect(x.acts.stamp({ ...facts('shell_run', { command: 'npm run deploy' }), askerKey: 'helper1' })['lane']).toBe('him')
    expect((await x.acts.undo(row.id)).ok).toBe(false)
    x.acts.dispose()
  })
  it('undo restores an approved setting from before the decision', async () => {
    const x = setup(); const row = await x.card('settings_set', { values: { notifications: false } })
    expect((await x.acts.answer({ id: row.id, action: 'approve', reason: 'Task requires this' })).ok).toBe(true)
    expect((await x.acts.list())[0]?.undo).toBe('revert-setting')
    expect((await x.acts.undo(row.id)).ok).toBe(true); expect(x.current().notifications).toBe(DEFAULT_SETTINGS.notifications)
  })
  it('an approved command has no false Undo', async () => {
    const x = setup(); const row = await x.card(); await x.acts.answer({ id: row.id, action: 'approve', reason: 'Within scope' })
    expect((await x.acts.list())[0]?.undo).toBe('none'); expect((await x.acts.undo(row.id)).ok).toBe(false)
  })
  it.each([['apps_run', { slug: 'SLACK_CHAT_POST_MESSAGE' }], ['request_approval', { summary: 'Buy credits' }], ['vault_passkey', {}]])('refuses to answer %s for him', async (tool, input) => {
    const x = setup(); const row = await x.card(tool as string, input)
    expect((await x.acts.answer({ id: row.id, action: 'approve', reason: 'Safe' })).ok).toBe(false)
    expect(needsHim((await x.store.get('chat_item', row.id))!)).toBe(true)
  })
  it('setting off gives old behavior and escalates already routed cards', async () => {
    const x = setup(); const row = await x.card(); x.off(); await x.acts.sweep()
    expect(x.notices).toHaveBeenCalledOnce()
    expect((await x.acts.answer({ id: row.id, action: 'approve', reason: 'Safe' })).ok).toBe(false)
    const next = await x.card(); expect(needsHim(next)).toBe(true)
  })
})

describe('stale closure protects live waiters', () => {
  it.each([
    [{ newerCard: true }, 'replaced'], [{ helperState: 'done' }, 'run-ended'],
    [{ chatNewer: { user: true, agent: false } }, 'answered-elsewhere'],
    [{ chatNewer: { user: false, agent: true } }, 'already-done'],
    [{ helperState: 'working', helperProgressed: true }, 'already-done'],
  ])('closes the stale cause %s', (extra, reason) => { expect(staleReason({ ...base, ...extra })?.reason).toBe(reason) })
  it('does not close a waiter, a remote asker or a fresh card', () => {
    expect(staleReason({ ...base, hasWaiter: true, helperState: 'done' })).toBeNull()
    expect(staleReason({ ...base, askerElsewhere: true, helperState: 'done' })).toBeNull()
    expect(staleReason({ ...base, now: 100, newerCard: true })).toBeNull()
  })
  it('closed stale cards cannot be revived by a late answer', async () => {
    const x = setup(false); const row = await x.card(); await x.acts.sweep()
    expect(await claimCard(x.store, row.id, 'decision', 'approve', 'phone', Date.now())).toBeNull()
    expect(metaOfCard((await x.store.get('chat_item', row.id))!)['decision']).toBe('')
  })
  it('routes a new card to the main thread as a batched note', async () => {
    vi.useFakeTimers()
    const x = setup(); const row = await x.card(); x.acts.route(row.id)
    await vi.advanceTimersByTimeAsync(4000)
    expect(x.posted).toHaveBeenCalledOnce()
    expect(x.posted.mock.calls[0]?.[0]).toContain(row.id)
    x.acts.dispose()
  })
  it('the sweep closes a finished helper card and removes it from Needs you', async () => {
    const x = setup(false); const row = await x.card(); await x.acts.sweep()
    const closed = (await x.store.get('chat_item', row.id))!
    expect(metaOfCard(closed)['closedReason']).toBe('run-ended'); expect(needsHim(closed)).toBe(false)
  })
})
