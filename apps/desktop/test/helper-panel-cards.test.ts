/**
 * The side panel's helper cards (22 Oct 2026 bug: two helpers were working in project chats and neither showed).
 * Every working helper from any chat is listed, a project agent's row carries its project's icon and status line,
 * its project's helpers sit under it, and the list is never cut to a few rows.
 */
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import type { ChatItem, ProjectRow } from '@agent/core'

import { helperCards, helperLine, helperOwner, helperView } from '../src/renderer/lib/helpers'
import { HelperCardList } from '../src/renderer/shell/HelpersPanel'

vi.mock('../src/renderer/bridge', () => ({ agent: {}, chat: {} }))

function row(id: string, kind: string, createdAt: number, meta: Record<string, unknown> = {}, text = id): ChatItem {
  return { id, createdAt, kind, text, meta: JSON.stringify(meta) }
}

function helper(id: string, at: number, state: string, extra: Record<string, unknown> = {}): ChatItem {
  return row(id, 'helper', at, { id, label: `Job ${id}`, state, summary: '', queued: false, startedAt: at, ...extra })
}

function project(id: string, name: string, chats: string[], hidden = false): ProjectRow {
  return { id, createdAt: 1, updatedAt: 1, name, description: '', icon: { glyph: 'code', color: 'iris' }, path: '', profile: '', hidden, chats } as unknown as ProjectRow
}

const app = project('p-app', 'Agent Desktop App', ['pc-voice', 'pc-cards'])
const secret = project('p-secret', 'Earlier chats', ['pc-old'], true)

/** The live rows of 22 Oct 08:05: two project agents in the main chat, each with a helper in its project chat. */
function liveRows(): ChatItem[] {
  const projectMeta = { id: 'p-app', name: 'Agent Desktop App', glyph: 'code', color: 'iris' }
  return [
    helper('pa-pc-voice', 100, 'working', { label: 'Agent Desktop App', summary: 'Phone voice fixes: Now the voice bubble', project: projectMeta, projectChat: 'pc-voice' }),
    helper('h-voice', 110, 'working', { label: 'Phone voice fixes', chat: 'pc-voice' }),
    row('h-voice-a', 'activity', 111, { helper: 'h-voice', status: 'running', summary: 'Ran cd /tmp', chat: 'pc-voice' }),
    helper('pa-pc-cards', 200, 'working', { label: 'Agent Desktop App', summary: 'Helper cards missing: Ran mkdir', project: projectMeta, projectChat: 'pc-cards' }),
    helper('h-cards', 210, 'working', { label: 'Helper cards missing', chat: 'pc-cards', summary: 'Reading the panel' }),
    helper('h-400', 211, 'working', { label: 'reasoning_content 400', chat: 'pc-cards' }),
    helper('h-main', 300, 'working', { label: 'Main thread job', summary: 'Searching memory' }),
    helper('h-hidden', 310, 'working', { label: 'Old chat job', chat: 'pc-old', summary: 'Tidying' }),
    helper('h-done', 50, 'done', { label: 'Finished job', chat: 'pc-voice' }),
  ]
}

describe('side panel helper cards', () => {
  it('lists every working helper from any chat, each project agent with its helpers under it', () => {
    const cards = helperCards(liveRows(), [app, secret])
    expect(cards.map((card) => [card.id, card.depth])).toEqual([
      ['pa-pc-voice', 0],
      ['h-voice', 1],
      ['pa-pc-cards', 0],
      ['h-cards', 1],
      ['h-400', 1],
      ['h-main', 0],
      ['h-hidden', 0],
    ])
    expect(cards.find((card) => card.id === 'pa-pc-voice')?.projectChat).toBe('pc-voice')
  })

  it('knows whose each helper is: the project (from the row or its chat), the agent, or plain for a hidden project', () => {
    const items = liveRows()
    const byId = (id: string): ChatItem => items.find((item) => item.id === id) as ChatItem
    expect(helperOwner(byId('pa-pc-voice'), [app])).toMatchObject({ kind: 'project', name: 'Agent Desktop App' })
    // A project agent row written before the window has the project list still shows the project from its row.
    expect(helperOwner(byId('pa-pc-voice'), [])).toMatchObject({ kind: 'project', name: 'Agent Desktop App', icon: { glyph: 'code' } })
    expect(helperOwner(byId('h-voice'), [app])).toMatchObject({ kind: 'project', id: 'p-app' })
    expect(helperOwner(byId('h-main'), [app])).toEqual({ kind: 'main' })
    expect(helperOwner(byId('h-hidden'), [app, secret])).toEqual({ kind: 'plain' })
  })

  it('reads one line: the running step, else the status line, never a stuck Starting', () => {
    const items = liveRows()
    const view = (id: string): ReturnType<typeof helperView> => helperView(items.find((item) => item.id === id) as ChatItem, items)
    expect(helperLine(view('h-voice'))).toBe('Ran cd /tmp')
    expect(helperLine(view('pa-pc-cards'))).toBe('Helper cards missing: Ran mkdir')
    expect(helperLine(view('h-400'))).toBe('Starting')
  })

  it('draws a card for each with its project icon, label, line and state', () => {
    const cards = helperCards(liveRows(), [app, secret])
    const html = renderToStaticMarkup(createElement(HelperCardList, { cards, mascot: 'scout', onOpen: () => undefined }))
    expect(html).toContain('7 working')
    for (const label of ['Phone voice fixes', 'Helper cards missing', 'reasoning_content 400', 'Main thread job', 'Old chat job']) expect(html).toContain(label)
    expect(html).toContain('Phone voice fixes: Now the voice bubble')
    expect(html).toContain('Open the Agent Desktop App chat')
    expect(html.match(/hp-sub/g)).toHaveLength(3)
    expect(html.match(/pj-tile/g)?.length).toBe(5) // two project agents and three project helpers; main and hidden are not tiles
    expect(html.match(/>Working</g)).toHaveLength(7)
  })

  it('a project chat whose agent row closed while its helpers still work stays a working card with them under it', () => {
    const rows = liveRows().map((item) => (item.id === 'pa-pc-cards' ? { ...item, meta: JSON.stringify({ ...JSON.parse(item.meta), state: 'failed' }) } : item))
    const cards = helperCards(rows, [app, secret])
    expect(cards.filter((card) => card.id === 'h-cards' || card.id === 'h-400').map((card) => card.depth)).toEqual([1, 1])
    expect(cards.find((card) => card.id === 'pa-pc-cards')).toMatchObject({ kind: 'project-chat', state: 'working', waiting: false })
  })

  it('never cuts the list to a few rows (the 196 px cap hid every helper after the third)', () => {
    const css = readFileSync(new URL('../src/renderer/styles/plan.css', import.meta.url), 'utf8')
    const rule = /\.hp-list\{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(rule).not.toBe('')
    expect(rule).not.toMatch(/max-height/)
  })
})
