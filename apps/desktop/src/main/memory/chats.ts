/**
 * Chats are stretches of the one chat stream, split by the "New chat" dividers. Nothing is ever deleted: a divider
 * only takes what came before it out of the model's context. A chat's id is the id of the divider that started it,
 * or of its first row for the very first chat.
 *
 * The divider that CLOSES a chat carries how that chat was filed into memory (`meta.memory`, a ChatMemoryNote) and
 * its short summary (`meta.summary`, `meta.title`), so the summary syncs with the rest of the chat.
 */
import type { ChatItem, ChatMemoryNote } from '@agent/core'

export interface ChatSegment {
  id: string
  /** The chat it is part of ('main' for the first chat). */
  chat: string
  /** The divider that started it, or null for the first chat. */
  startDivider: ChatItem | null
  /** The divider that closed it, or null for the chat in progress. */
  endDivider: ChatItem | null
  /** Its rows, oldest first, without dividers, branch markers and helpers' own steps. */
  items: ChatItem[]
  startedAt: number
  endedAt: number
}

/** The kinds of row whose text is part of what was said. */
const SPOKEN = new Set(['user', 'agent', 'report', 'call', 'voice_note'])

export function parseMeta(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function isDividerRow(item: ChatItem): boolean {
  return item.kind === 'notice' && parseMeta(item.meta)['divider'] === true
}

function isHelperStep(item: ChatItem): boolean {
  if (item.kind === 'helper') return true
  if (item.kind !== 'activity') return false
  const helper = parseMeta(item.meta)['helper']
  return typeof helper === 'string' && helper !== ''
}

/**
 * Every chat, oldest first. Several chats run side by side now (each row's `meta.chat`, see
 * runtime/chat-lines.ts): each one is split by its own dividers, so a stretch never mixes two chats. The last
 * one is the newest stretch (it may be empty).
 *
 * New chat opens a fresh chat whose first row is a divider carrying the filing note for the chat it left. That
 * divider closes the old chat's stretch for summaries and search (its `endDivider`), without cutting the old
 * chat's own context, so the old chat can still be picked up where it was.
 */
export function chatSegments(all: ChatItem[]): ChatSegment[] {
  const rows = all
    .filter((item) => item.kind !== 'branch' && !isHelperStep(item))
    .filter((item) => !(item.kind === 'question' && parseMeta(item.meta)['context'] === 'home'))
    .sort((a, b) => a.createdAt - b.createdAt)
  const byChat = new Map<string, ChatItem[]>()
  for (const row of rows) {
    const chat = chatIdOf(row)
    const list = byChat.get(chat)
    if (list === undefined) byChat.set(chat, [row])
    else list.push(row)
  }
  const segments: ChatSegment[] = []
  for (const [chat, list] of byChat) segments.push(...segmentsOfOneChat(list, chat))
  const byId = new Map(segments.map((segment) => [segment.id, segment]))
  for (const row of rows) {
    if (!isDividerRow(row)) continue
    const filed = memoryNote(row)?.chat ?? ''
    const closed = byId.get(filed)
    if (closed !== undefined && closed.endDivider === null && closed.chat !== chatIdOf(row)) closed.endDivider = row
  }
  return segments.sort((a, b) => a.startedAt - b.startedAt)
}

/** The chat a row belongs to (runtime/chat-lines.ts): `meta.chat`, else the first chat. */
function chatIdOf(item: ChatItem): string {
  const value = parseMeta(item.meta)['chat']
  return typeof value === 'string' && value !== '' ? value : 'main'
}

function segmentsOfOneChat(rows: ChatItem[], chat: string): ChatSegment[] {
  const segments: ChatSegment[] = []
  let current: ChatSegment | null = null
  for (const row of rows) {
    if (isDividerRow(row)) {
      if (current !== null) {
        current.endDivider = row
        segments.push(current)
      }
      current = { id: row.id, chat, startDivider: row, endDivider: null, items: [], startedAt: row.createdAt, endedAt: row.createdAt }
      continue
    }
    if (current === null) {
      current = { id: row.id, chat, startDivider: null, endDivider: null, items: [], startedAt: row.createdAt, endedAt: row.createdAt }
    }
    current.items.push(row)
    current.endedAt = row.createdAt
  }
  if (current !== null) segments.push(current)
  return segments
}

/** The newest divider's time, or 0 when there is none. Turns older than it are out of the model's context. */
export function latestDividerAt(all: ChatItem[]): number {
  let at = 0
  for (const item of all) if (isDividerRow(item) && item.createdAt > at) at = item.createdAt
  return at
}

/** What was said in a chat, one line per message, as "Person:" and "Agent:". */
export function spokenRows(segment: ChatSegment): ChatItem[] {
  return segment.items.filter((item) => SPOKEN.has(item.kind) && item.text.trim() !== '')
}

export function speaker(item: ChatItem): string {
  if (item.kind === 'user') return 'Person'
  if (item.kind === 'report') return 'Agent (report)'
  if (item.kind === 'call') return 'Voice call'
  return 'Agent'
}

/**
 * The chat as plain text for a model, clipped to `budget` characters. When it is too long the first message
 * (what it was about) and the newest messages (where it ended up) are kept.
 */
export function transcript(segment: ChatSegment, budget = 30_000, perMessage = 2_500): string {
  const lines = spokenRows(segment).map((item) => `${speaker(item)}: ${clip(item.text.trim(), perMessage)}`)
  const whole = lines.join('\n\n')
  if (whole.length <= budget) return whole
  const first = lines[0] ?? ''
  const tail: string[] = []
  let used = first.length + 40
  for (let index = lines.length - 1; index > 0; index -= 1) {
    const line = lines[index] ?? ''
    if (used + line.length + 2 > budget) break
    tail.unshift(line)
    used += line.length + 2
  }
  return [first, '[... earlier messages left out ...]', ...tail].join('\n\n')
}

/** Worth filing: the person said something real and the agent answered. "hi" and a lone greeting are not. */
export function hasSubstance(segment: ChatSegment): boolean {
  const spoken = spokenRows(segment)
  const person = spoken.filter((item) => item.kind === 'user')
  const agent = spoken.filter((item) => item.kind !== 'user')
  if (person.length === 0 || agent.length === 0) return false
  const words = person.map((item) => item.text).join(' ').split(/\s+/).filter((word) => word.length > 1)
  return words.length >= 6 || person.length >= 3
}

/** A short title: the first thing the person said. */
export function segmentTitle(segment: ChatSegment): string {
  const note = segment.endDivider === null ? null : parseMeta(segment.endDivider.meta)
  const stored = note !== null && typeof note['title'] === 'string' ? note['title'].trim() : ''
  if (stored !== '') return stored
  const first = segment.items.find((item) => item.kind === 'user' && item.text.trim() !== '')
  return first === undefined ? 'Chat' : clip(first.text.trim().replace(/\s+/g, ' '), 60)
}

export function segmentSummary(segment: ChatSegment): string {
  if (segment.endDivider === null) return ''
  const value = parseMeta(segment.endDivider.meta)['summary']
  return typeof value === 'string' ? value : ''
}

/** The filing note on a divider, when it has one. */
export function memoryNote(divider: ChatItem): ChatMemoryNote | null {
  const value = parseMeta(divider.meta)['memory']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const note = value as Record<string, unknown>
  const status = note['status']
  if (status !== 'saving' && status !== 'done' && status !== 'failed') return null
  const out: ChatMemoryNote = { chat: typeof note['chat'] === 'string' ? note['chat'] : '', status }
  if (Array.isArray(note['saved'])) out.saved = note['saved'].filter((id): id is string => typeof id === 'string')
  if (typeof note['added'] === 'number') out.added = note['added']
  if (typeof note['updated'] === 'number') out.updated = note['updated']
  if (typeof note['error'] === 'string') out.error = note['error']
  return out
}

export function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}
