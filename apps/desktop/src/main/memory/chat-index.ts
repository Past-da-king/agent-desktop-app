/**
 * Full text search over past chats: every message and every chat summary, ranked with SQLite FTS5 (bm25).
 * node:sqlite in Electron 44 (Node 24.22) ships FTS5 with the porter tokenizer, so "running" finds "run".
 * If FTS5 is ever missing the same tables are searched by term overlap instead.
 *
 * The index is derived data in its own file (chat-search.db): the chat rows in agent.db stay the truth, and
 * `refresh` brings the index up to date with them (new, changed and removed rows) before each search.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'

import type { ChatItem, PastChatHit } from '@agent/core'

import { chatSegments, clip, segmentSummary, segmentTitle, speaker, spokenRows } from './chats'

export interface ChatSearchOptions {
  limit?: number
  /** A chat to leave out (the one in progress: it is already in context). */
  exclude?: string
}

interface MsgWanted {
  chat: string
  at: number
  who: string
  text: string
  hash: string
}

interface ChatWanted {
  title: string
  summary: string
  startedAt: number
  endedAt: number
  hash: string
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'it', 'my', 'me', 'i', 'you', 'what', 'do', 'with', 'at', 'be', 'this', 'that', 'can', 'please', 'we', 'our', 'about', 'did', 'was'])

/** Lowercase search words, without the ones that match everything. */
export function searchTerms(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 1 && !STOP.has(word))
  return [...new Set(words)].slice(0, 12)
}

export class ChatIndex {
  readonly fts: boolean
  private readonly db: DatabaseSync

  /** `useFts: false` forces the plain fallback (tests prove it works on a build without FTS5). */
  constructor(file: string, options: { useFts?: boolean } = {}) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS msg(rid INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL,
        at INTEGER NOT NULL, who TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS msg_chat ON msg(chat_id, at);
      CREATE TABLE IF NOT EXISTS chat(rid INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, hash TEXT NOT NULL);
    `)
    let fts = options.useFts !== false
    if (fts) try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(text, tokenize = 'porter unicode61');
        CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(title, summary, tokenize = 'porter unicode61');
      `)
    } catch {
      fts = false
    }
    this.fts = fts
  }

  /** Brings the index in line with the chat rows. Cheap when nothing changed. */
  refresh(all: ChatItem[]): void {
    const msgs = new Map<string, MsgWanted>()
    const chats = new Map<string, ChatWanted>()
    for (const segment of chatSegments(all)) {
      const spoken = spokenRows(segment)
      for (const item of spoken) {
        const text = item.text.trim()
        msgs.set(item.id, { chat: segment.id, at: item.createdAt, who: speaker(item), text, hash: hashOf(`${segment.id}\n${text}`) })
      }
      if (spoken.length === 0) continue
      const title = segmentTitle(segment)
      const summary = segmentSummary(segment)
      chats.set(segment.id, {
        title,
        summary,
        startedAt: spoken[0]?.createdAt ?? segment.startedAt,
        endedAt: segment.endedAt,
        hash: hashOf(`${title}\n${summary}\n${segment.endedAt}`),
      })
    }

    this.db.exec('BEGIN')
    try {
      const haveMsgs = this.db.prepare('SELECT rid, item_id, hash FROM msg').all()
      const dropMsg = this.db.prepare('DELETE FROM msg WHERE rid = ?')
      const dropMsgFts = this.fts ? this.db.prepare('DELETE FROM msg_fts WHERE rowid = ?') : null
      const known = new Set<string>()
      for (const row of haveMsgs) {
        const id = str(row['item_id'])
        const wanted = msgs.get(id)
        if (wanted !== undefined && wanted.hash === str(row['hash'])) {
          known.add(id)
          continue
        }
        dropMsg.run(num(row['rid']))
        dropMsgFts?.run(num(row['rid']))
      }
      const addMsg = this.db.prepare('INSERT INTO msg(item_id, chat_id, at, who, text, hash) VALUES(?, ?, ?, ?, ?, ?)')
      const addMsgFts = this.fts ? this.db.prepare('INSERT INTO msg_fts(rowid, text) VALUES(?, ?)') : null
      for (const [id, wanted] of msgs) {
        if (known.has(id)) continue
        const result = addMsg.run(id, wanted.chat, wanted.at, wanted.who, wanted.text, wanted.hash)
        addMsgFts?.run(Number(result.lastInsertRowid), wanted.text)
      }

      const haveChats = this.db.prepare('SELECT rid, chat_id, hash FROM chat').all()
      const dropChat = this.db.prepare('DELETE FROM chat WHERE rid = ?')
      const dropChatFts = this.fts ? this.db.prepare('DELETE FROM chat_fts WHERE rowid = ?') : null
      const knownChats = new Set<string>()
      for (const row of haveChats) {
        const id = str(row['chat_id'])
        const wanted = chats.get(id)
        if (wanted !== undefined && wanted.hash === str(row['hash'])) {
          knownChats.add(id)
          continue
        }
        dropChat.run(num(row['rid']))
        dropChatFts?.run(num(row['rid']))
      }
      const addChat = this.db.prepare('INSERT INTO chat(chat_id, title, summary, started_at, ended_at, hash) VALUES(?, ?, ?, ?, ?, ?)')
      const addChatFts = this.fts ? this.db.prepare('INSERT INTO chat_fts(rowid, title, summary) VALUES(?, ?, ?)') : null
      for (const [id, wanted] of chats) {
        if (knownChats.has(id)) continue
        const result = addChat.run(id, wanted.title, wanted.summary, wanted.startedAt, wanted.endedAt, wanted.hash)
        addChatFts?.run(Number(result.lastInsertRowid), wanted.title, wanted.summary)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Past chats that match, best first, with up to three snippets each. */
  search(query: string, options: ChatSearchOptions = {}): PastChatHit[] {
    const limit = Math.max(1, Math.min(25, options.limit ?? 5))
    const terms = searchTerms(query)
    if (terms.length === 0) return []
    const scores = new Map<string, { score: number; snippets: string[]; terms: Set<string> }>()
    const bump = (chat: string, score: number, snippet: string | null): void => {
      if (chat === options.exclude) return
      const entry = scores.get(chat) ?? { score: 0, snippets: [], terms: new Set<string>() }
      entry.score += score
      if (snippet !== null && entry.snippets.length < 3 && !entry.snippets.includes(snippet)) entry.snippets.push(snippet)
      scores.set(chat, entry)
    }

    if (this.fts) {
      const match = terms.map((term) => `"${term}"*`).join(' OR ')
      const msgRows = this.db
        .prepare(
          `SELECT m.chat_id AS chat, m.who AS who, snippet(msg_fts, 0, '[', ']', '...', 14) AS snip, bm25(msg_fts) AS rank
           FROM msg_fts JOIN msg m ON m.rid = msg_fts.rowid WHERE msg_fts MATCH ? ORDER BY rank LIMIT 400`,
        )
        .all(match)
      const perChat = new Map<string, number>()
      for (const row of msgRows) {
        const chat = str(row['chat'])
        const seen = perChat.get(chat) ?? 0
        perChat.set(chat, seen + 1)
        // The best five messages of a chat count; a long chat does not win on volume alone.
        if (seen >= 5) continue
        bump(chat, -num(row['rank']), `${str(row['who'])}: ${str(row['snip'])}`)
      }
      const chatRows = this.db
        .prepare(
          `SELECT c.chat_id AS chat, bm25(chat_fts, 3.0, 2.0) AS rank FROM chat_fts JOIN chat c ON c.rid = chat_fts.rowid
           WHERE chat_fts MATCH ? ORDER BY rank LIMIT 100`,
        )
        .all(match)
      for (const row of chatRows) bump(str(row['chat']), -num(row['rank']) * 2, null)
    } else {
      for (const row of this.db.prepare('SELECT chat_id, who, text FROM msg').all()) {
        const text = str(row['text']).toLowerCase()
        const found = terms.filter((term) => text.includes(term))
        if (found.length === 0) continue
        bump(str(row['chat_id']), found.length, `${str(row['who'])}: ${clip(str(row['text']).replace(/\s+/g, ' '), 160)}`)
      }
      for (const row of this.db.prepare('SELECT chat_id, title, summary FROM chat').all()) {
        const text = `${str(row['title'])} ${str(row['summary'])}`.toLowerCase()
        const found = terms.filter((term) => text.includes(term))
        if (found.length > 0) bump(str(row['chat_id']), found.length * 2, null)
      }
    }

    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, limit)
    const info = this.db.prepare('SELECT title, summary, started_at FROM chat WHERE chat_id = ?')
    return ranked.map(([chatId, entry]) => {
      const row = info.get(chatId)
      return {
        chatId,
        title: row === undefined ? 'Chat' : str(row['title']),
        at: row === undefined ? 0 : num(row['started_at']),
        summary: row === undefined ? '' : str(row['summary']),
        snippets: entry.snippets.map((snippet) => snippet.replace(/\s+/g, ' ').trim()),
      }
    })
  }

  close(): void {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}

function hashOf(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function str(value: SQLOutputValue | undefined): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

function num(value: SQLOutputValue | undefined): number {
  return typeof value === 'number' ? value : typeof value === 'bigint' ? Number(value) : 0
}
