/**
 * A row as the window lists it. A chat row's run record can hold 24 KB of command output; the list and the change
 * events carry only its head, and the full row is fetched by id when the person opens that step (data.get).
 * Everything else goes through as it is.
 */
import type { EntityName } from '@agent/core'

/** Characters of output kept in a listed row. */
export const LIGHT_HEAD = 240
export const LIGHT_INPUT = 2_000

export function lightRow<T>(entity: EntityName, row: T): T {
  if (entity !== 'chat_item') return row
  const meta = (row as Record<string, unknown>)['meta']
  if (typeof meta !== 'string' || !meta.includes('"run"')) return row
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(meta)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return row
    parsed = value as Record<string, unknown>
  } catch {
    return row
  }
  const run = parsed['run']
  if (typeof run !== 'object' || run === null || Array.isArray(run)) return row
  const r = run as Record<string, unknown>
  const cut = (key: string, cap: number): boolean => {
    const value = r[key]
    if (typeof value !== 'string' || value.length <= cap) return false
    r[key] = value.slice(0, cap)
    return true
  }
  const trimmed = [cut('stdout', LIGHT_HEAD), cut('stderr', LIGHT_HEAD), cut('input', LIGHT_INPUT)].some(Boolean)
  if (!trimmed) return row
  return { ...row, meta: JSON.stringify({ ...parsed, run: { ...r, more: true } }) } as T
}
