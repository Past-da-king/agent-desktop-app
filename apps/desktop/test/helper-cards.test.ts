import type { ChatItem } from '@agent/core'
import { describe, expect, it } from 'vitest'

import { mockAgent } from '../src/renderer/bridge/mock'
import { seedFor } from '../src/renderer/bridge/seed'
import {
  helperActivities,
  helperView,
  helperVisible,
  visibleHelpers,
  workingHelpers,
} from '../src/renderer/lib/helpers'
import { threadItems } from '../src/renderer/lib/thread'

function row(
  id: string,
  kind: string,
  createdAt: number,
  meta: Record<string, unknown> = {},
  text = id,
): ChatItem {
  return { id, createdAt, kind, text, meta: JSON.stringify(meta) }
}

function helper(
  id: string,
  createdAt: number,
  state: string,
  extra: Record<string, unknown> = {},
): ChatItem {
  return row(id, 'helper', createdAt, {
    id,
    label: `Job ${id}`,
    state,
    summary: 'Doing the job',
    queued: false,
    ...extra,
  })
}

describe('helper cards', () => {
  it('groups a working helper with its own steps and keeps those steps out of the thread', () => {
    const items = [
      row('u1', 'user', 10, {}, 'Please check the guesthouses'),
      helper('h1', 20, 'working', { summary: 'Checking The Palms' }),
      row('h1-a', 'activity', 25, {
        tool: 'web_fetch',
        status: 'done',
        summary: 'Opened Ocean Breeze',
        helper: 'h1',
      }),
      row('h1-b', 'activity', 30, {
        tool: 'web_fetch',
        status: 'running',
        summary: 'Checking The Palms',
        helper: 'h1',
      }),
      row('main-a', 'activity', 40, { tool: 'memory_search', status: 'done', summary: 'Searched memory' }),
    ]

    const thread = threadItems(items)
    expect(thread.map((item) => item.id)).toEqual(['u1', 'main-a']) // helpers live in the side panel, not the thread

    const view = helperView(items[1] as ChatItem, items)
    expect(view).toMatchObject({ id: 'h1', state: 'working', summary: 'Checking The Palms' })
    expect(view.activity.map((item) => item.id)).toEqual(['h1-a', 'h1-b'])
    expect(helperActivities(items, 'h1')).toHaveLength(2)
    expect(workingHelpers(items).map((item) => item.id)).toEqual(['h1'])
  })

  it('keeps a finished helper until the main reply carrying its result lands', () => {
    const helperRow = helper('h1', 20, 'done', { endedAt: 50, summary: 'Found three' })
    const before = [helperRow, row('a1', 'agent', 40, {}, 'A reply before the helper finished')]
    const after = [...before, row('a2', 'agent', 55, {}, 'Here is what the helper found')]

    expect(helperVisible(helperRow, before)).toBe(true)
    expect(helperVisible(helperRow, after)).toBe(false)
    expect(visibleHelpers(after)).toHaveLength(0)
    expect(workingHelpers(after)).toHaveLength(0)
  })

  it('keeps a stopped helper until its creator has replied, and counts a queued one as working', () => {
    const items = [
      helper('h1', 10, 'stopped', { endedAt: 20 }),
      helper('h2', 30, 'working', { queued: true, summary: 'Waiting its turn' }),
    ]

    // Its creator is told it stopped (0.2.76): the card shows how it ended until that agent has answered.
    expect(visibleHelpers(items).map((item) => item.id)).toEqual(['h1', 'h2'])
    const replied = [...items, { id: 'a1', kind: 'agent', text: 'It stopped; carrying on.', meta: '{}', createdAt: 40 } as ChatItem]
    expect(visibleHelpers(replied).map((item) => item.id)).toEqual(['h2'])
    expect(workingHelpers(items).map((item) => item.id)).toEqual(['h2'])
    expect(helperView(items[1] as ChatItem, items).queued).toBe(true)
  })

  it('gives the demo thread a live helper card and a finished one with steps', () => {
    const rows = seedFor('demo').rows.chat_item
    const helpers = rows.filter((item) => item.kind === 'helper')
    const working = helpers.filter((item) => (JSON.parse(item.meta) as { state?: string }).state === 'working')

    expect(working.length).toBeGreaterThan(0)
    expect(helpers.length).toBeGreaterThan(working.length)
    expect(threadItems(rows).some((item) => item.kind === 'helper')).toBe(false) // the side panel shows them
    expect(threadItems(rows).some((item) => item.kind === 'activity' && 'helper' in JSON.parse(item.meta))).toBe(false)
    expect(workingHelpers(rows).length).toBe(working.length)
  })
})

describe('mock helper controls', () => {
  it('stops one helper and then all the rest', async () => {
    const meta = JSON.stringify({ label: 'A job', state: 'working', summary: 'Working', queued: false })
    const first = await mockAgent.data.upsert('chat_item', { kind: 'helper', text: 'First job', meta })
    const second = await mockAgent.data.upsert('chat_item', { kind: 'helper', text: 'Second job', meta })

    expect(await mockAgent.helpers.stop(first.id)).toBe(true)
    let after = await mockAgent.data.list('chat_item')
    expect((JSON.parse(after.find((item) => item.id === first.id)?.meta ?? '{}') as { state?: string }).state).toBe('stopped')

    expect(await mockAgent.helpers.stopAll()).toBe(1)
    after = await mockAgent.data.list('chat_item')
    expect((JSON.parse(after.find((item) => item.id === second.id)?.meta ?? '{}') as { state?: string }).state).toBe('stopped')
    expect(await mockAgent.helpers.stop(first.id)).toBe(false)
  })
})
