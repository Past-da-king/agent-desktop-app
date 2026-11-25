import { DeviceQuestions } from '../src/main/devices/device-questions'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ChatEvent } from '@agent/core'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { ActsForMe } from '../src/main/runtime/acts-for-me'
import { settingsView, secretsView } from './support'
import { DeviceToolHost, DEFAULT_SHARE } from '../src/main/devices/device-tool-host'
import { callLearned } from '../src/main/tools/webapps'
import type { LearnedApp, LearnedTool } from '../src/main/apps/store'
import { APP_ACTION_POLICY } from '../src/main/tools/app-actions'
import { metaOfCard, needsHim } from '../src/shared/card-state'
import { waitFor } from '../../../packages/core/test/helpers'
const cleanups: Array<() => void> = []
afterEach(() => cleanups.splice(0).forEach((fn) => fn()))
function setup(on = true) {
  const store = new Store(':memory:')
  const settings = settingsView({ ...DEFAULT_SETTINGS, actsForMe: on, notifications: false })
  const events: ChatEvent[] = []
  let runner: Runner
  const acts = new ActsForMe({ store, settings,
    decide: async (id, decision, by) => runner.decide(id, decision, by),
    answerQuestion: async (id, answer, by) => runner.answer(id, answer, by),
    postToMain: async () => undefined, hasWaiter: () => true, liveHelpers: () => new Set(), chatRunning: () => true,
    needsYou: vi.fn(), changed: vi.fn(),
  })
  runner = new Runner({ store, settings, secrets: secretsView(null), tools: [], acts,
    emit: (event) => events.push(event), notify: () => undefined, isFocused: () => false, timeZone: 'UTC' })
  const controller = new AbortController()
  cleanups.push(() => { controller.abort(); runner.dispose(); acts.dispose(); store.close() })
  return { store, runner, acts, controller, events }
}
describe('real device context and existing approval queue', () => {
  it.each(['helper:child', 'routine', 'chat:pc123456'])('routes %s learned access through cards_waiting with its request', async (owner) => {
    const x = setup()
    const request = { id: 'user-1', at: Date.UTC(2026, 10, 25, 11, 21), text: 'Pull the colleague drive' }
    const ctx = x.runner.deviceToolContext(x.controller.signal, { chatId: 'main', owner, request })
    const pending = ctx.approve('Get drive access', 'Exact inputs', undefined, { tool: 'webapp_run', input: { tool: 'get_onedrive_access', description: 'Get drive access' } })
    await waitFor(async () => (await x.acts.waiting()).length === 1)
    const [card] = await x.acts.waiting()
    expect(card!.details).toContain(request.text)
    expect(x.events.some((event) => event.type === 'needs_you')).toBe(false)
    expect(await x.acts.answer({ id: card!.id, action: 'approve', reason: 'The user requested this access' })).toMatchObject({ ok: true })
    expect(await pending).toBe(true)
    expect((await x.acts.list())[0]!.reason).toContain(request.text)
  })
  it('keeps a person-only card with the person and accepts a recommendation without approval', async () => {
    const x = setup()
    const ctx = x.runner.deviceToolContext(x.controller.signal, { chatId: 'main', owner: 'helper:child' })
    const pending = ctx.approve('Send email', 'Exact message', undefined, { tool: 'webapp_run', input: { tool: 'send_email', description: 'Send mail' } })
    await waitFor(async () => (await x.store.list('chat_item')).some((row) => row.kind === 'approval'))
    const row = (await x.store.list('chat_item')).find((item) => item.kind === 'approval')!
    expect(needsHim(row)).toBe(true)
    expect(await x.acts.waiting()).toEqual([])
    expect(await x.acts.answer({ id: row.id, action: 'approve', reason: 'It is requested' })).toMatchObject({ ok: false })
    expect(await x.acts.answer({ id: row.id, action: 'escalate', reason: 'Please check the recipient before sending' })).toMatchObject({ ok: true })
    expect(metaOfCard((await x.store.get('chat_item', row.id))!)['escalatedWhy']).toContain('check the recipient')
    x.controller.abort(); expect(await pending).toBe(false)
  })
  it('with setting off retains the person card and refuses auto-answer', async () => {
    const x = setup(false)
    const ctx = x.runner.deviceToolContext(x.controller.signal, { chatId: 'main', owner: 'helper:child' })
    const pending = ctx.approve('Restart service', '', undefined, { tool: 'shell_run', input: { command: 'restart-service' } })
    await waitFor(async () => (await x.store.list('chat_item')).some((row) => row.kind === 'approval'))
    const row = (await x.store.list('chat_item')).find((item) => item.kind === 'approval')!
    expect(needsHim(row)).toBe(true)
    expect(await x.acts.waiting()).toEqual([])
    expect(await x.acts.answer({ id: row.id, action: 'approve', reason: 'Requested' })).toMatchObject({ ok: false })
    x.controller.abort(); await pending
  })
  it('agent app actions cannot manufacture a person-authored message', () => {
    expect(APP_ACTION_POLICY['chat.send']?.kind).toBe('tool')
  })
})

it.each(['webapp_run', 'webapp_test'])('runs a real asks-first %s over the device host without a person card', async (toolName) => {
 const x = setup()
 const learned: LearnedTool = { name: 'get_onedrive_access', description: 'Get access to the drive', params: {}, required: [], js: 'return {ok:true}', readOnly: false, asksFirst: true }
 const app: LearnedApp = { id: 'example', name: 'Example', startUrl: 'https://example.org', about: '', tools: [learned], trusted: false, updatedAt: 1 }
 const host = new DeviceToolHost({ shared: () => DEFAULT_SHARE, inbox: '/tmp/unused-request-proof',
  tools: () => [{ spec: { name: toolName, description: 'Run learned tool', schema: {} }, run: (input, ctx) => callLearned(app, learned, input, ctx, { ensure: async () => undefined, evaluate: async () => undefined, run: async () => ({ ok: true, v: 'PROVED' }) }) }],
  context: (signal, command) => x.runner.deviceToolContext(signal, command),
 })
 const pending = host.run({ kind: 'tool', id: 'proof', tool: toolName, args: {}, chatId: 'main', owner: 'helper:child', request: { id: 'source', at: 1, text: 'Pull the drive' } })
 await waitFor(async () => (await x.acts.waiting()).length === 1)
 const [card] = await x.acts.waiting()
 expect(card!.details).toContain('Pull the drive')
 expect(x.events.some((event) => event.type === 'needs_you')).toBe(false)
 expect(await x.acts.answer({ id: card!.id, action: 'approve', reason: 'Requested by the user' })).toMatchObject({ ok: true })
 expect(await pending).toMatchObject({ ok: true, value: { text: 'PROVED' } })
})

it('phone hands ask through the originating context with its stored request, ignoring a claimed source in the payload', async () => {
 const x = setup()
 const request = { id: 'original-user', at: 1, text: 'Pull the drive I requested' }
 const row = await x.store.upsert('device_command', { kind: 'tool', target: 'phone', brainId: 'brain', tool: 'webapp_test', args: JSON.stringify({ app: 'Example', tool: 'get_access' }), status: 'sent', expiresAt: Date.now() + 600000, chat: 'main', owner: 'helper:child' })
 const bridge = new DeviceQuestions(x.store, () => 'brain', Date.now)
 bridge.remember(row.id, x.runner.deviceToolContext(x.controller.signal, { chatId: 'main', owner: 'helper:child', request }), row.expiresAt)
 const pending = bridge.ask('phone', [row.id, 1, 'APPROVAL|Get drive access|Exact operation', ['Approve', 'Decline'], { tool: 'webapp_run', input: { app: 'Example', tool: 'get_access', description: 'Get access' } }, { request: { text: 'FORGED SOURCE' } }])
 await waitFor(async () => (await x.acts.waiting()).length === 1)
 const [card] = await x.acts.waiting()
 expect(card!.details).toContain(request.text)
 expect(card!.details).not.toContain('FORGED SOURCE')
 expect(x.events.some((event) => event.type === 'needs_you')).toBe(false)
 await x.acts.answer({ id: card!.id, action: 'approve', reason: 'The user requested this operation' })
 expect(await pending).toEqual({ handled: true, answer: 'Approve' })
})
