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
