import { afterEach, expect, it, vi } from 'vitest'
import { Store } from '../src/main/db'
import { DeviceQuestions } from '../src/main/devices/device-questions'
import { testContext } from './support'
const stores: Store[] = []
afterEach(() => stores.splice(0).forEach((s) => s.close()))
async function setup() {
 const store = new Store(':memory:'); stores.push(store)
 const row = await store.upsert('device_command', { kind: 'tool', target: 'phone', brainId: 'brain', tool: 'webapp_test', args: JSON.stringify({ app: 'Example', tool: 'get_access', args: { site: 'example.org' } }), status: 'sent', expiresAt: 10000, chat: 'main' })
 const approve = vi.fn(async () => true); const ask = vi.fn(async () => 'Answer')
 const controller = new AbortController()
 const questions = new DeviceQuestions(store, () => 'brain', () => 100)
 questions.remember(row.id, testContext({ owner: 'helper:trusted', approve, ask, signal: controller.signal }), 10000)
 const call = [row.id, 1, 'APPROVAL|Get access|Exact details with | punctuation', ['Approve', 'Decline'], { tool: 'webapp_run', input: { app: 'Example', tool: 'get_access', description: 'Get drive access' } }]
 return { store, row, questions, approve, ask, controller, call }
}
it('returns phone learned approvals through the original context, retaining inner operation metadata', async () => {
 const x = await setup()
 expect(await x.questions.ask('phone', x.call)).toEqual({ handled: true, answer: 'Approve' })
 expect(x.approve).toHaveBeenCalledWith('Get access', 'Exact details with | punctuation', undefined, expect.objectContaining({ tool: 'webapp_run', input: expect.objectContaining({ tool: 'get_access' }) }))
})
it('a replay returns the same decision and never makes another card', async () => {
 const x = await setup(); await Promise.all([x.questions.ask('phone', x.call), x.questions.ask('phone', x.call)])
 expect(x.approve).toHaveBeenCalledTimes(1)
 await expect(x.questions.ask('phone', [x.row.id, 1, 'APPROVAL|Different action|Changed', [], x.call[4]])).rejects.toThrow('different content')
})
it('refuses another paired device, expired commands and completed commands', async () => {
 const x = await setup()
 await expect(x.questions.ask('other-phone', x.call)).rejects.toThrow('not active')
 await x.store.upsert('device_command', { id: x.row.id, status: 'done' })
 await expect(x.questions.ask('phone', x.call)).rejects.toThrow('not active')
 expect(x.approve).not.toHaveBeenCalled()
})
it('an ended context cannot generate a new card or silently fall back to the phone', async () => {
 const x = await setup(); x.controller.abort()
 expect(await x.questions.ask('phone', x.call)).toEqual({ handled: true, answer: null })
 expect(x.approve).not.toHaveBeenCalled()
})
it('plain questions use the same original-context path', async () => {
 const x = await setup(); await x.questions.ask('phone', [x.row.id, 1, 'Which folder?', ['A', 'B']])
 expect(x.ask).toHaveBeenCalledWith('Which folder?', ['A', 'B'], undefined, expect.objectContaining({ tool: 'webapp_test' }))
})
it('rejects malformed requests before touching a card', async () => {
 const x = await setup()
 await expect(x.questions.ask('phone', [x.row.id, 0, 'Question', []])).rejects.toThrow('Invalid')
 expect(x.approve).not.toHaveBeenCalled()
})

it('the phone cannot substitute another learned operation or the original arguments', async () => {
 const x = await setup()
 await x.store.upsert('device_command', { id: x.row.id, args: JSON.stringify({ app: 'Example', tool: 'send_email', args: { to: 'person@example.org', body: 'Actual content' } }) })
 await x.questions.ask('phone', x.call)
 expect(x.approve).toHaveBeenCalledWith(expect.any(String), expect.any(String), undefined, expect.objectContaining({ tool: 'webapp_test', input: expect.objectContaining({ tool: 'send_email' }) }))
})

it('an active command whose brain lost its in-memory context requests a person fallback', async () => {
 const x = await setup(); x.questions.forget(x.row.id)
 expect(await x.questions.ask('phone', x.call)).toEqual({ handled: false, answer: null })
 expect(x.approve).not.toHaveBeenCalled()
})
