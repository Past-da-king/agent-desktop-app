/**
 * Imports a memory bank from a JSON export: `{ source, memories: [{ id, title, text, kind, project, topics, life,
 * date, status }] }` (a bare array works too). Kinds map onto the app's: person to people, how-to to how-tos,
 * decision to decisions, reference and fact to facts, organisation and project as they are. Retired entries and
 * short-lived kinds (state, event) are left out unless the person asks for everything.
 *
 * Re-importing is idempotent: each entry's row id is derived from its source id, so a second run updates in place
 * and an unchanged entry is not written at all. Every entry goes through the secret redaction first.
 */
import { createHash } from 'node:crypto'

import type { MemoryImportPreview, MemoryImportResult, MemoryKind, MemoryRow } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { normaliseKind } from './summarise'
import { redactSecrets } from './redact'

export interface ImportEntry {
  id: string
  title: string
  text: string
  kind: string
  project: string
  topics: string[]
  life: string
  date: number
  retired: boolean
}

/** A store that can write many rows as one change. The real Store has it; tests may pass one without. */
export interface BatchingStore extends DataStore {
  batch?<T>(work: () => Promise<T>): Promise<T>
}

const TRANSIENT = new Set(['state', 'event'])
const RETIRED = new Set(['retired', 'superseded', 'done', 'archived', 'deleted'])
const MAX_ENTRIES = 50_000

/** The app's kind for a bank kind. Transient kinds map to `event` (only used when the person includes them). */
export function importKind(kind: string): MemoryKind | null {
  const clean = kind.trim().toLowerCase()
  if (clean === 'state' || clean === 'event') return 'event'
  if (clean === 'skill') return 'skill'
  return normaliseKind(clean)
}

export function rowIdFor(sourceId: string): string {
  const clean = sourceId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)
  if (clean !== '' && clean === sourceId) return `import-${clean}`
  return `import-${createHash('sha1').update(sourceId).digest('hex').slice(0, 20)}`
}

/** Reads the export file's text into entries. Throws with a plain message when it is not an export. */
export function parseExport(raw: string): { source: string; entries: ImportEntry[] } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('That file is not JSON.')
  }
  const object = typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  const list = Array.isArray(value) ? value : Array.isArray(object?.['memories']) ? (object?.['memories'] as unknown[]) : null
  if (list === null) throw new Error('That file has no list of memories in it.')
  const source = typeof object?.['source'] === 'string' ? object['source'] : 'a memory bank'
  const entries: ImportEntry[] = []
  for (const raw of list.slice(0, MAX_ENTRIES)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const text = str(item['text']) || str(item['body'])
    const title = str(item['title']) || text.split('\n')[0]?.slice(0, 120) || ''
    const status = str(item['status']).toLowerCase()
    entries.push({
      id: str(item['id']),
      title: title.trim(),
      text: text.trim(),
      kind: str(item['kind']) || 'fact',
      project: str(item['project']),
      topics: Array.isArray(item['topics'])
        ? item['topics'].filter((topic): topic is string => typeof topic === 'string')
        : str(item['topics']).split(',').map((topic) => topic.trim()).filter(Boolean),
      life: str(item['life']),
      date: dateOf(item['date'] ?? item['createdAt'] ?? item['created_at']),
      retired: item['retired'] === true || RETIRED.has(status),
    })
  }
  return { source, entries }
}

interface Planned {
  row: Omit<MemoryRow, 'updatedAt'>
  redacted: number
}

/** What would be written. */
export function planImport(parsed: { source: string; entries: ImportEntry[] }, includeAll: boolean): { preview: MemoryImportPreview; rows: Planned[] } {
  const preview: MemoryImportPreview = {
    ok: true,
    message: '',
    source: parsed.source,
    total: parsed.entries.length,
    byKind: {},
    skippedRetired: 0,
    skippedTransient: 0,
    invalid: 0,
  }
  const rows: Planned[] = []
  const seen = new Set<string>()
  for (const entry of parsed.entries) {
    const kind = importKind(entry.kind)
    if (entry.id === '' || entry.text === '' || entry.title === '' || kind === null || seen.has(entry.id)) {
      preview.invalid += 1
      continue
    }
    if (!includeAll && entry.retired) {
      preview.skippedRetired += 1
      continue
    }
    if (!includeAll && TRANSIENT.has(entry.kind.trim().toLowerCase())) {
      preview.skippedTransient += 1
      continue
    }
    seen.add(entry.id)
    const title = redactSecrets(entry.title.replace(/\s+/g, ' ').slice(0, 200))
    const body = redactSecrets(entry.text)
    const topicList = [entry.project, ...entry.topics, entry.life]
      .map((topic) => topic.trim())
      .filter((topic, index, all) => topic !== '' && topic !== 'global' && all.indexOf(topic) === index)
    const topics = redactSecrets(topicList.slice(0, 12).join(', '))
    rows.push({
      row: {
        id: rowIdFor(entry.id),
        createdAt: entry.date,
        title: title.text,
        body: body.text,
        kind,
        topics: topics.text,
        pinned: false,
        source: 'user',
      },
      redacted: title.total + body.total + topics.total,
    })
    preview.byKind[kind] = (preview.byKind[kind] ?? 0) + 1
  }
  const writing = rows.length
  preview.message =
    writing === 0
      ? 'Nothing in that file to bring in.'
      : `${writing.toLocaleString('en')} ${writing === 1 ? 'memory' : 'memories'} from ${parsed.source}.`
  return { preview, rows }
}

/** Writes the plan. New rows are added, changed ones updated, unchanged ones left alone. */
export async function runImport(store: BatchingStore, raw: string, includeAll: boolean, now: () => number = Date.now): Promise<MemoryImportResult> {
  const started = now()
  const parsed = parseExport(raw)
  const { preview, rows } = planImport(parsed, includeAll)
  const result: MemoryImportResult = { ...preview, added: 0, updated: 0, unchanged: 0, redacted: 0, ms: 0 }
  const work = async (): Promise<void> => {
    const existing = new Map((await store.list('memory')).map((row) => [row.id, row]))
    for (const { row, redacted } of rows) {
      result.redacted += redacted
      const have = existing.get(row.id)
      if (have !== undefined && have.title === row.title && have.body === row.body && have.kind === row.kind && have.topics === row.topics) {
        result.unchanged += 1
        continue
      }
      // A page the person pinned keeps its pin.
      await store.upsert('memory', { ...row, pinned: have?.pinned ?? false })
      if (have === undefined) result.added += 1
      else result.updated += 1
    }
  }
  if (store.batch !== undefined) await store.batch(work)
  else await work()
  result.ms = now() - started
  result.message = `${result.added.toLocaleString('en')} added, ${result.updated.toLocaleString('en')} updated, ${result.unchanged.toLocaleString('en')} already here.`
  return result
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
}

function dateOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}
