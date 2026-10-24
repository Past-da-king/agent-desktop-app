/** Settings > Instructions draws his rules with edit and delete, and says so when there are none (views/PromptRules.tsx). */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/renderer/bridge', () => ({ agent: { data: { upsert: async () => ({}) } } }))
vi.mock('../src/renderer/state/useData', () => ({ useEntity: () => [] }))

import { PromptRulesList } from '../src/renderer/views/PromptRules'
import { newRule, removedRule } from '../src/shared/prompt-rules'

const noop = (): void => undefined

describe('Settings > Instructions', () => {
  it('shows each rule in force with edit and delete, and leaves removed ones out', () => {
    const kept = { id: 'r1', createdAt: 1, ...newRule('Close your browser tabs when you are done.', 'RAM', 'agent', 1) }
    const gone = { id: 'r2', createdAt: 2, ...newRule('Old rule', '', 'you', 2) }
    const removed = { ...gone, ...removedRule(gone, 'no', 'you', 3)! }
    const html = renderToStaticMarkup(createElement(PromptRulesList, { rows: [kept, removed], onAdd: noop, onEdit: noop, onRemove: noop }))
    expect(html).toContain('INSTRUCTIONS')
    expect(html).toContain('Close your browser tabs when you are done.')
    expect(html).not.toContain('Old rule')
    expect(html).toContain('aria-label="Edit rule"')
    expect(html).toContain('aria-label="Delete rule"')
    expect(html).toContain('by agent')
  })

  it('says there are none yet, and offers a new rule', () => {
    const html = renderToStaticMarkup(createElement(PromptRulesList, { rows: [], onAdd: noop, onEdit: noop, onRemove: noop }))
    expect(html).toContain('No rules yet.')
    expect(html).toContain('Add rule')
  })
})
