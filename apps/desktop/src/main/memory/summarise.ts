/**
 * Filing a finished chat into long-term memory: one model call reads the chat and returns a short summary plus a
 * few organised entries (how-to, person, organisation, project, decision, preference, fact). Before anything is
 * written each entry is checked for secrets and matched against what memory already holds, so an entry on the same
 * subject UPDATES that page (facts merged, nothing lost) instead of adding a near-duplicate.
 */
import type { MemoryKind, MemoryRow } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { namedPages, rank, terms } from '../runtime/recall'

export { namedPages }
import { clip } from './chats'
import { mostlySecret, redactSecrets } from './redact'
import { replyObject } from './reply-json'

/** One model call: system text and prompt in, the reply text out. Throws with a plain message when it fails. */
export type Complete = (system: string, prompt: string, signal?: AbortSignal) => Promise<string>

/** What a filed chat may become. Events and transient state never are. */
export const FILED_KINDS: MemoryKind[] = ['how-to', 'person', 'organisation', 'project', 'decision', 'preference', 'fact']

const MAX_ENTRIES = 8
/** How much of an existing page the model is shown. A page longer than this is only ever appended to. */
export const EXCERPT = 1_200

export interface DraftEntry {
  kind: MemoryKind
  title: string
  body: string
  topics: string
  /** The id of an existing page the model says this updates. */
  update: string
}

export interface ChatDigest {
  title: string
  summary: string
  entries: DraftEntry[]
}

export interface FileResult {
  added: string[]
  updated: string[]
  /** Entries dropped: not a durable kind, empty, or nothing but a secret. */
  dropped: number
  redacted: number
}

export const FILE_SYSTEM = [
  "You file a finished chat into the user's long-term memory. The memory is a clean, organised wiki the agent reads before every reply, so only knowledge that stays useful goes in.",
  '',
  'Reply with ONLY one JSON object, no prose and no code fence:',
  '{"title": "4 to 8 words naming what the chat was about", "summary": "2 to 4 plain sentences: what it was about, what was decided or done, what is still open", "memories": [{"kind": "...", "title": "...", "body": "...", "topics": "comma, separated, tags", "update": "id of the EXISTING entry this updates, or empty"}]}',
  '',
  'Kinds, and what each body holds:',
  '- person: one real person, title = their full name. Who they are to the user, role, organisation, how to reach or work with them, what matters to them.',
  '- organisation: a company, team, school or body. What it is, the user\'s relationship to it, key people as [[Name]] links.',
  '- project: something the user is building or running. Goal, current shape, key decisions, people involved.',
  '- how-to: a reusable procedure. Numbered steps someone could follow next time, with the exact commands, settings or places.',
  '- decision: what was decided AND why, with the date.',
  '- preference: how the user likes things done.',
  '- fact: a stable fact about the user or their world.',
  '',
  'Rules:',
  '- Every body is self-contained: a stranger with no other context understands it. Full names, absolute dates, no "he", "it" or "as above" without saying who or what.',
  '- Link other entries as [[Name]].',
  '- Leave out: chit-chat and greetings, the progress of a task, anything true only today, guesses, what the agent tried that failed (unless it is a lesson for a how-to), and the content of files or web pages.',
  '- NEVER include secrets: passwords, API keys, tokens, one-time codes, card or bank numbers. Leave them out entirely.',
  '- EXISTING ENTRIES are listed with their ids. When your entry is about the same subject as one of them, set "update" to that id and write the FULL merged body: keep every still-true fact from the existing body, add the new ones, correct what changed. Never make a second entry on the same subject.',
  `- At most ${MAX_ENTRIES} entries. An empty "memories" list is the right answer for a chat with nothing durable in it.`,
].join('\n')

/** The prompt for one chat: today's date, the entries it might touch, then the chat. */
export function filePrompt(chat: string, existing: MemoryRow[], today: string): string {
  const lines = [`Today is ${today}.`, '', 'EXISTING ENTRIES (may be updated):']
  if (existing.length === 0) lines.push('(none)')
  for (const row of existing) {
    lines.push(`- id ${row.id} [${row.kind}] ${row.title}: ${clip(row.body.replace(/\s+/g, ' ').trim(), EXCERPT)}`)
  }
  lines.push('', 'THE CHAT:', chat)
  return lines.join('\n')
}

/** The pages a chat is most likely to touch: names it mentions, then the best word matches. */
export function candidatesFor(chat: string, memories: MemoryRow[], limit = 16): MemoryRow[] {
  const named = namedPages(chat, memories, 8)
  const seen = new Set(named.map((row) => row.id))
  const ranked = rank(chat, memories.filter((row) => !seen.has(row.id)), limit)
  return [...named, ...ranked].slice(0, limit)
}

/** Reads the model's reply. Tolerates a code fence or a sentence around the JSON. */
export function parseDigest(reply: string): ChatDigest {
  const object = replyObject(reply)
  if (object === null) throw new Error(reply.includes('{') ? 'The model replied with something that was not a summary.' : 'The model did not reply with a summary.')
  const list = Array.isArray(object['memories']) ? object['memories'] : Array.isArray(object['entries']) ? object['entries'] : []
  const entries: DraftEntry[] = []
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const kind = normaliseKind(text(entry['kind']))
    if (kind === null) continue
    const topics = Array.isArray(entry['topics']) ? entry['topics'].filter((t): t is string => typeof t === 'string').join(', ') : text(entry['topics'])
    entries.push({
      kind,
      title: text(entry['title']).trim(),
      body: text(entry['body']).trim(),
      topics: topics.trim(),
      update: text(entry['update']).trim() || text(entry['id']).trim(),
    })
  }
  return { title: text(object['title']).trim(), summary: text(object['summary']).trim(), entries: entries.slice(0, MAX_ENTRIES) }
}

/** The kind names a model (or another memory bank) uses, mapped onto the app's. Null for transient ones. */
export function normaliseKind(raw: string): MemoryKind | null {
  const kind = raw.trim().toLowerCase().replace(/[_\s]+/g, '-')
  switch (kind) {
    case 'person':
    case 'people':
    case 'contact':
      return 'person'
    case 'organisation':
    case 'organization':
    case 'org':
    case 'company':
    case 'team':
      return 'organisation'
    case 'project':
      return 'project'
    case 'how-to':
    case 'howto':
    case 'procedure':
    case 'recipe':
      return 'how-to'
    case 'decision':
      return 'decision'
    case 'preference':
      return 'preference'
    case 'fact':
    case 'reference':
      return 'fact'
    default:
      return null
  }
}

/** Normalised title for matching: lowercase words only. */
export function titleKey(title: string): string {
  return title.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** The existing page an entry is about, if any. */
export function findSame(entry: DraftEntry, memories: MemoryRow[]): MemoryRow | null {
  if (entry.update !== '') {
    const named = memories.find((row) => row.id === entry.update)
    if (named !== undefined) return named
  }
  const key = titleKey(entry.title)
  if (key === '') return null
  const exact = memories.find((row) => titleKey(row.title) === key && compatible(row.kind, entry.kind))
  if (exact !== undefined) return exact
  const words = terms(entry.title)
  let best: { row: MemoryRow; score: number } | null = null
  for (const row of memories) {
    if (row.kind !== entry.kind) continue
    const other = terms(row.title)
    if (words.size === 0 || other.size === 0) continue
    let shared = 0
    for (const word of words) if (other.has(word)) shared += 1
    const jaccard = shared / (words.size + other.size - shared)
    // "Ben" and "Alex Meyer" are the same person; "Creek sites" and "Creek Retreats sites" the same project.
    const prefix = (row.kind === 'person' || row.kind === 'organisation') && (titleKey(row.title).startsWith(`${key} `) || key.startsWith(`${titleKey(row.title)} `))
    const score = prefix ? 0.9 : jaccard
    if (score >= 0.75 && (best === null || score > best.score)) best = { row, score }
  }
  return best?.row ?? null
}

function compatible(a: MemoryKind, b: MemoryKind): boolean {
  return a === b || a === 'fact' || b === 'fact'
}

function lineKey(line: string): string {
  return line.toLowerCase().replace(/^[\s>*\-+\d.)]+/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/** The old body plus every line of the new one it does not already say. Nothing is ever dropped. */
export function mergeBodies(old: string, add: string): string {
  const have = lineKey(old)
  const haveLines = new Set(old.split('\n').map(lineKey).filter((line) => line !== ''))
  const extra: string[] = []
  for (const line of add.split('\n')) {
    const key = lineKey(line)
    if (key === '') continue
    if (haveLines.has(key) || (key.length > 24 && have.includes(key))) continue
    haveLines.add(key)
    extra.push(line.trimEnd())
  }
  if (extra.length === 0) return old
  return `${old.trimEnd()}\n${extra.join('\n')}`
}

/** The body an update ends with. The model's merged body is trusted only when it saw the whole page and kept its size. */
export function mergedBody(existing: MemoryRow, entry: DraftEntry, modelMerged: boolean): string {
  const old = existing.body
  if (modelMerged && old.length <= EXCERPT && entry.body.length >= old.length * 0.6) return entry.body
  return mergeBodies(old, entry.body)
}

export function mergeTopics(a: string, b: string): string {
  const seen = new Map<string, string>()
  for (const topic of `${a},${b}`.split(',')) {
    const clean = topic.trim()
    if (clean !== '' && !seen.has(clean.toLowerCase())) seen.set(clean.toLowerCase(), clean)
  }
  return [...seen.values()].slice(0, 12).join(', ')
}

/**
 * Writes the entries. Same subject as an existing page: that page is updated. Same subject twice in one reply:
 * merged into one. Secrets are taken out first; an entry that was nothing but a secret is dropped.
 */
export async function fileEntries(store: DataStore, entries: DraftEntry[]): Promise<FileResult> {
  const memories = await store.list('memory')
  const result: FileResult = { added: [], updated: [], dropped: 0, redacted: 0 }
  const touched = new Map<string, MemoryRow>()

  for (const raw of entries) {
    if (!FILED_KINDS.includes(raw.kind)) {
      result.dropped += 1
      continue
    }
    const title = redactSecrets(clip(raw.title.replace(/\s+/g, ' '), 140))
    const body = redactSecrets(raw.body)
    const topics = redactSecrets(raw.topics)
    result.redacted += title.total + body.total + topics.total
    if (title.text === '' || body.text.length < 12 || mostlySecret(raw.body, body.text)) {
      result.dropped += 1
      continue
    }
    const entry: DraftEntry = { ...raw, title: title.text, body: body.text, topics: topics.text }

    const pool = [...touched.values(), ...memories.filter((row) => !touched.has(row.id))]
    const same = findSame(entry, pool)
    if (same === null) {
      const saved = await store.upsert('memory', {
        title: entry.title,
        body: entry.body,
        kind: entry.kind,
        topics: entry.topics,
        pinned: false,
        source: 'agent',
      })
      touched.set(saved.id, saved)
      result.added.push(saved.id)
      continue
    }

    const modelMerged = entry.update !== '' && entry.update === same.id
    const body2 = mergedBody(same, entry, modelMerged)
    const topics2 = mergeTopics(same.topics, entry.topics)
    // A general fact page that turns out to be about a person or a company takes the sharper kind.
    const kind = same.kind === 'fact' && entry.kind !== 'fact' ? entry.kind : same.kind
    if (body2 === same.body && topics2 === same.topics && kind === same.kind) {
      touched.set(same.id, same)
      continue
    }
    const saved = await store.upsert('memory', {
      id: same.id,
      title: same.title,
      body: body2,
      kind,
      topics: topics2,
      pinned: same.pinned,
      source: same.source,
    })
    touched.set(saved.id, saved)
    if (!result.added.includes(saved.id) && !result.updated.includes(saved.id)) result.updated.push(saved.id)
  }
  return result
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
