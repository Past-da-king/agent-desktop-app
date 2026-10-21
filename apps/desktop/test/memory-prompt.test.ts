import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type MemoryRow } from '@agent/core'

import { buildSystemPrompt } from '../src/main/runtime/prompt'
import { namedPages, recallFor } from '../src/main/runtime/recall'

const now = Date.now()
function page(id: string, title: string, kind: MemoryRow['kind'], body = 'Something worth knowing.'): MemoryRow {
  return { id, title, body, kind, topics: '', pinned: false, source: 'agent', createdAt: now, updatedAt: now }
}

const memories: MemoryRow[] = [
  page('p1', 'Alex Meyer', 'person', 'CEO. Final sign-off.'),
  page('p2', 'Will Smith', 'person', 'An actor.'),
  page('o1', 'GrowOS / GrowFactory', 'organisation', 'The group Ayanda works in.'),
  page('j1', 'Fretak (was Ember): swipe-card thought exchange', 'project', 'A side project.'),
  page('f1', 'Coffee order', 'preference', 'Flat white, no sugar.'),
  ...Array.from({ length: 30 }, (_, i) => page(`x${i}`, `Note ${i} about growth`, 'fact', 'growth growth growth')),
]

describe('assume you know', () => {
  it('tells the main agent to look things up before asking, and not a helper', () => {
    const base = { settings: DEFAULT_SETTINGS, now: new Date(), platform: 'win32', memories: [], goals: [], tasks: [], latestUserText: 'hi', timeZone: 'UTC' }
    const main = buildSystemPrompt(base)
    expect(main).toContain('ASSUME YOU KNOW')
    expect(main).toContain('chats_search')
    expect(main).toContain('Ask only when both searches come back empty')
    expect(buildSystemPrompt({ ...base, role: 'helper' })).not.toContain('ASSUME YOU KNOW')
  })

  it('pulls in the people, organisations and projects a message names', () => {
    const text = 'Can you send Ben the GrowOS numbers, and how is Fretak going? I will be there.'
    expect(namedPages(text, memories).map((row) => row.id)).toEqual(['p1', 'o1', 'j1'])
    // "will" in lower case is not Will Smith.
    expect(namedPages(text, memories).some((row) => row.id === 'p2')).toBe(false)
    const recalled = recallFor(text, memories, 8).map((row) => row.id)
    expect(recalled.slice(0, 3)).toEqual(['p1', 'o1', 'j1'])

    const prompt = buildSystemPrompt({ settings: DEFAULT_SETTINGS, now: new Date(), platform: 'win32', memories, goals: [], tasks: [], latestUserText: text, timeZone: 'UTC' })
    expect(prompt).toContain('Alex Meyer: CEO. Final sign-off.')
    expect(prompt).toContain('GrowOS / GrowFactory')
  })

  it('cuts a long recalled page and says how to read the rest', () => {
    const long = page('l1', 'Lisbon trip', 'project', `${'Plan detail. '.repeat(200)}END`)
    const prompt = buildSystemPrompt({ settings: DEFAULT_SETTINGS, now: new Date(), platform: 'win32', memories: [long], goals: [], tasks: [], latestUserText: 'the Lisbon trip', timeZone: 'UTC' })
    expect(prompt).toContain('(memory_get #l1 for the rest)')
    expect(prompt).not.toContain('END')
  })
})
