/**
 * New chat with several chats at once: the new chat opens with the divider that files the chat it left, and the chat
 * it left keeps its own context (its turns are not cut) and keeps running. Dividers are per chat.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { chatSegments, latestDividerAt, memoryNote, segmentSummary } from '../src/main/memory/chats'
import { MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'

const OLD = 'coldchat000001'
const NEW = 'cnewchat000001'

let store: Store
let index: ChatIndex
let clock = 1_760_000_000_000

beforeEach(() => {
  clock = 1_760_000_000_000
  store = new Store(':memory:', () => (clock += 10))
  index = new ChatIndex(':memory:')
})

afterEach(() => {
  index.close()
  store.close()
})

async function say(kind: 'user' | 'agent', text: string, chat?: string): Promise<void> {
  await store.upsert('chat_item', { kind, text, meta: JSON.stringify(chat === undefined ? {} : { chat }) })
}

function service(complete: (system: string, prompt: string) => Promise<string>, forget: () => void = () => undefined): MemoryService {
  return new MemoryService({ store, index, upkeep: new UpkeepFile(null), complete, forgetSession: forget, now: () => clock })
}

const REPLY =
  'Done:\n```json\n' +
  JSON.stringify({ title: 'Acme invoices', summary: 'Planned the Acme invoice run with Lerato.', memories: [] }) +
  '\n```'

describe('New chat with several chats at once', () => {
  it('splits stretches by chat, so two chats running side by side never mix', async () => {
    await say('user', 'first chat question')
    await say('user', 'other chat question', OLD)
    await say('agent', 'first chat answer')
    await say('agent', 'other chat answer', OLD)
    const segments = chatSegments(await store.list('chat_item'))
    expect(segments.map((segment) => [segment.chat, segment.items.map((item) => item.text)])).toEqual([
      ['main', ['first chat question', 'first chat answer']],
      [OLD, ['other chat question', 'other chat answer']],
    ])
  })

  it('opens the new chat with the filing divider and leaves the old chat and its context alone', async () => {
    await say('user', 'Can you help me plan the invoices with Lerato Dlamini at Acme this month please?', OLD)
    await say('agent', 'Yes. Lerato sends them on the 25th as PDF, copied to you.', OLD)
    let forgot = 0
    let prompt = ''
    const memory = service(async (_system, text) => {
      prompt = text
      return REPLY
    }, () => {
      forgot += 1
    })

    const result = await memory.newChat({ chat: NEW, from: OLD })
    expect(result.saving).toBe(true)
    await memory.idle()

    const rows = await store.list('chat_item')
    const divider = rows.find((row) => row.id === result.dividerId)
    expect(JSON.parse(divider?.meta ?? '{}')['chat']).toBe(NEW)
    expect(memoryNote(divider!)?.status).toBe('done')
    expect(prompt).toContain('Lerato')
    // The old chat has no divider: its own context is not cut, and the plan session it runs in is not forgotten.
    expect(latestDividerAt(rows.filter((row) => JSON.parse(row.meta)['chat'] === OLD))).toBe(0)
    expect(forgot).toBe(0)
    // Its stretch is closed for search and summaries by the divider that filed it.
    const old = chatSegments(rows).find((segment) => segment.chat === OLD)
    expect(old?.endDivider?.id).toBe(result.dividerId)
    expect(segmentSummary(old!)).toBe('Planned the Acme invoice run with Lerato.')

    // Pressing New chat again for the same new chat does nothing new; the old stretch is never filed twice.
    expect((await memory.newChat({ chat: NEW, from: OLD })).dividerId).toBe(result.dividerId)
    const again = await memory.newChat({ chat: 'canotherchat01', from: OLD })
    expect(again.saving).toBe(false)
  })

  it('a chat with nothing worth keeping opens a new one without filing', async () => {
    await say('user', 'hi', OLD)
    const memory = service(async () => REPLY)
    const result = await memory.newChat({ chat: NEW, from: OLD })
    expect(result.saving).toBe(false)
    expect(result.dividerId).not.toBeNull()
  })
})
