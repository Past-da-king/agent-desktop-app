import type { MemoryKind, MemoryRow } from '@agent/core'

const LINK = /\[\[([^\]]+)\]\]/g

/** The names inside `[[double brackets]]`, de-duplicated, in the order they appear. */
export function linkedNames(body: string): string[] {
  const names: string[] = []
  for (const match of body.matchAll(LINK)) {
    const name = match[1]?.trim()
    if (name !== undefined && name !== '' && !names.includes(name)) names.push(name)
  }
  return names
}

/** The body with the brackets removed, for list previews. */
export function plainBody(body: string): string {
  return body.replace(/\[\[([^\]]+)\]\]/g, '$1')
}

/** A page linked by name, case-insensitively. The first page with that title wins. */
export function findPage(all: MemoryRow[], name: string): MemoryRow | undefined {
  const wanted = name.trim().toLowerCase()
  return all.find((memory) => memory.title.trim().toLowerCase() === wanted)
}

/** Every link in a page that points at a page we already have. */
export function linkTargets(memory: MemoryRow, all: MemoryRow[]): MemoryRow[] {
  return linkedNames(memory.body)
    .map((name) => findPage(all, name))
    .filter((item): item is MemoryRow => item !== undefined)
}

export type MemoryKindFilter = 'all' | MemoryKind

/**
 * Search matches title, body and topics, case-insensitively. Pinned pages come first, then the
 * newest edit. Filtering happens before sorting so the pinned rule only reorders the visible list.
 */
export function searchMemories(
  memories: MemoryRow[],
  query: string,
  kind: MemoryKindFilter = 'all',
): MemoryRow[] {
  const q = query.trim().toLowerCase()
  return memories
    .filter((memory) => kind === 'all' || memory.kind === kind)
    .filter((memory) => q === '' || `${memory.title} ${memory.body} ${memory.topics}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
}

/** The row a "Create page" offer would make for a missing `[[link]]`. */
export function newPage(title: string, now = Date.now()): MemoryRow {
  return {
    id: '',
    createdAt: now,
    title,
    body: '',
    kind: 'fact',
    topics: '',
    pinned: false,
    source: 'user',
    updatedAt: now,
  }
}

/** The kinds in the order Memory shows them, with the section's name and what it is for. */
export const MEMORY_TYPES: Array<{ kind: MemoryKind; label: string; line: string }> = [
  { kind: 'person', label: 'People', line: 'Who they are and how to work with them' },
  { kind: 'organisation', label: 'Organisations', line: 'Companies, teams and places you deal with' },
  { kind: 'project', label: 'Projects', line: 'What you are building or running' },
  { kind: 'how-to', label: 'How-tos', line: 'Steps to do it again' },
  { kind: 'decision', label: 'Decisions', line: 'What was decided and why' },
  { kind: 'preference', label: 'Preferences', line: 'How you like things done' },
  { kind: 'fact', label: 'Facts', line: 'Things that stay true' },
  { kind: 'event', label: 'Events', line: 'Moments worth remembering' },
  { kind: 'skill', label: 'Skills', line: 'What your agent learned to do' },
]

/** Pages per kind, each list newest first. Kinds with no pages are left out. */
export function groupByKind(memories: MemoryRow[]): Array<{ kind: MemoryKind; label: string; line: string; rows: MemoryRow[] }> {
  return MEMORY_TYPES.map((type) => ({
    ...type,
    rows: memories.filter((memory) => memory.kind === type.kind).sort((a, b) => b.updatedAt - a.updatedAt),
  })).filter((group) => group.rows.length > 0)
}

/** How many pages of each kind. */
export function kindCounts(memories: MemoryRow[]): Partial<Record<MemoryKind, number>> {
  const counts: Partial<Record<MemoryKind, number>> = {}
  for (const memory of memories) counts[memory.kind] = (counts[memory.kind] ?? 0) + 1
  return counts
}
