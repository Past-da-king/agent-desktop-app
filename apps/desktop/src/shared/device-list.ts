/**
 * What a linked device is sent when it lists rows. A phone asks for `chat_item` on every connect; the whole table is
 * hundreds of megabytes on an install that has run for weeks, and one frame that size holds the event loop long enough
 * that the device's pings go unanswered and it drops the link. A device therefore gets the recent rows of each chat,
 * every card still waiting for an answer, and the helpers working now; other kinds are capped by count and size.
 * Pure, so the store query, the handler and the tests share one definition.
 */

/** Rows of each chat (the main chat and every project chat) a device gets, newest last. */
export const DEVICE_CHAT_ROWS = 400
/** Any other list a device asks for is cut to its newest rows, at most this many ... */
export const DEVICE_MAX_ROWS = 2_000
/** ... and at most this many bytes of JSON. */
export const DEVICE_MAX_BYTES = 4_000_000
/** A helper row older than this that never said it ended is not "working now". */
export const DEVICE_HELPER_MAX_AGE_MS = 3 * 24 * 3_600_000

function metaOf(row: { meta?: unknown }): Record<string, unknown> {
  if (typeof row.meta !== 'string') return {}
  try {
    const value: unknown = JSON.parse(row.meta)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** A question nobody answered or an approval nobody decided. */
export function isOpenCard(row: { kind?: unknown; meta?: unknown }): boolean {
  if (row.kind === 'question') return typeof metaOf(row)['answer'] !== 'string' || metaOf(row)['answer'] === ''
  if (row.kind === 'approval') return typeof metaOf(row)['decision'] !== 'string' || metaOf(row)['decision'] === ''
  return false
}

/** A helper's own row while it is still working (the phone's helper cards read it). */
export function isLiveHelper(row: { kind?: unknown; meta?: unknown; createdAt?: unknown }, now: number): boolean {
  if (row.kind !== 'helper') return false
  const state = metaOf(row)['state']
  if (state === 'done' || state === 'failed' || state === 'stopped') return false
  return typeof row.createdAt !== 'number' || now - row.createdAt <= DEVICE_HELPER_MAX_AGE_MS
}

/**
 * The newest of `rows` (oldest first) that fit the caps; the order is kept. A row `keep` names (a card still waiting
 * for an answer) is never cut, however old.
 */
export function boundRows<T>(rows: readonly T[], keep: (row: T) => boolean = () => false, maxRows = DEVICE_MAX_ROWS, maxBytes = DEVICE_MAX_BYTES): T[] {
  const out: T[] = []
  let bytes = 0
  let cut = false
  for (let at = rows.length - 1; at >= 0; at -= 1) {
    const row = rows[at] as T
    if (keep(row)) {
      out.push(row)
      continue
    }
    if (cut || out.length >= maxRows) {
      cut = true
      continue
    }
    bytes += JSON.stringify(row).length + 1
    if (bytes > maxBytes) {
      cut = true
      continue
    }
    out.push(row)
  }
  return cut ? out.reverse() : (rows as T[])
}
