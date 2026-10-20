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
export function rank(query: string, rows: MemoryRow[], limit: number): MemoryRow[] {
  const wanted = terms(query)
  if (wanted.size === 0) {
    return [...rows].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(0, limit))
  }

  const now = Date.now()
  const scored: Array<{ row: MemoryRow; score: number }> = []
  for (const row of rows) {
    const title = terms(row.title)
    const topics = terms(row.topics)
    const body = terms(row.body)
    let score = 0
    for (const term of wanted) {
      if (title.has(term)) score += 3
      if (topics.has(term)) score += 2
      if (body.has(term)) score += 1
      if (term.length > 3) {
        const text = `${row.title} ${row.body}`.toLowerCase()
        if (text.includes(term)) score += 0.5
      }
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
  return `#${row.id} [${row.kind}${row.pinned ? ', pinned' : ''}] ${row.title}: ${row.body}${
    tags === '' ? '' : ` (topics: ${tags})`
  }`
}
