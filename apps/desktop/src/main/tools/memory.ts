/**
 * Memory tools, ported from reference/phone/tools/MemoryTools.kt. Memory is a small wiki: one page per
 * person, company, place, project or preference, written in markdown with [[Name]] links and tags.
 */
import {
  bool,
  enumOf,
  int,
  schema,
  str,
  type MemoryKind,
  type MemoryRow,
  type Tool,
} from '@agent/core'

import type { DataStore } from '../runtime/data'
import { formatMemory, rank } from '../runtime/recall'

export const MEMORY_KINDS: MemoryKind[] = [
  'fact',
  'preference',
  'person',
  'decision',
  'how-to',
  'event',
  'skill',
]

const WIKI_LINK = /\[\[([^\]|]+)(?:\|[^\]]*)?]]/g

/** The page titles a body links to. */
export function linksIn(body: string): string[] {
  const found = new Set<string>()
  const link = new RegExp(WIKI_LINK.source, 'g')
  let match = link.exec(body)
  while (match !== null) {
    const title = (match[1] ?? '').trim()
    if (title !== '') found.add(title)
    match = link.exec(body)
  }
  return [...found]
}

export function memoryTools(store: DataStore): Tool[] {
  return [memorySearch(store), memoryGet(store), memorySave(store), memoryUpdate(store)]
}

function memorySearch(store: DataStore): Tool {
  return {
    spec: {
      name: 'memory_search',
      description:
        'Search everything you have remembered about the user (facts, preferences, people, decisions). Search before asking the user anything they may already have told you.',
      schema: schema(
        ['query'],
        {
          query: str('What to recall, in plain words'),
          limit: int('Max results, default 8'),
        },
      ),
    },
    run: async (input) => {
      const query = text(input['query'])
      const limit = clamp(Math.trunc(number(input['limit'], 8)), 1, 25)
      const hits = rank(query, await store.list('memory'), limit)
      return hits.length === 0 ? 'No memories match.' : hits.map(formatMemory).join('\n')
    },
  }
}

function memoryGet(store: DataStore): Tool {
  return {
    spec: {
      name: 'memory_get',
      description: 'Read one memory page in full by its id, plus which pages link to it.',
      schema: schema(['id'], { id: str('Memory id, the #number in a search result') }),
    },
    run: async (input) => {
      const id = text(input['id']).trim()
      if (id === '') return 'Pass the id of the memory page you want.'
      const rows = await store.list('memory')
      const page =
        rows.find((row) => row.id === id) ??
        rows.find((row) => row.title.trim().toLowerCase() === id.toLowerCase())
      if (page === undefined) return `No memory page called '${id}'.`

      const linkedFrom = rows
        .filter(
          (row) =>
            row.id !== page.id &&
            linksIn(row.body).some((title) => title.toLowerCase() === page.title.toLowerCase()),
        )
        .map((row) => row.title)
      const tail = linkedFrom.length === 0 ? '' : `\n\nLinked from: ${linkedFrom.join(', ')}`
      return formatPage(page) + tail
    },
  }
}

function memorySave(store: DataStore): Tool {
  return {
    spec: {
      name: 'memory_save',
      description:
        "Write or update a wiki page in your memory about ONE thing: a person, company, place, project, plan or preference. Title = its name. Body = markdown, detailed but no padding; refer to other pages as [[Name]] links. If a page with the same title exists its body is replaced, so memory_get it first and merge. Always add topics.",
      schema: schema(
        ['title', 'body', 'topics'],
        {
          title: str("The thing's name"),
          body: str('Markdown page with [[links]]'),
          kind: enumOf('What it is', ...MEMORY_KINDS),
          topics: str("Comma-separated tags for search, e.g. 'family, durban, birthday'"),
          pinned: bool("Pin it (core facts, like the user's own page)"),
        },
      ),
    },
    run: async (input, ctx) => {
      const title = text(input['title']).trim()
      if (title === '') return 'A memory page needs a title.'
      const rows = await store.list('memory')
      // Saved from a project chat: a new page is that project's memory.
      const project = ctx.chat === undefined ? undefined : (await store.list('project')).find((p) => p.chats.includes(ctx.chat ?? ''))?.id
      const existing = rows.find((row) => row.title.trim().toLowerCase() === title.toLowerCase())
      const body = text(input['body'])
      const topics = text(input['topics']) || text(input['tags'])
      const kind = memoryKind(input['kind'])

      if (existing !== undefined) {
        await store.upsert('memory', {
          id: existing.id,
          title,
          body,
          kind: kind ?? existing.kind,
          topics: topics === '' ? existing.topics : topics,
          pinned: existing.pinned || truthy(input['pinned']),
          source: 'agent',
        })
        return `Updated page #${existing.id} '${title}'`
      }

      const saved = await store.upsert('memory', {
        title,
        body,
        kind: kind ?? 'fact',
        topics,
        pinned: truthy(input['pinned']),
        source: 'agent',
        ...(project === undefined ? {} : { project }),
      })
      return `Saved page #${saved.id} '${title}'`
    },
  }
}

function memoryUpdate(store: DataStore): Tool {
  return {
    spec: {
      name: 'memory_update',
      description:
        'Correct or delete a memory page by id when it turns out to be wrong or out of date.',
      schema: schema(
        ['id'],
        {
          id: str('Memory id'),
          title: str('New title'),
          body: str('New text'),
          kind: enumOf('New kind', ...MEMORY_KINDS),
          topics: str('New comma-separated tags'),
          pinned: bool('Pin or unpin it'),
          delete: bool('Delete it instead'),
        },
      ),
    },
    run: async (input) => {
      const id = text(input['id']).trim()
      const rows = await store.list('memory')
      const page = rows.find((row) => row.id === id)
      if (page === undefined) return `No memory #${id}.`

      if (truthy(input['delete'])) {
        await store.remove('memory', page.id)
        return `Deleted #${page.id} '${page.title}'`
      }

      const kind = memoryKind(input['kind'])
      const pinned = input['pinned']
      await store.upsert('memory', {
        id: page.id,
        title: text(input['title']).trim() || page.title,
        body: text(input['body']).trim() || page.body,
        kind: kind ?? page.kind,
        topics: text(input['topics']).trim() || page.topics,
        pinned: typeof pinned === 'boolean' ? pinned : page.pinned,
        source: page.source,
      })
      return `Updated #${page.id} '${page.title}'`
    },
  }
}

function formatPage(page: MemoryRow): string {
  return `# ${page.title} (#${page.id}, ${page.kind}; topics: ${page.topics})\n${page.body}`
}

function memoryKind(value: unknown): MemoryKind | null {
  return typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value)
    ? (value as MemoryKind)
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function truthy(value: unknown): boolean {
  return value === true || value === 'true'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
