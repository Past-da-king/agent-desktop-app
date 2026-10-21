/**
 * End of day as a routine: the memory pass shows on the Routines page like any other routine (time, on/off, Run now,
 * last run), but the app runs it, not the agent. One row with a fixed id, so restarts and other synced devices never
 * make a second one. MemoryService still owns the timing, including catching up a day the app was closed for; this
 * file only keeps the row and reads its time.
 */
import { MEMORY_DAILY_ROUTINE, type TriggerRow, type UpkeepReport } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { DEFAULT_DAILY_AT, summaryLine } from './daily'

export const DAILY_ROUTINE_NAME = 'End of day'
export const DAILY_ROUTINE_PROMPT =
  'Today\'s chats become one "Where we are" page, and memory is tidied: duplicates merged, stale notes rewritten or dropped.'

/** A routine the app runs itself, which only changes its time and on/off. */
export function isBuiltinRoutine(row: Pick<TriggerRow, 'builtin'> | null | undefined): boolean {
  return typeof row?.builtin === 'string' && row.builtin !== ''
}

function validClock(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

/**
 * Make sure the End of day routine exists. A new one takes the old Memory setting: its time, or off when the person
 * had turned it off, and the last report as its last run. An existing one is left as the person set it.
 */
export async function ensureDailyRoutine(
  store: DataStore,
  options: { dailyAt: string; lastReport?: UpkeepReport | null },
): Promise<TriggerRow> {
  const existing = await store.get('trigger', MEMORY_DAILY_ROUTINE)
  if (existing !== null && existing.builtin === MEMORY_DAILY_ROUTINE) return existing
  const setting = options.dailyAt.trim()
  const report = options.lastReport ?? null
  return store.upsert('trigger', {
    id: MEMORY_DAILY_ROUTINE,
    builtin: MEMORY_DAILY_ROUTINE,
    name: DAILY_ROUTINE_NAME,
    kind: 'daily',
    spec: validClock(setting) ? setting : DEFAULT_DAILY_AT,
    prompt: DAILY_ROUTINE_PROMPT,
    enabled: setting !== '',
    lastRunAt: report === null ? null : report.at,
    lastResult: report === null ? '' : resultLine(report),
  })
}

/** The time the pass runs, or '' when the routine is off (or gone). */
export async function dailyRoutineSlot(store: DataStore): Promise<string> {
  const row = await store.get('trigger', MEMORY_DAILY_ROUTINE)
  if (row === null || !row.enabled) return ''
  return validClock(row.spec) ? row.spec : DEFAULT_DAILY_AT
}

export function resultLine(report: UpkeepReport): string {
  return report.ok ? summaryLine(report) : report.message
}

/** After any pass (on time, caught up, or run by hand), the routine shows when it ran and what changed. */
export async function recordDailyRun(store: DataStore, report: UpkeepReport): Promise<void> {
  const row = await store.get('trigger', MEMORY_DAILY_ROUTINE)
  if (row === null) return
  await store.upsert('trigger', { id: row.id, lastRunAt: report.at, lastResult: resultLine(report) })
}

/**
 * What a change to a built-in routine may touch: its time (a real HH:mm) and on/off. Everything else is dropped, so
 * the routine stays the app's own.
 */
export function builtinPatch(row: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { id: row['id'] }
  if (typeof row['spec'] === 'string' && validClock(row['spec'])) patch['spec'] = row['spec'].trim()
  if (typeof row['enabled'] === 'boolean') patch['enabled'] = row['enabled']
  return patch
}

export const BUILTIN_DELETE_REFUSED = 'End of day is built in, so it cannot be deleted. Switch it off instead.'

/** A write from the window: a built-in routine keeps all but its time and on/off, and no other row can claim to be one. */
export async function guardRoutineWrite(store: DataStore, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = typeof row['id'] === 'string' ? row['id'] : ''
  const existing = id === '' ? null : await store.get('trigger', id)
  if (isBuiltinRoutine(existing)) return builtinPatch(row)
  const { builtin: _builtin, ...rest } = row
  return rest
}

/** A delete from the window: refused for a built-in routine. */
export async function guardRoutineRemove(store: DataStore, id: string): Promise<void> {
  if (isBuiltinRoutine(await store.get('trigger', id))) throw new Error(BUILTIN_DELETE_REFUSED)
}
