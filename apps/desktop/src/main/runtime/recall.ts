/**
 * On-computer recall, ported from Recall in reference/phone/tools/MemoryTools.kt:
 * lowercase word overlap with a little extra weight for the title, the topics and recency.
 */
import type { MemoryRow } from '@agent/core'

const STOP_WORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'is',
  'it',
  'my',
  'me',
  'i',
  'you',
  'what',
  'do',
  'with',
  'at',
  'be',
  'this',
  'that',
  'can',
  'please',
])

const DAY_MS = 86_400_000

/** Lowercase search terms, without the words that match everything. */
export function terms(query: string): Set<string> {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.]+/u)
    .map((word) => word.replace(/^\.+|\.+$/g, ''))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
  return new Set(words)
}

/**
 * The memories most worth showing for a piece of text: title hits count 3, topic hits 2, body hits 1,
 * with a small bonus for a longer exact substring, for a pinned page, and for being recent.
 * Ties go to the most recently updated page.
 */
/**
 * A page's words, worked out once per version: ranking every page's body for every turn and every helper start took
 * up to 1.8 s on the main thread with eleven helpers (30 Oct 2026).
 */
interface PageTerms {
  key: string
  title: Set<string>
  topics: Set<string>
  body: Set<string>
  text: string
}
const pageTerms = new Map<string, PageTerms>()

function termsOf(row: MemoryRow): PageTerms {
  const key = `${row.updatedAt}|${row.title.length}|${row.body.length}|${row.topics.length}|${(row.aliases ?? '').length}`
  const held = pageTerms.get(row.id)
  if (held !== undefined && held.key === key) return held
  if (pageTerms.size > 20_000) pageTerms.clear()
  const made: PageTerms = {
    key,
    title: terms(`${row.title} ${row.aliases ?? ''}`),
    topics: terms(row.topics),
    body: terms(row.body),
    text: `${row.title} ${row.aliases ?? ''} ${row.body}`.toLowerCase(),
  }
  pageTerms.set(row.id, made)
  return made
}

export function rank(query: string, rows: MemoryRow[], limit: number): MemoryRow[] {
  const wanted = terms(query)
  if (wanted.size === 0) {
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit))
  }

  const now = Date.now()
  const scored: Array<{ row: MemoryRow; score: number }> = []
  for (const row of rows) {
    // Other names it answers to count like its title ("Londercorp" finds Initech).
    const { title, topics, body, text } = termsOf(row)
    let score = 0
    for (const term of wanted) {
      if (title.has(term)) score += 3
      if (topics.has(term)) score += 2
      if (body.has(term)) score += 1
      if (term.length > 3 && text.includes(term)) score += 0.5
    }
    if (row.pinned) score += 0.5
    score += 0.3 / (1 + Math.max(0, now - row.updatedAt) / DAY_MS)
    if (score >= 1) scored.push({ row, score })
  }

  scored.sort((a, b) => (b.score === a.score ? b.row.updatedAt - a.row.updatedAt : b.score - a.score))
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.row)
}

/** One line per memory, the way the model reads it in a tool result. */
export function formatMemory(row: MemoryRow): string {
  const tags = row.topics.trim()
  const aliases = (row.aliases ?? '').trim()
  return `#${row.id} [${row.kind}${row.pinned ? ', pinned' : ''}${row.status === 'closed' ? ', closed' : ''}] ${row.title}${
    aliases === '' ? '' : ` (also called: ${aliases})`
  }: ${row.body}${tags === '' ? '' : ` (topics: ${tags})`}`
}

/** A closed page is done and ticked off: kept and searchable, but nothing reminds the agent of it. */
export function isOpen(row: MemoryRow): boolean {
  return row.status !== 'closed'
}

/** People, organisations and projects whose name appears in the text. Kept small so the prompt stays small. */
export function namedPages(text: string, memories: MemoryRow[], limit = 6): MemoryRow[] {
  const haystack = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  const found: MemoryRow[] = []
  for (const row of memories) {
    if (row.kind !== 'person' && row.kind !== 'organisation' && row.kind !== 'project') continue
    const name = nameKey(row.title)
    if (name.length < 3) continue
    // "GrowOS / GrowFactory" answers to either name; "Fretak (was Ember): swipe cards" to "Fretak".
    const names = [
      name,
      ...row.title.split(/\s[/|:\u2013\u2014-]\s|[/|:\u2013\u2014]/).map(nameKey),
      ...(row.aliases ?? '').split(',').map(nameKey),
    ].filter((part) => part.length >= 3)
    if (names.some((part) => haystack.includes(` ${part} `))) {
      found.push(row)
      continue
    }
    // A person by first name, when that name is not a common word and was written with a capital.
    if (row.kind === 'person') {
      const first = name.split(' ')[0] ?? ''
      if (first.length >= 3 && name.includes(' ') && new RegExp(`(^|[^\\p{L}])${capital(first)}([^\\p{L}]|$)`, 'u').test(text)) {
        found.push(row)
      }
    }
  }
  return found.slice(0, limit)
}

function nameKey(title: string): string {
  return title.toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

function capital(word: string): string {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return escaped.charAt(0).toUpperCase() + escaped.slice(1)
}

/** The memories to put in front of the model for a message: pages it names first, then the best matches. Closed pages stay out. */
export function recallFor(text: string, all: MemoryRow[], limit: number): MemoryRow[] {
  const rows = all.filter(isOpen)
  const named = namedPages(text, rows, 5)
  const seen = new Set(named.map((row) => row.id))
  return [...named, ...rank(text, rows.filter((row) => !seen.has(row.id)), limit)].slice(0, limit + named.length)
}

/** One memory for the prompt: long pages are cut, with the id to read the rest. */
export function formatMemoryBrief(row: MemoryRow, limit = 700): string {
  if (row.body.length <= limit) return formatMemory(row)
  return formatMemory({ ...row, body: `${row.body.slice(0, limit).trimEnd()}... (memory_get #${row.id} for the rest)` })
}
