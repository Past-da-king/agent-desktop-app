import { describe, expect, it, vi, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { ApprovalContext } from '../src/renderer/ui/ApprovalContext'
vi.mock('../src/renderer/state/useSettings', () => ({ useSettings: (select: (state: unknown) => unknown) => select({ settings: { agentName: 'Nova' } }) }))

describe('approval request context', () => {
  it('omits context for old cards', () => {
    expect(renderToStaticMarkup(createElement(ApprovalContext, { meta: {} }))).toBe('')
  })
  it('shows the local request time, escaped full text and configured agent recommendation', () => {
    const at = Date.UTC(2026, 10, 25, 11, 21)
    const text = 'Read <private> files ' + 'long '.repeat(200)
    const html = renderToStaticMarkup(createElement(ApprovalContext, { meta: {
      request: { id: 'request-1', at, text }, escalatedWhy: 'Approve the requested read.'
    } }))
    expect(html).toContain(new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',hour12:false}))
    expect(html).toContain('You asked for this at')
    expect(html).toContain('Nova')
    expect(html).toContain('recommends:')
    expect(html).toContain('&lt;private&gt;')
    expect(html).not.toContain('<private>')
    expect(html).toContain('long '.repeat(200))
  })
  it('does not render malformed request dates', () => {
    expect(renderToStaticMarkup(createElement(ApprovalContext, { meta: { request: {id:'bad', at:Infinity,text:'bad'} } }))).toBe('')
  })
})
