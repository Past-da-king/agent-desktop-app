import type { ChatItem, ChatRunInfo } from '@agent/core'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { chatList, chatOf, chatStatus, chatTitleOf, isSideRun, itemsOfChat, routeLine } from '../src/renderer/lib/chats'
import { Markdown } from '../src/renderer/ui/Markdown'

function row(id: string, kind: string, createdAt: number, meta: Record<string, unknown> = {}, text = id): ChatItem {
  return { id, createdAt, kind, text, meta: JSON.stringify(meta) }
}

const B = 'cbranchchat0001'
const O = 'cotherchat00001'

const items: ChatItem[] = [
  row('m1', 'user', 100, {}, 'Plan the Durban trip'),
  row('m2', 'agent', 200, {}, 'Here is a plan'),
  row('o1', 'user', 150, { chat: O }, 'Gift ideas for Nomsa'),
  row('o2', 'agent', 900, { chat: O }, 'Three ideas'),
  row('b1', 'user', 100, { chat: B, copiedFrom: 'm1' }, 'Plan the Durban trip'),
  row('b2', 'notice', 1000, { chat: B, branch: true, title: 'Branch: Plan the Durban trip' }, 'Branched from ...'),
  row('h1', 'activity', 1200, { chat: 'conlyasteprow01', helper: 'x' }, 'a lone helper step'),
  row('p1', 'branch', 50, { title: 'phone branch marker' }),
]

describe('several chats in the rail', () => {
  it('lists every chat newest first, with branch titles, and leaves rows that are not a chat out', () => {
    const list = chatList(items)
    expect(list.map((entry) => entry.id)).toEqual([B, O, 'main'])
    expect(list[0]).toMatchObject({ title: 'Branch: Plan the Durban trip', branch: true })
    expect(list[1]).toMatchObject({ title: 'Gift ideas for Nomsa', lastReplyAt: 900 })
  })

  it('always lists the chat on screen, even before its first message', () => {
    expect(chatList(items, 'cbrandnewchat01')[0]).toMatchObject({ id: 'cbrandnewchat01', title: 'New chat' })
  })

  it('says waiting before working before unread, and nothing for the open chat', () => {
    const entry = chatList(items).find((chat) => chat.id === O)!
    const run = (patch: Partial<ChatRunInfo>): ChatRunInfo => ({ chat: O, running: false, waiting: [], alongside: 0, ...patch })
    expect(chatStatus(entry, run({ running: true, waiting: ['q'] }), 0, false)).toBe('waiting')
    expect(chatStatus(entry, run({ running: true }), 0, false, 1)).toBe('waiting')
    expect(chatStatus(entry, run({ running: true }), 0, false)).toBe('working')
    expect(chatStatus(entry, run({ alongside: 1 }), 0, false)).toBe('working')
    expect(chatStatus(entry, undefined, 500, false)).toBe('unread')
    expect(chatStatus(entry, undefined, 950, false)).toBe('idle')
    expect(chatStatus(entry, undefined, 500, true)).toBe('idle')
  })

  it('splits rows by chat and names a chat', () => {
    expect(itemsOfChat(items, O).map((item) => item.id)).toEqual(['o1', 'o2'])
    expect(chatOf(items[0]!)).toBe('main')
    expect(chatTitleOf(itemsOfChat(items, B))).toBe('Branch: Plan the Durban trip')
  })
})

describe('messages sent while busy', () => {
  it('says which way each one went', () => {
    expect(routeLine(row('u', 'user', 1, { route: 'join' }))).toBe('Added to the current task')
    expect(routeLine(row('u', 'user', 1, { route: 'alongside' }))).toBe('Started alongside as its own job')
    expect(routeLine(row('u', 'user', 1, { route: 'alongside', routeWhy: 'slow' }))).toMatch(/taking a while/)
    expect(routeLine(row('u', 'user', 1, { route: 'pending' }))).toBe('Reading this next to the current task')
    expect(routeLine(row('u', 'user', 1))).toBe('')
    expect(isSideRun(row('h', 'helper', 1, { side: true }))).toBe(true)
    expect(isSideRun(row('h', 'helper', 1, {}))).toBe(false)
  })
})

describe('code in replies', () => {
  it('draws fenced code as a block with a copy button and keeps it exact', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: 'Run this:\n\n```bash\nnpm run build\n  echo "done"\n```\n\nThen tell me.' }))
    expect(html).toContain('class="md-code"')
    expect(html).toContain('<span>bash</span>')
    expect(html).toContain('Copy code')
    expect(html).toContain('npm run build\n  echo &quot;done&quot;')
    expect(html).toContain('Then tell me.')
  })
})
