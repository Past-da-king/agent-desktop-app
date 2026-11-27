import { describe, expect, it } from 'vitest'
import { classifyCard, type CardFacts } from '../src/shared/approval-policy'

const request = 'Send "The meeting is at ten." to ben@example.org'
const base: CardFacts = { kind: 'approval', asker: 'helper', summary: 'Send email', request: { id: 'source', at: 1, text: request }, origin: { tool: 'request_approval', input: { summary: 'Send email', recipient: 'ben@example.org', details: 'The meeting is at ten.' } } }
describe('explicit send authorization', () => {
  it('routes the exact named content and recipient for main review', () => {
    expect(classifyCard(base)).toMatchObject({ lane: 'agent', rule: 'requested-outbound' })
  })
  it.each([
    'Reply "The meeting is at ten." to ben@example.org',
    'Draft "The meeting is at ten." to ben@example.org',
    'Rate "The meeting is at ten." for ben@example.org',
    'Send the update to ben@example.org',
    'Send "A different message." to ben@example.org',
  ])('keeps unapproved or mismatched content with the person: %s', (text) => {
    expect(classifyCard({ ...base, request: { ...base.request!, text } }).lane).toBe('him')
  })
  it('refuses an unspecified extra field that could change the outgoing operation', () => {
    expect(classifyCard({ ...base, origin: { tool: 'request_approval', input: { summary: 'Send email', recipient: 'ben@example.org', details: 'The meeting is at ten.', additional_payload: 'surprise' } } }).lane).toBe('him')
  })
  it('keeps monetary or secret actions with the person even when send and exact content match', () => {
    const value = { ...base, summary: 'Send money', request: { ...base.request!, text: 'Send "pay 100 dollars" to ben@example.org' }, origin: { tool: 'request_approval', input: { summary: 'Send money', recipient: 'ben@example.org', details: 'pay 100 dollars' } } }
    expect(classifyCard(value).lane).toBe('him')
  })
  it('refuses an additional recipient or attachment', () => {
    expect(classifyCard({ ...base, origin: { tool: 'request_approval', input: { summary: 'Send email', recipient: 'ben@example.org', details: 'The meeting is at ten.', attachment: '/tmp/extra.pdf' } } }).lane).toBe('him')
  })
})
