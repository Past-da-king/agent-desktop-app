/** The AI choosers draw two rows (agent, helpers) with the account and model each is on. */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, type Settings } from '@agent/core'

import { kindLine, pickLine, pickOfChat } from '../src/renderer/lib/ai'
import { AiPickRows } from '../src/renderer/ui/AiPickRows'

vi.mock('../src/renderer/bridge', () => ({
  agent: { settings: { accounts: { listModels: async () => ({ ok: true, models: [], message: '' }) } }, shell: { openExternal: async () => undefined } },
}))

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  accounts: [
    { id: 'claude', label: 'Claude plan', kind: 'claude', model: 'opus', hasKey: false },
    { id: 'go', label: 'OpenCode Go', kind: 'api', provider: 'opencode_go', model: 'deepseek-v4.1-flash', hasKey: true },
  ],
  ai: { main: { account: 'claude', model: 'fable' }, helpers: { account: 'go', model: '' } },
}

describe('the AI chooser', () => {
  it('shows the agent and helpers rows, each on its account and model', () => {
    const html = renderToStaticMarkup(createElement(AiPickRows, { settings, picks: settings.ai, onChange: () => undefined }))
    expect(html).toContain('Agent')
    expect(html).toContain('Helpers')
    expect(html).toContain('<option value="claude" selected="">Claude plan</option>')
    expect(html).toContain('<option value="go" selected="">OpenCode Go</option>')
    expect(html).toContain('>fable<')
    expect(html).toContain('Default (deepseek-v4.1-flash)')
    expect(html).not.toContain('Same as the main thread')
  })

  it("a project's rows offer Same as the main thread and show what that is", () => {
    const html = renderToStaticMarkup(createElement(AiPickRows, { settings, picks: { main: { account: '', model: '' }, helpers: { account: '', model: '' } }, inherit: settings.ai, onChange: () => undefined }))
    expect(html.match(/Same as the main thread/g)?.length).toBe(2)
    expect(html).toContain('Claude plan · fable')
    expect(html).toContain('OpenCode Go · deepseek-v4.1-flash')
  })

  it('reads picks in plain words', () => {
    expect(pickLine(settings, settings.ai.main)).toBe('Claude plan · fable')
    expect(pickLine(settings, { account: 'go', model: '' })).toBe('OpenCode Go · deepseek-v4.1-flash')
    expect(pickLine(settings, { account: 'nope', model: '' })).toBe('Not set up')
    expect(kindLine(settings.accounts[1]!)).toBe('OpenCode Go key')
    expect(pickOfChat(settings, null, 'helpers')).toEqual({ account: 'go', model: '' })
  })
})
