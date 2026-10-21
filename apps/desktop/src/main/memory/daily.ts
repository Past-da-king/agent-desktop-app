/**
 * The end-of-day memory pass, built on the chat filer:
 * 1. COMPILE: today's chats become one pinned "Where we are" page (goals, what got done, open threads, next steps),
 *    replacing yesterday's. Earlier days stay in the upkeep file as history. Durable entries found on the way are
 *    filed like a New Chat would file them.
 * 2. SWEEP: near-duplicate pages are merged, and recent agent-written pages are reviewed so stale ones are rewritten
 *    and noise (transient notes, things no longer true) is dropped. Every change is logged with the page as it was,
 *    so any change can be undone.
 */
import { randomUUID } from 'node:crypto'

import type { ChatItem, GoalRow, MemoryRow, TaskRow } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { terms } from '../runtime/recall'
import { chatSegments, clip, spokenRows, transcript } from './chats'
import { mostlySecret, redactSecrets } from './redact'
import {
  EXCERPT,
  fileEntries,
  mergeBodies,
  mergeTopics,
  parseDigest,
  titleKey,
  type Complete,
} from './summarise'
import type { UpkeepChange, UpkeepFile, UpkeepReport } from './upkeep-log'

export const WHERE_ID = 'where-we-are'
export const WHERE_TITLE = 'Where we are'
export const DEFAULT_DAILY_AT = '23:30'
const MAX_MERGES = 50
const MAX_REVIEW = 30

export interface DailyDeps {
  store: DataStore
  complete: Complete
  upkeep: UpkeepFile
  now?: () => number
}

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function startOfDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** "HH:mm" to minutes after midnight; anything else falls back to 23:30. */
export function slotMinutes(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (match === null) return 23 * 60 + 30
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return 23 * 60 + 30
  return hours * 60 + minutes
}

/**
 * Which day is due, if any. Today once its slot has passed; or a missed earlier day (the app was closed at the slot)
 * when chats happened after the last run. Null when nothing is due.
 */
export function dueDay(now: number, slot: string, lastDay: string, lastChatAt: number): { day: string; from: number; to: number; catchUp: boolean } | null {
  const today = startOfDay(now)
  const minutes = (now - today) / 60_000
  if (minutes >= slotMinutes(slot) && lastDay !== dayKey(now)) {
    return { day: dayKey(now), from: today, to: now, catchUp: false }
  }
  // The slot was missed: compile the last day that had chats, once.
  if (lastChatAt > 0 && lastChatAt < today) {
    const day = dayKey(lastChatAt)
    if (day > lastDay) return { day, from: startOfDay(lastChatAt), to: today, catchUp: true }
  }
  return null
}

export const WHERE_SYSTEM = [
  "You write the user's \"Where we are\" page: ONE solid continuation note so tomorrow's fresh chat picks up exactly where today left off.",
  '',
  'Reply with ONLY one JSON object, no prose and no code fence:',
  '{"where": "the page, in markdown", "memories": [{"kind": "...", "title": "...", "body": "...", "topics": "...", "update": "id or empty"}]}',
  '',
  'The page has these four short sections, as bold labels with bullets:',
  '**Goals** what the user is working towards right now.',
  '**Done today** what actually got done (outcomes, not steps).',
  '**Open threads** what is unfinished or waiting on someone, with who and what.',
  '**Next steps** the concrete next actions, most important first.',
  '',
  'Carry forward anything from the previous page that is still open; drop what is finished or no longer true. Full names and absolute dates. At most 1800 characters. No secrets (passwords, keys, tokens, codes), ever.',
  '"memories" holds durable knowledge from today worth its own page (kinds: person, organisation, project, how-to, decision, preference, fact; each body self-contained). Empty is fine.',
].join('\n')

export const SWEEP_SYSTEM = [
  "You keep the user's long-term memory clean. You are shown recent entries and the current \"Where we are\" page.",
  'Reply with ONLY one JSON object: {"changes": [{"id": "...", "action": "drop" | "rewrite", "body": "new full body, for rewrite", "reason": "a few words"}]}',
  '- drop: transient notes (the progress of a task, state that was only true that day), chit-chat, guesses, or a fact that is no longer true.',
  '- rewrite: an entry that is messy, stale or contradicted by something newer. Write the full clean body: self-contained, full names, absolute dates, every still-true fact kept.',
  '- Leave good entries out of the list. When unsure, leave it. No secrets ever.',
].join('\n')

function todayChats(items: ChatItem[], from: number, to: number): string[] {
  const out: string[] = []
  for (const segment of chatSegments(items)) {
    const inDay = { ...segment, items: segment.items.filter((item) => item.createdAt >= from && item.createdAt < to) }
    if (spokenRows(inDay).length === 0) continue
    out.push(transcript(inDay, 12_000, 1_500))
  }
  return out
}

function goalLines(goals: GoalRow[], tasks: TaskRow[]): string {
  const open = goals.filter((goal) => goal.status === 'open').map((goal) => `- Goal: ${goal.title}`)
  const todo = tasks.filter((task) => task.status !== 'done').slice(0, 25).map((task) => `- Task [${task.status}${task.owner === 'user' ? ", user's" : ''}]: ${task.title}`)
  const lines = [...open, ...todo]
  return lines.length === 0 ? '(none)' : lines.join('\n')
}

function logChange(action: UpkeepChange['action'], memoryId: string, title: string, before: MemoryRow | null, reason: string, at: number): UpkeepChange {
  return { id: randomUUID(), at, action, memoryId, title, reason, before }
}

/** Step 1: today's chats into the "Where we are" page. Returns the changes made, or null when there was nothing. */
export async function compileDay(deps: DailyDeps, window: { day: string; from: number; to: number }): Promise<{ changes: UpkeepChange[]; chats: number; filed: number; body: string } | null> {
  const now = (deps.now ?? Date.now)()
  const items = await deps.store.list('chat_item')
  const chats = todayChats(items, window.from, window.to)
  if (chats.length === 0) return null

  const previous = await deps.store.get('memory', WHERE_ID)
  const memories = await deps.store.list('memory')
  const prompt = [
    `Today is ${window.day}.`,
    '',
    'PREVIOUS "WHERE WE ARE" PAGE:',
    previous === null ? '(none yet)' : previous.body,
    '',
    'OPEN GOALS AND TASKS:',
    goalLines(await deps.store.list('goal'), await deps.store.list('task')),
    '',
    'EXISTING ENTRIES (may be updated):',
    ...memories
      .filter((row) => row.id !== WHERE_ID)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12)
      .map((row) => `- id ${row.id} [${row.kind}] ${row.title}: ${clip(row.body.replace(/\s+/g, ' '), 400)}`),
    '',
    `TODAY'S CHATS (${chats.length}):`,
    clip(chats.join('\n\n---\n\n'), 40_000),
  ].join('\n')

  const reply = await deps.complete(WHERE_SYSTEM, prompt)
  const where = parseWhere(reply)
  const changes: UpkeepChange[] = []
  const body = redactSecrets(where.body).text.trim()
  if (body.length < 20) throw new Error('The model wrote an empty "Where we are" page.')

  await deps.store.upsert('memory', {
    id: WHERE_ID,
    title: WHERE_TITLE,
    body,
    kind: 'project',
    topics: `continuation, daily, ${window.day}`,
    pinned: true,
    source: 'agent',
  })
  changes.push(logChange('where', WHERE_ID, WHERE_TITLE, previous, `Compiled from ${chats.length} ${chats.length === 1 ? 'chat' : 'chats'} on ${window.day}`, now))

  const before = new Map((await deps.store.list('memory')).map((row) => [row.id, row]))
  const filed = await fileEntries(deps.store, where.entries)
  for (const id of [...filed.added, ...filed.updated]) {
    const row = await deps.store.get('memory', id)
    changes.push(logChange('filed', id, row?.title ?? id, before.get(id) ?? null, filed.added.includes(id) ? 'New page from today' : 'Updated from today', now))
  }
  return { changes, chats: chats.length, filed: filed.added.length + filed.updated.length, body }
}

export function parseWhere(reply: string): { body: string; entries: ReturnType<typeof parseDigest>['entries'] } {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
      const body = typeof value['where'] === 'string' ? value['where'] : ''
      return { body, entries: parseDigest(reply).entries }
    } catch {
      // Fall through: a plain markdown reply is still a page.
    }
  }
  return { body: reply.trim(), entries: [] }
}

/** Near-duplicate groups: same kind and the same subject by title. The newest page of each group comes first. */
export function duplicateGroups(memories: MemoryRow[]): MemoryRow[][] {
  const pool = memories
    .filter((row) => !row.pinned && row.id !== WHERE_ID)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const termSets = new Map(pool.map((row) => [row.id, terms(row.title)]))
  const used = new Set<string>()
  const groups: MemoryRow[][] = []
  for (const row of pool) {
    if (used.has(row.id)) continue
    const key = titleKey(row.title)
    const mine = termSets.get(row.id) ?? new Set<string>()
    const group = [row]
    for (const other of pool) {
      if (other.id === row.id || used.has(other.id) || other.kind !== row.kind) continue
      const theirs = termSets.get(other.id) ?? new Set<string>()
      let same = titleKey(other.title) === key && key !== ''
      if (!same && mine.size >= 2 && theirs.size >= 2) {
        let shared = 0
        for (const word of mine) if (theirs.has(word)) shared += 1
        same = shared / (mine.size + theirs.size - shared) >= 0.8
      }
      if (same) group.push(other)
    }
    if (group.length > 1) {
      group.forEach((item) => used.add(item.id))
      groups.push(group)
    }
  }
  return groups
}

/** Step 2a: merge near-duplicates into the newest page of each group; the others are dropped (soft, logged). */
export async function mergeDuplicates(deps: DailyDeps): Promise<UpkeepChange[]> {
  const now = (deps.now ?? Date.now)()
  const changes: UpkeepChange[] = []
  const groups = duplicateGroups(await deps.store.list('memory')).slice(0, MAX_MERGES)
  for (const [keep, ...rest] of groups) {
    if (keep === undefined) continue
    let body = keep.body
    let topics = keep.topics
    for (const other of rest) {
      body = mergeBodies(body, other.body)
      topics = mergeTopics(topics, other.topics)
    }
    if (body !== keep.body || topics !== keep.topics) {
      await deps.store.upsert('memory', { id: keep.id, title: keep.title, body, kind: keep.kind, topics, pinned: keep.pinned, source: keep.source })
      changes.push(logChange('merged', keep.id, keep.title, keep, `Merged ${rest.length} near-duplicate ${rest.length === 1 ? 'page' : 'pages'} into it`, now))
    }
    for (const other of rest) {
      await deps.store.remove('memory', other.id)
      changes.push(logChange('dropped', other.id, other.title, other, `Duplicate of "${clip(keep.title, 60)}"`, now))
    }
  }
  return changes
}

/** Step 2b: the model reviews recent agent-written pages; stale ones are rewritten, noise dropped. */
export async function reviewRecent(deps: DailyDeps, since: number, whereBody: string): Promise<UpkeepChange[]> {
  const now = (deps.now ?? Date.now)()
  const memories = await deps.store.list('memory')
  const recent = memories
    .filter((row) => row.source === 'agent' && !row.pinned && row.id !== WHERE_ID && row.updatedAt >= since)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_REVIEW)
  if (recent.length === 0) return []

  const prompt = [
    'CURRENT "WHERE WE ARE" PAGE:',
    whereBody === '' ? '(none)' : whereBody,
    '',
    'ENTRIES TO REVIEW:',
    ...recent.map((row) => `- id ${row.id} [${row.kind}] ${row.title}: ${clip(row.body.replace(/\s+/g, ' '), EXCERPT)}`),
  ].join('\n')
  const reply = await deps.complete(SWEEP_SYSTEM, prompt)
  const changes: UpkeepChange[] = []
  for (const change of parseSweep(reply)) {
    const row = recent.find((item) => item.id === change.id)
    if (row === undefined) continue
    if (change.action === 'drop') {
      await deps.store.remove('memory', row.id)
      changes.push(logChange('dropped', row.id, row.title, row, change.reason || 'No longer useful', now))
      continue
    }
    const clean = redactSecrets(change.body)
    if (clean.text.trim().length < 20 || mostlySecret(change.body, clean.text)) continue
    // A rewrite of a page the model only saw part of keeps the rest.
    const body = row.body.length > EXCERPT ? mergeBodies(clean.text.trim(), row.body) : clean.text.trim()
    if (body === row.body) continue
    await deps.store.upsert('memory', { id: row.id, title: row.title, body, kind: row.kind, topics: row.topics, pinned: row.pinned, source: row.source })
    changes.push(logChange('rewritten', row.id, row.title, row, change.reason || 'Cleaned up', now))
  }
  return changes
}

export function parseSweep(reply: string): Array<{ id: string; action: 'drop' | 'rewrite'; body: string; reason: string }> {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  try {
    const value = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>
    const list = Array.isArray(value['changes']) ? value['changes'] : []
    return list.flatMap((raw) => {
      if (typeof raw !== 'object' || raw === null) return []
      const item = raw as Record<string, unknown>
      const action = item['action']
      if (action !== 'drop' && action !== 'rewrite') return []
      const id = typeof item['id'] === 'string' ? item['id'] : ''
      if (id === '') return []
      return [{ id, action, body: typeof item['body'] === 'string' ? item['body'] : '', reason: typeof item['reason'] === 'string' ? clip(item['reason'], 160) : '' }]
    })
  } catch {
    return []
  }
}

/** The whole pass: compile, merge, review. Writes the report and the log. Never throws. */
export async function runDaily(
  deps: DailyDeps,
  trigger: UpkeepReport['trigger'],
  window: { day: string; from: number; to: number },
): Promise<UpkeepReport> {
  const now = (deps.now ?? Date.now)()
  const state = deps.upkeep.read()
  const report: UpkeepReport = { at: now, trigger, ok: true, message: '', day: '', chats: 0, filed: 0, merged: 0, rewritten: 0, dropped: 0, changes: [] }
  const problems: string[] = []

  const previousRow = await deps.store.get('memory', WHERE_ID)
  let whereBody = previousRow?.body ?? ''
  const previousWhere = whereBody
  try {
    const compiled = await compileDay(deps, window)
    if (compiled !== null) {
      report.day = window.day
      report.chats = compiled.chats
      report.filed = compiled.filed
      report.changes.push(...compiled.changes)
      whereBody = compiled.body
    }
  } catch (error) {
    problems.push(`Could not write "Where we are": ${messageOf(error)}`)
  }

  try {
    const merged = await mergeDuplicates(deps)
    report.changes.push(...merged)
  } catch (error) {
    problems.push(`Could not merge duplicates: ${messageOf(error)}`)
  }

  try {
    const since = state.lastRunAt > 0 ? state.lastRunAt - 60_000 : now - 3 * 86_400_000
    report.changes.push(...(await reviewRecent(deps, since, whereBody)))
  } catch (error) {
    problems.push(`Could not review recent pages: ${messageOf(error)}`)
  }

  report.merged = report.changes.filter((change) => change.action === 'merged').length
  report.rewritten = report.changes.filter((change) => change.action === 'rewritten').length
  report.dropped = report.changes.filter((change) => change.action === 'dropped').length
  report.ok = problems.length === 0
  report.message = problems.length > 0 ? problems.join(' ') : summaryLine(report)

  deps.upkeep.update((next) => {
    if (report.day !== '') {
      next.lastDay = report.day > next.lastDay ? report.day : next.lastDay
      if (previousWhere !== '' && previousWhere !== whereBody) {
        next.history.push({ day: dayOfPage(previousRow) || state.lastDay || 'earlier', body: previousWhere })
      }
    } else if (problems.length === 0) {
      // Nothing to compile still counts as the day being done.
      next.lastDay = window.day > next.lastDay ? window.day : next.lastDay
    }
    next.lastRunAt = now
    next.report = report
    next.log.push(...report.changes)
  })
  return report
}

export function summaryLine(report: UpkeepReport): string {
  const parts: string[] = []
  if (report.day !== '') parts.push(`"Where we are" updated from ${report.chats} ${report.chats === 1 ? 'chat' : 'chats'}`)
  if (report.filed > 0) parts.push(`${report.filed} ${report.filed === 1 ? 'page' : 'pages'} filed`)
  if (report.merged > 0) parts.push(`${report.merged} merged`)
  if (report.rewritten > 0) parts.push(`${report.rewritten} rewritten`)
  if (report.dropped > 0) parts.push(`${report.dropped} dropped`)
  return parts.length === 0 ? 'Memory is already clean. Nothing changed.' : `${parts.join(', ')}.`
}

/** Puts a logged change back: the page returns to how it was (a created page is removed). */
export async function undoChange(store: DataStore, upkeep: UpkeepFile, changeId: string): Promise<boolean> {
  const state = upkeep.read()
  const change = state.log.find((item) => item.id === changeId)
  if (change === undefined || change.undone === true) return false
  if (change.before === null) await store.remove('memory', change.memoryId)
  else await store.upsert('memory', { ...change.before })
  upkeep.update((next) => {
    const entry = next.log.find((item) => item.id === changeId)
    if (entry !== undefined) entry.undone = true
    const shown = next.report?.changes.find((item) => item.id === changeId)
    if (shown !== undefined) shown.undone = true
  })
  return true
}

/** The day a "Where we are" page covers, from its topics. */
export function dayOfPage(row: MemoryRow | null): string {
  if (row === null) return ''
  return /\d{4}-\d{2}-\d{2}/.exec(row.topics)?.[0] ?? ''
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
