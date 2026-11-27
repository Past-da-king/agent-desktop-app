/**
 * Past chats as tools. New Chat never deletes anything: it only takes the old chat out of the model's context. These
 * let the agent find an earlier chat ("like last time", "what did we decide about X") and read it.
 */
import { int, schema, str, type PastChatHit, type Tool } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { chatSegments, clip, segmentSummary, segmentTitle, speaker, spokenRows } from '../memory/chats'

export interface ChatToolDeps {
  store: DataStore
  search(query: string, limit: number): Promise<PastChatHit[]>
}

const READ_DEFAULT = 40
const READ_MAX = 120
const READ_BUDGET = 40_000

export function chatTools(deps: ChatToolDeps): Tool[] {
  return [chatsSearch(deps), chatRead(deps)]
}

function chatsSearch(deps: ChatToolDeps): Tool {
  return {
    spec: {
      name: 'chats_search',
      description:
        'Search your earlier chats with the user (every message and each chat\'s summary, ranked). Use it when the user refers to something from before ("like last time", "what we decided", a name you do not recognise) and memory_search did not settle it. Returns chat ids for chat_read.',
      schema: schema(['query'], {
        query: str('What to look for, in plain words (names, topics, phrases)'),
        limit: int('Max chats, default 5'),
      }),
    },
    run: async (input) => {
      const query = typeof input['query'] === 'string' ? input['query'].trim() : ''
      if (query === '') return 'Pass what to look for.'
      const raw = typeof input['limit'] === 'number' ? Math.trunc(input['limit']) : 5
      const hits = await deps.search(query, Math.min(15, Math.max(1, raw)))
      if (hits.length === 0) return `No earlier chat mentions "${clip(query, 80)}".`
      return hits
        .map((hit) => {
          const lines = [`chat ${hit.chatId}: ${hit.title} (${dateLine(hit.at)})`]
          if (hit.summary !== '') lines.push(`  summary: ${clip(hit.summary, 400)}`)
          for (const snippet of hit.snippets) lines.push(`  > ${clip(snippet, 240)}`)
          return lines.join('\n')
        })
        .join('\n')
    },
  }
}

function chatRead(deps: ChatToolDeps): Tool {
  return {
    spec: {
      name: 'chat_read',
      description:
        'Read an earlier chat by its id (from chats_search): its summary and its messages, numbered. Pass from and to for a range of message numbers in a long chat.',
      schema: schema(['chat_id'], {
        chat_id: str('The chat id from chats_search'),
        from: int('First message number, default 1'),
        to: int(`Last message number, default from + ${READ_DEFAULT - 1}`),
      }),
    },
    run: async (input) => {
      const id = typeof input['chat_id'] === 'string' ? input['chat_id'].trim() : ''
      if (id === '') return 'Pass the chat id from chats_search.'
      const segment = chatSegments(await deps.store.list('chat_item')).find((item) => item.id === id)
      if (segment === undefined) return `No chat with id ${id}.`
      const rows = spokenRows(segment)
      const from = Math.max(1, typeof input['from'] === 'number' ? Math.trunc(input['from']) : 1)
      const wantedTo = typeof input['to'] === 'number' ? Math.trunc(input['to']) : from + READ_DEFAULT - 1
      const to = Math.min(rows.length, Math.max(from, Math.min(wantedTo, from + READ_MAX - 1)))
      const head = [`chat ${segment.id}: ${segmentTitle(segment)} (${dateLine(rows[0]?.createdAt ?? segment.startedAt)}), ${rows.length} messages`]
      const summary = segmentSummary(segment)
      if (summary !== '') head.push(`summary: ${summary}`)
      if (rows.length === 0) return `${head.join('\n')}\n(no messages)`
      if (from > rows.length) return `${head.join('\n')}\nIt has only ${rows.length} messages.`
      const out: string[] = []
      let used = 0
      let last = from - 1
      for (let index = from; index <= to; index += 1) {
        const row = rows[index - 1]
        if (row === undefined) break
        const line = `[${index}] ${speaker(row)} (${timeLine(row.createdAt)}): ${clip(row.text.trim(), 4_000)}`
        if (used + line.length > READ_BUDGET && out.length > 0) break
        out.push(line)
        used += line.length
        last = index
      }
      const more = last < rows.length ? `\n(messages ${last + 1} to ${rows.length} not shown: pass from ${last + 1})` : ''
      return `${head.join('\n')}\n\n${out.join('\n\n')}${more}`
    },
  }
}

function dateLine(ms: number): string {
  if (ms <= 0) return 'unknown date'
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

function timeLine(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
