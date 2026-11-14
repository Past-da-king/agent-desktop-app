/**
 * The first answer on a card wins (review finding R1, 14 Nov 2026) and a button tap is delivered once (F2).
 *
 * A card (approval or question) is decided ONCE. The decision is claimed in one read-check-write step on the row
 * (Store.mutate: no await between the read and the write, so two requests can never both see it pending); only
 * the claim that wins resumes the waiter or starts a continuation. Another device's decision that arrives by
 * replication is settled by the same rule everywhere (cardWinners): the earlier decision (decisionAt, then the
 * name of who decided) wins on every device, and a decided card is never undone by a write that has no decision.
 */
import type { DataStore } from './data'

/** Not chat-lines' parseMeta: the Store imports this file, and it must not pull the runtime in with it. */
function parseMeta(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {}
  } catch {
    return {}
  }
}

export type CardField = 'decision' | 'answer'

/** What a card was decided with: the value, when, and by which device. */
export interface CardEntry {
  value: string
  at: number
  by: string
}

export type Claim = { won: true; entry: CardEntry } | { won: false; entry: CardEntry }

/** Thrown to the second person: the card is already decided another way. The message is what the UI shows. */
export class CardDecidedError extends Error {
  constructor(
    readonly field: CardField,
    readonly entry: CardEntry,
  ) {
    super(`already ${field === 'decision' ? 'decided' : 'answered'}: ${entry.value}${entry.by === '' ? '' : ` by ${entry.by}`}`)
    this.name = 'CardDecidedError'
  }
}

const FIELDS: readonly CardField[] = ['decision', 'answer']

function entryOf(meta: Record<string, unknown>, field: CardField): CardEntry | null {
  const value = meta[field]
  if (typeof value !== 'string' || value === '') return null
  const at = meta[`${field}At`]
  const by = meta[`${field}By`]
  return { value, at: typeof at === 'number' ? at : 0, by: typeof by === 'string' ? by : '' }
}

/** Earlier wins; at the same instant the lower name; at the same name the lower value (so every device agrees). */
function earlier(a: CardEntry, b: CardEntry): boolean {
  if (a.at !== b.at) return a.at < b.at
  if (a.by !== b.by) return a.by < b.by
  return a.value <= b.value
}

function metaOfPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return typeof payload['meta'] === 'string' ? parseMeta(payload['meta']) : {}
}

/**
 * Replication: the entries that win where the two copies of a card differ on a decision or an answer, or null when
 * they agree. Run the same way on both sides, so both end with the same one.
 */
export function cardWinners(entity: string, ours: Record<string, unknown>, theirs: Record<string, unknown>): Partial<Record<CardField, CardEntry>> | null {
  if (entity !== 'chat_item') return null
  if ((ours['kind'] !== 'approval' && ours['kind'] !== 'question') || ours['kind'] !== theirs['kind']) return null
  const mine = metaOfPayload(ours)
  const other = metaOfPayload(theirs)
  let winners: Partial<Record<CardField, CardEntry>> | null = null
  for (const field of FIELDS) {
    const a = entryOf(mine, field)
    const b = entryOf(other, field)
    if (a === null && b === null) continue
    if (a !== null && b !== null && a.value === b.value && a.at === b.at && a.by === b.by) continue
    const winner = a === null ? b : b === null ? a : earlier(a, b) ? a : b
    if (winner === null) continue
    winners = { ...(winners ?? {}), [field]: winner }
  }
  return winners
}

/** A copy of the row's payload whose meta carries the winning entries. */
export function withWinners(payload: Record<string, unknown>, winners: Partial<Record<CardField, CardEntry>>): Record<string, unknown> {
  const meta = metaOfPayload(payload)
  for (const field of FIELDS) {
    const entry = winners[field]
    if (entry === undefined) continue
    meta[field] = entry.value
    meta[`${field}At`] = entry.at
    meta[`${field}By`] = entry.by
  }
  return { ...payload, meta: JSON.stringify(meta) }
}

// ---- local claims ------------------------------------------------------------------------------------------------

const chains = new Map<string, Promise<unknown>>()

/** One at a time per key, for a store with no atomic mutate (a small fake). The real Store never needs it. */
async function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = chains.get(key) ?? Promise.resolve()
  const run = before.then(work, work)
  const tail = run.catch(() => undefined)
  chains.set(key, tail)
  try {
    return await run
  } finally {
    if (chains.get(key) === tail) chains.delete(key)
  }
}

type Step<R> = (payload: Record<string, unknown>) => { next: Record<string, unknown> | null; result: R }

/** Read, decide and write one chat row as one step. null: the row is gone. */
async function mutateRow<R>(store: DataStore, id: string, step: Step<R>): Promise<R | null> {
  if (store.mutate !== undefined) return store.mutate('chat_item', id, step)
  return serial(`chat_item:${id}`, async () => {
    const row = await store.get('chat_item', id)
    if (row === null) return null
    const { next, result } = step({ ...row })
    if (next !== null) await store.upsert('chat_item', { id: row.id, kind: row.kind, text: row.text, meta: String(next['meta'] ?? '{}') })
    return result
  })
}

/**
 * Claim the decision (or the answer) of a card. Won: this request is the first and must resume the waiter or start
 * the continuation. Not won: the entry already there says what the card shows; nothing may be started.
 */
export async function claimCard(store: DataStore, id: string, field: CardField, value: string, by: string, now: number): Promise<Claim | null> {
  return mutateRow<Claim>(store, id, (payload) => {
    const meta = metaOfPayload(payload)
    const existing = entryOf(meta, field)
    if (existing !== null) return { next: null, result: { won: false, entry: existing } }
    const entry: CardEntry = { value, at: now, by }
    meta[field] = value
    meta[`${field}At`] = now
    meta[`${field}By`] = by
    return { next: { ...payload, meta: JSON.stringify(meta) }, result: { won: true, entry } }
  })
}

// ---- taps --------------------------------------------------------------------------------------------------------

/** Taps remembered per message, and how long a tap with no id from an old client counts as the same tap. */
export const TAPS_KEPT = 50
export const LEGACY_TAP_WINDOW_MS = 10_000

/**
 * Record a button tap and say whether it is new. Record and check are one step, so a retry (a phone reconnecting,
 * a double delivery, the same call after a restart) of the same tap id is a duplicate and dispatches nothing.
 * Without an id (an old client) the same words on the same message within LEGACY_TAP_WINDOW_MS are one tap: a
 * safe fallback that never loses a deliberate second tap a few seconds later. null: the message is gone.
 */
export async function claimTap(store: DataStore, id: string, message: string, tapId: string, now: number): Promise<boolean | null> {
  const key = tapId === '' ? `legacy:${message}` : `id:${tapId}`
  return mutateRow<boolean>(store, id, (payload) => {
    const meta = metaOfPayload(payload)
    const seen = typeof meta['tapSeen'] === 'object' && meta['tapSeen'] !== null && !Array.isArray(meta['tapSeen']) ? { ...(meta['tapSeen'] as Record<string, number>) } : {}
    const before = seen[key]
    const duplicate = typeof before === 'number' && (tapId !== '' || now - before < LEGACY_TAP_WINDOW_MS)
    if (duplicate) return { next: null, result: false }
    seen[key] = now
    const recent = Object.entries(seen)
      .sort((a, b) => a[1] - b[1])
      .slice(-TAPS_KEPT)
    meta['tapSeen'] = Object.fromEntries(recent)
    const taps = Array.isArray(meta['taps']) ? meta['taps'].filter((t): t is string => typeof t === 'string') : []
    if (!taps.includes(message)) meta['taps'] = [...taps, message].slice(-TAPS_KEPT)
    return { next: { ...payload, meta: JSON.stringify(meta) }, result: true }
  })
}
