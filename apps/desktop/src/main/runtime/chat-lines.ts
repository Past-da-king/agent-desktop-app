/**
 * Several chats at once: which chat a row belongs to, where each chat keeps its model transcript, and branching
 * a chat from one of its messages into a new chat.
 *
 * Every chat row carries `meta.chat`; a row without one belongs to MAIN_CHAT, so every row written before chats
 * existed stays in the first chat. The model transcript of MAIN_CHAT is the turn thread "main" (as before); any
 * other chat's is "chat:<id>". On a plan (Claude or Codex) the same name keys the SDK session.
 */
import { randomUUID } from 'node:crypto'

import { MAIN_CHAT, type ChatItem } from '@agent/core'

import type { DataStore } from './data'

export function parseMeta(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The chat a row belongs to. */
export function chatOf(item: Pick<ChatItem, 'meta'>): string {
  const value = parseMeta(item.meta)['chat']
  return typeof value === 'string' && value !== '' ? value : MAIN_CHAT
}

/** What a row's meta carries for its chat: nothing for the first chat, so its rows look as they always did. */
export function chatTag(chat: string): { chat?: string } {
  return chat === MAIN_CHAT ? {} : { chat }
}

/** The turn thread (and plan session key) of a chat. */
export function threadFor(chat: string): string {
  return chat === MAIN_CHAT ? 'main' : `chat:${chat}`
}

/** A fresh chat id. */
export function newChatId(): string {
  return `c${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** A fresh project chat id: "pc", so chats from the days before projects ("c") can be told apart. */
export function newProjectChatId(): string {
  return `pc${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** Chat ids must be plain: they become folder names for plan sessions. */
export function isChatId(value: string): boolean {
  return value === MAIN_CHAT || /^p?c[a-z0-9]{6,40}$/i.test(value)
}

function short(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 3)}...`
}

/** A chat's name: a title a branch was given, else its first message. */
export function chatTitle(rows: ChatItem[]): string {
  for (const row of rows) {
    const meta = parseMeta(row.meta)
    const title = meta['title']
    if (row.kind === 'notice' && meta['branch'] === true && typeof title === 'string' && title !== '') return title
  }
  const first = rows.find((row) => row.kind === 'user' && row.text.trim() !== '')
  return first === undefined ? 'New chat' : short(first.text, 60)
}

/** Kinds that are part of a chat's history worth copying into a branch. */
const COPIED = new Set(['user', 'agent', 'report', 'notice', 'activity', 'question', 'approval', 'call', 'voice_note'])

function copyable(row: ChatItem): boolean {
  if (!COPIED.has(row.kind)) return false
  const meta = parseMeta(row.meta)
  // A helper's own steps live on its card, and its card is not copied; neither are its steps.
  if (typeof meta['helper'] === 'string' && meta['helper'] !== '') return false
  // A card still waiting belongs to the run in the old chat; the branch cannot answer it.
  if (row.kind === 'question' && !(typeof meta['answer'] === 'string' && meta['answer'] !== '')) return false
  if (row.kind === 'approval' && meta['decision'] !== 'approve' && meta['decision'] !== 'decline') return false
  if (row.kind === 'activity' && meta['status'] === 'running') return false
  return true
}

export interface BranchResult {
  chat: string
  title: string
  copiedRows: number
  copiedTurns: number
}

/**
 * A new chat with the history of `itemId`'s chat up to and including that message: the chat rows (copied, so
 * the old chat is untouched) and the model's own transcript to the same point. When there is no transcript to
 * copy (a plan session cannot be cut at a message), the first turn of the branch is handed the conversation as
 * text instead (`handoff` on its first row).
 */
export async function branchChat(store: DataStore, itemId: string, now: () => number = Date.now): Promise<BranchResult | null> {
  const point = await store.get('chat_item', itemId)
  if (point === null) return null
  const from = chatOf(point)
  // The store lists rows in the order they were written (time, then a clock that never ties), so the cut is
  // by position: two rows written in the same millisecond still fall on the right side of it.
  const all = (await store.list('chat_item')).filter((row) => chatOf(row) === from)
  const cut = all.findIndex((row) => row.id === point.id)
  const history = all.slice(0, cut + 1).filter((row) => row.id === point.id || copyable(row))
  const parentTitle = chatTitle(all)
  const chat = newChatId()

  for (const row of history) {
    const meta = parseMeta(row.meta)
    delete meta['divider']
    await store.upsert('chat_item', {
      kind: row.kind,
      text: row.text,
      createdAt: row.createdAt,
      meta: JSON.stringify({ ...meta, chat, copiedFrom: row.id }),
    })
  }

  const turns = transcriptUpTo(
    (await store.list('turn')).filter((turn) => turn.thread === threadFor(from) && turn.createdAt <= point.createdAt),
    point,
  )
  for (const turn of turns) {
    await store.upsert('turn', { thread: threadFor(chat), json: turn.json, createdAt: turn.createdAt })
  }

  const title = short(`Branch: ${parentTitle}`, 70)
  await store.upsert('chat_item', {
    kind: 'notice',
    text: `Branched from "${short(parentTitle, 60)}". Everything above is copied; the old chat is unchanged.`,
    createdAt: Math.max(now(), point.createdAt + 1),
    meta: JSON.stringify({
      chat,
      title,
      branchOf: from,
      branchItem: point.id,
      branch: true,
      handoff: turns.length === 0 && history.length > 0,
    }),
  })
  return { chat, title, copiedRows: history.length, copiedTurns: turns.length }
}

/** The text blocks of a stored model message, joined. */
function turnText(json: string): { role: string; text: string } {
  try {
    const parsed = JSON.parse(json) as { role?: unknown; blocks?: unknown }
    const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : []
    const text = blocks
      .map((block) => (block !== null && typeof block === 'object' && (block as { t?: unknown }).t === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
      .join('\n')
    return { role: String(parsed.role ?? ''), text }
  } catch {
    return { role: '', text: '' }
  }
}

/**
 * The model's transcript up to the message the branch is cut at. Turn rows are matched by what was said (a reply
 * by its words, a typed message by its text), because several rows can share a millisecond; when nothing
 * matches, everything up to that time is kept and the stored-history repair closes any open tool call.
 */
export function transcriptUpTo<T extends { json: string }>(turns: T[], point: Pick<ChatItem, 'kind' | 'text'>): T[] {
  const words = point.text.trim()
  if (words === '') return turns
  const role = point.kind === 'user' ? 'USER' : point.kind === 'agent' ? 'ASSISTANT' : ''
  if (role === '') return turns
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (turn === undefined) continue
    const said = turnText(turn.json)
    if (said.role === role && said.text.includes(words)) return turns.slice(0, i + 1)
  }
  return turns
}

/** The conversation as plain lines, for a branch whose first turn cannot carry the transcript itself. */
export function handoffText(rows: ChatItem[], limit = 12_000): string {
  const lines: string[] = []
  for (const row of rows) {
    if (row.kind === 'user' && row.text.trim() !== '') lines.push(`User: ${row.text.trim()}`)
    else if ((row.kind === 'agent' || row.kind === 'report') && row.text.trim() !== '') lines.push(`You: ${row.text.trim()}`)
  }
  let text = lines.join('\n\n')
  if (text.length > limit) text = `...${text.slice(text.length - limit)}`
  return text
}
