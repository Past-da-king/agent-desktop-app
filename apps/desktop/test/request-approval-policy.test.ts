import { describe, expect, it } from 'vitest'
import { classifyCard } from '../src/shared/approval-policy'
import { stampCard, needsHim } from '../src/shared/card-state'

const card = (tool: string, description: string, asker: 'helper' | 'project' | 'routine' = 'helper') => ({
  kind: 'approval' as const, asker, summary: 'Please approve',
  origin: { tool: 'webapp_run', input: { tool, description, sends: false } },
})
describe('learned approval routing uses operations, including identifier words', () => {
  it.each(['helper', 'project', 'routine'] as const)('routes access work from %s before notifying the person', (asker) => {
    const facts = card('get_onedrive_access', 'Get access to a colleague drive', asker)
    expect(classifyCard(facts).lane).toBe('agent')
    expect(needsHim({ kind: 'approval', meta: JSON.stringify(stampCard({ ...facts, actsForMe: true, now: 100 })) })).toBe(false)
  })
  it.each([
    ['send_email', 'Deliver the result', 'outbound'],
    ['publishPost', 'Create entry', 'outbound'],
    ['buy_credits', 'Add balance', 'money'],
    ['reveal_secret', 'Read value', 'secret'],
    ['use_passkey', 'Continue operation', 'hands'],
  ])('keeps %s with the person even with a harmless description', (tool, description, rule) => {
    expect(classifyCard(card(tool, description))).toMatchObject({ lane: 'him', rule })
  })
  it('does not accept asks_first as evidence of safety', () => {
    expect(classifyCard(card('opaque_operation', 'Unclassified operation')).lane).toBe('him')
  })
})

it('routes verified app updates from task runs through the main agent', () => {
 expect(classifyCard({ kind: 'approval', asker: 'helper', summary: 'Install verified update', origin: { tool: 'app_update', input: { version: '1.2.3' } } })).toMatchObject({ lane: 'agent' })
})
