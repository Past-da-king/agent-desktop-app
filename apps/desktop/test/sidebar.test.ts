/**
 * The side panel holds what matters: everything waiting on the person (from any chat), then helpers, then the
 * browser, which folds to one line when nothing is open or when the person folds it, and keeps running.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { ChatItem } from '@agent/core'

vi.mock('../src/renderer/bridge', () => ({
  agent: {},
  chat: { decide: async () => undefined, answer: async () => undefined },
}))

import { browserTucked, openedMode } from '../src/renderer/lib/panel'
import { sourceOfChat } from '../src/renderer/lib/source'
import { WaitingCard } from '../src/renderer/shell/NeedsYou'

function row(kind: 'approval' | 'question', text: string, meta: Record<string, unknown>): ChatItem {
  return { id: `${kind}-1`, kind, text, meta: JSON.stringify(meta), createdAt: 1, updatedAt: 1 } as ChatItem
}

describe('the browser card', () => {
  it('folds to one line when nothing is open, opens by itself for a page, and stays folded when the person folds it', () => {
    expect(browserTucked('auto', false)).toBe(true)
    expect(browserTucked('auto', true)).toBe(false)
    // Folded by the person: an agent opening a page does not force it open.
    expect(browserTucked('min', true)).toBe(true)
    expect(browserTucked('min', false)).toBe(true)
    // Opened on purpose with nothing in it: the empty card shows.
    expect(browserTucked('open', false)).toBe(false)
    expect(openedMode(true)).toBe('auto')
    expect(openedMode(false)).toBe('open')
  })
})

describe('what is waiting on the person', () => {
  const main = sourceOfChat('main', [], [], 'Nova')

  it('says where it came from and offers Approve and Decline on an approval', () => {
    const html = renderToStaticMarkup(createElement(WaitingCard, { item: row('approval', 'Send the invoice', { summary: 'Email the March invoice to Acme' }), source: main, onOpen: () => undefined }))
    expect(html).toContain('Nova')
    expect(html).toContain('Email the March invoice to Acme')
    expect(html).toContain('>Approve</button>')
    expect(html).toContain('>Decline</button>')
  })

  it('offers the answers of a question, always with a No, and the handoff answers for a browser turn', () => {
    const question = renderToStaticMarkup(createElement(WaitingCard, { item: row('question', 'Window seat?', { options: ['Yes, a window', 'Aisle'] }), source: main, onOpen: () => undefined }))
    expect(question).toContain('>Yes, a window</button>')
    expect(question).toContain('>Aisle</button>')
    expect(question).toContain('>No</button>')
    const handoff = renderToStaticMarkup(createElement(WaitingCard, { item: row('question', 'Sign in to Google', { options: ['Done, carry on', 'Skip'] }), source: main, onOpen: () => undefined }))
    expect(handoff).toContain('>Done, carry on</button>')
    expect(handoff).toContain('Your turn')
  })

  it('shows a project tile and name when the chat belongs to a project', () => {
    const html = renderToStaticMarkup(
      createElement(WaitingCard, {
        item: row('approval', 'Deploy', { summary: 'Deploy the site' }),
        source: { kind: 'project', name: 'Acme website', icon: { glyph: 'globe', color: 'ocean' }, projectId: 'p1' },
        onOpen: () => undefined,
      }),
    )
    expect(html).toContain('Acme website')
    expect(html).toContain('pj-tile')
  })
})
