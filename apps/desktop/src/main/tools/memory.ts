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

import { agentWriter, aliasList, asWriter } from '../memory/history'
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
  return [memorySearch(store), memoryGet(store), memorySave(store), memoryUpdate(store), memoryHistory(store)]
}

/** The newest version number of a page, or null when the store keeps none. */
function versionNow(store: DataStore, id: string): number | null {
  const history = store.memoryHistory?.(id)
  return history === undefined ? null : (history[0]?.n ?? 0)
}

/** What a write did, said plainly so the agent (and the person reading the step) can tell it really happened. */
function writeReceipt(store: DataStore, id: string, title: string, before: number | null, verb: string): string {
  const after = versionNow(store, id)
  if (after === null) return `${verb} #${id} '${title}'`
  if (before !== null && after === before) return `Nothing changed on #${id} '${title}' (still version ${after}).`
  const latest = store.memoryHistory?.(id)[0]
  const changed = latest === undefined ? '' : `: ${latest.changed.join(', ')}`
  return `${verb} #${id} '${title}', now version ${after}${changed}.`
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
          aliases: str('Other names or spellings it answers to, comma separated'),
          reason: str('Why you are writing it, in a few words (kept in its history)'),
        },
      ),
    },
    run: (input, ctx) => asWriter(agentWriter(ctx.agentLabel), text(input['reason']), async () => {
      const title = text(input['title']).trim()
      if (title === '') return 'A memory page needs a title.'
      const rows = await store.list('memory')
      // Saved from a project chat: a new page is that project's memory.
      const project = ctx.chat === undefined ? undefined : (await store.list('project')).find((p) => p.chats.includes(ctx.chat ?? ''))?.id
      const existing = rows.find((row) => row.title.trim().toLowerCase() === title.toLowerCase())
      const body = text(input['body'])
      const topics = text(input['topics']) || text(input['tags'])
      const kind = memoryKind(input['kind'])

      const aliases = text(input['aliases'])
      if (existing !== undefined) {
        const before = versionNow(store, existing.id)
        await store.upsert('memory', {
          id: existing.id,
          title,
          body,
          kind: kind ?? existing.kind,
          topics: topics === '' ? existing.topics : topics,
          pinned: existing.pinned || truthy(input['pinned']),
          ...(aliases === '' ? {} : { aliases: aliasList(`${existing.aliases ?? ''},${aliases}`).join(', ') }),
          source: 'agent',
        })
        return writeReceipt(store, existing.id, title, before, 'Updated page')
      }

      const saved = await store.upsert('memory', {
        title,
        body,
        kind: kind ?? 'fact',
        topics,
        pinned: truthy(input['pinned']),
        ...(aliases === '' ? {} : { aliases: aliasList(aliases).join(', ') }),
        source: 'agent',
        ...(project === undefined ? {} : { project }),
      })
      return writeReceipt(store, saved.id, title, null, 'Saved page')
    }),
  }
}

function memoryUpdate(store: DataStore): Tool {
  return {
    spec: {
      name: 'memory_update',
      description:
        'Change a memory page by id: correct it, bring it up to date, CLOSE it when the thing is done (status closed keeps it, searchable, but stops reminding you of it; open again with status open), add other names it answers to, or delete it. Every change is kept as a version with your reason; the result says the new version number, so you know it really changed.',
      schema: schema(
        ['id'],
        {
          id: str('Memory id'),
          title: str('New title'),
          body: str('New text (the whole page)'),
          kind: enumOf('New kind', ...MEMORY_KINDS),
          topics: str('New comma-separated tags'),
          pinned: bool('Pin or unpin it'),
          status: enumOf('open, or closed when it is done and ticked off', 'open', 'closed'),
          aliases: str('The full list of other names or spellings it answers to, comma separated (replaces the list)'),
          add_alias: str("One more name or spelling it answers to, e.g. how dictation mis-heard it ('Londercorp' for Initech)"),
          reason: str('Why, in a few words (kept in its history)'),
          delete: bool('Delete it instead'),
        },
      ),
    },
    run: (input, ctx) => asWriter(agentWriter(ctx.agentLabel), text(input['reason']), async () => {
      const id = text(input['id']).trim()
      const rows = await store.list('memory')
      const page = rows.find((row) => row.id === id)
      if (page === undefined) return `No memory #${id}.`

      // A project's memory is never deleted by an agent: it is closed, and every version stays in its history.
      if (truthy(input['delete']) && page.project !== undefined && page.project !== '') {
        if (page.status === 'closed') return `#${page.id} '${page.title}' is project memory and already closed; it is kept, not deleted.`
        const before = versionNow(store, page.id)
        await store.upsert('memory', { id: page.id, status: 'closed', closedAt: Date.now() })
        return writeReceipt(store, page.id, page.title, before, "Project memory is never deleted, so it was closed instead (kept, searchable, out of the reminders)")
      }
      if (truthy(input['delete'])) {
        await store.remove('memory', page.id)
        return `Deleted #${page.id} '${page.title}'${versionNow(store, page.id) === null ? '' : ' (its history is kept)'}`
      }

      const kind = memoryKind(input['kind'])
      const pinned = input['pinned']
      const status = input['status'] === 'closed' || input['status'] === 'open' ? input['status'] : null
      const wasClosed = page.status === 'closed'
      const aliasesIn = typeof input['aliases'] === 'string' ? input['aliases'] : null
      const addAlias = text(input['add_alias']).trim()
      const aliases = aliasesIn !== null || addAlias !== '' ? aliasList(`${aliasesIn ?? page.aliases ?? ''},${addAlias}`).join(', ') : undefined
      const before = versionNow(store, page.id)
      await store.upsert('memory', {
        id: page.id,
        title: text(input['title']).trim() || page.title,
        body: text(input['body']).trim() || page.body,
        kind: kind ?? page.kind,
        topics: text(input['topics']).trim() || page.topics,
        pinned: typeof pinned === 'boolean' ? pinned : page.pinned,
        ...(status === null ? {} : { status, closedAt: status === 'closed' ? (wasClosed ? (page.closedAt ?? Date.now()) : Date.now()) : null }),
        ...(aliases === undefined ? {} : { aliases }),
        source: page.source,
      })
      return writeReceipt(store, page.id, page.title, before, status === 'closed' && !wasClosed ? 'Closed' : 'Updated')
    }),
  }
}

function memoryHistory(store: DataStore): Tool {
  return {
    spec: {
      name: 'memory_history',
      description:
        "How one memory page changed over time, newest first: each version's number, date, who changed it and why, what changed, and what it said. Use it to see how a decision got to where it is, or what a page said before.",
      schema: schema(['id'], { id: str('Memory id'), limit: int('How many versions, default 10') }),
    },
    run: async (input) => {
      const id = text(input['id']).trim()
      const history = store.memoryHistory?.(id)
      if (history === undefined) return 'This memory keeps no history.'
      if (history.length === 0) return `#${id} has no earlier versions yet.`
      const limit = clamp(Math.trunc(number(input['limit'], 10)), 1, 50)
      return history
        .slice(0, limit)
        .map((v) => {
          const when = new Date(v.at).toISOString().slice(0, 16).replace('T', ' ')
          const why = v.reason === '' ? '' : ` (${v.reason})`
          const what = v.deleted ? 'deleted' : `${v.changed.join(', ')}${v.status === 'closed' ? ' [closed]' : ''}`
          const said = v.deleted ? '' : `\n  ${v.title}: ${v.body.length > 400 ? `${v.body.slice(0, 400)}...` : v.body}`
          return `v${v.n} ${when} by ${v.by}${why}: ${what}${said}`
        })
        .join('\n')
    },
  }
}

function formatPage(page: MemoryRow): string {
  const closed = page.status === 'closed' ? ', closed' : ''
  const aliases = (page.aliases ?? '').trim() === '' ? '' : `; also called: ${page.aliases}`
  return `# ${page.title} (#${page.id}, ${page.kind}${closed}; topics: ${page.topics}${aliases})\n${page.body}`
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
