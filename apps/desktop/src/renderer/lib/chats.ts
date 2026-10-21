import { MAIN_CHAT, type ChatItem, type ChatRunInfo } from '@agent/core'

import { short } from './format'
import { metaText, parseMeta } from './meta'

/** The chat a row belongs to: `meta.chat`, or the first chat for rows written before chats existed. */
export function chatOf(item: Pick<ChatItem, 'meta'>): string {
  const value = parseMeta(item.meta)['chat']
  return typeof value === 'string' && value !== '' ? value : MAIN_CHAT
}

/** Rows of one chat. */
export function itemsOfChat(items: ChatItem[], chat: string): ChatItem[] {
  return items.filter((item) => chatOf(item) === chat)
}

export interface ChatEntry {
  id: string
  title: string
  /** The newest thing that happened in it. */
  at: number
  /** The newest reply or finished separate job in it, for "done, not read yet". */
  lastReplyAt: number
  /** Made by branching another chat. */
  branch: boolean
  /** Where it came from (a voice note from the phone shows a phone). */
  device: 'desk' | 'phone'
}

/** Kinds that make a chat worth listing (a lone helper step or a phone branch marker does not). */
const LISTED = new Set(['user', 'agent', 'report', 'call', 'voice_note', 'question', 'approval', 'helper'])

function titleOf(rows: ChatItem[]): string {
  for (const row of rows) {
    const title = metaText(parseMeta(row.meta), 'title')
    if (row.kind === 'notice' && title !== '') return short(title, 60)
  }
  const first = rows.find((row) => row.kind === 'user' && row.text.trim() !== '')
  return first === undefined ? 'New chat' : short(first.text, 60)
}

/**
 * Every chat, newest first. The chat on screen is always listed (a new chat has no rows yet). Rows written
 * before chats existed form the first chat.
 */
export function chatList(items: ChatItem[], open?: string): ChatEntry[] {
  const groups = new Map<string, ChatItem[]>()
  for (const item of items) {
    if (item.kind === 'branch') continue
    const chat = chatOf(item)
    const list = groups.get(chat)
    if (list === undefined) groups.set(chat, [item])
    else list.push(item)
  }
  const out: ChatEntry[] = []
  for (const [id, rows] of groups) {
    if (!rows.some((row) => LISTED.has(row.kind))) continue
    rows.sort((a, b) => a.createdAt - b.createdAt)
    const replies = rows.filter((row) => row.kind === 'agent' || row.kind === 'report' || (row.kind === 'helper' && parseMeta(row.meta)['side'] === true))
    const lastReplyAt = replies.reduce((latest, row) => {
      const ended = parseMeta(row.meta)['endedAt']
      return Math.max(latest, row.kind === 'helper' ? (typeof ended === 'number' ? ended : 0) : row.createdAt)
    }, 0)
    out.push({
      id,
      title: titleOf(rows),
      at: rows.reduce((latest, row) => Math.max(latest, row.createdAt), 0),
      lastReplyAt,
      branch: rows.some((row) => row.kind === 'notice' && parseMeta(row.meta)['branch'] === true),
      device: rows.some((row) => parseMeta(row.meta)['from'] === 'phone') && !rows.some((row) => row.kind === 'user' && parseMeta(row.meta)['from'] !== 'phone') ? 'phone' : 'desk',
    })
  }
  if (open !== undefined && !out.some((entry) => entry.id === open)) {
    out.push({ id: open, title: 'New chat', at: Number.MAX_SAFE_INTEGER, lastReplyAt: 0, branch: false, device: 'desk' })
  }
  return out.sort((a, b) => b.at - a.at)
}

export type ChatStatus = 'working' | 'waiting' | 'unread' | 'idle'

/** What the rail dot says for a chat: waiting on you beats working beats a reply you have not read. */
export function chatStatus(
  entry: ChatEntry,
  run: ChatRunInfo | undefined,
  seenAt: number,
  open: boolean,
  openCards = 0,
): ChatStatus {
  if (openCards > 0 || (run !== undefined && run.waiting.length > 0)) return 'waiting'
  if (run !== undefined && (run.running || run.alongside > 0)) return 'working'
  if (!open && entry.lastReplyAt > seenAt) return 'unread'
  return 'idle'
}

export const STATUS_LABEL: Record<ChatStatus, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  unread: 'Done, not read yet',
  idle: '',
}

/** The chat's name for its header: a branch's title, else its first message. */
export function chatTitleOf(rows: ChatItem[]): string {
  return titleOf(rows)
}

/** A separate run started from a message sent while the chat was busy: shown in the thread as its own block. */
export function isSideRun(item: ChatItem): boolean {
  return item.kind === 'helper' && parseMeta(item.meta)['side'] === true
}

/** Which way a busy message went, in plain words, or '' for an ordinary message. */
export function routeLine(item: ChatItem): string {
  const meta = parseMeta(item.meta)
  const route = metaText(meta, 'route')
  if (route === 'pending') return 'Reading this next to the current task'
  if (route === 'join') return 'Added to the current task'
  if (route === 'alongside') {
    return metaText(meta, 'routeWhy') === 'slow'
      ? 'Started alongside, because the current step was taking a while'
      : 'Started alongside as its own job'
  }
  return ''
}
