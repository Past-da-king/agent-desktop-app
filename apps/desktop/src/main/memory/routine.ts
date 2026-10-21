/**
 * End of day as a routine: the memory pass shows on the Routines page like any other routine (name, time, on/off,
 * Run now, last run, delete), but the app runs it, not the agent. It is a default, not a fixture: created once, and
 * once the person deletes it, it stays deleted (on every synced device too). One row with a fixed id, so restarts
 * never make a second one. MemoryService still owns the timing, including catching up a day the app was closed for.
 */
import { MEMORY_DAILY_ROUTINE, type TriggerRow, type UpkeepReport } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { DEFAULT_DAILY_AT, summaryLine } from './daily'

export const DAILY_ROUTINE_NAME = 'End of day'
export const DAILY_ROUTINE_PROMPT =
  'Today\'s chats become one "Where we are" page, and memory is tidied: duplicates merged, stale notes rewritten or dropped.'

/** A routine the app runs itself rather than the agent (its prompt only describes it). */
export function isBuiltinRoutine(row: Pick<TriggerRow, 'builtin'> | null | undefined): boolean {
  return typeof row?.builtin === 'string' && row.builtin !== ''
}

function validClock(value: string): boolean {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  return match !== null && Number(match[1]) <= 23 && Number(match[2]) <= 59
}

/**
 * Create the End of day routine the first time the app runs. A new one takes the old Memory setting: its time, or off
 * when the person had turned it off, and the last report as its last run. An existing one is left as the person set
 * it, and one the person deleted is never brought back (null).
 */
export async function ensureDailyRoutine(
  store: DataStore,
  options: { dailyAt: string; lastReport?: UpkeepReport | null; deleted?: boolean },
): Promise<TriggerRow | null> {
  if (options.deleted === true) return null
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
 * What a change to the app's own routine may touch: its name, its time (a real HH:mm) and on/off. It always runs
 * daily and does the memory pass, so its kind and prompt stay.
 */
export function builtinPatch(row: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = { id: row['id'] }
  if (typeof row['name'] === 'string' && row['name'].trim() !== '') patch['name'] = row['name'].trim()
  if (typeof row['spec'] === 'string' && validClock(row['spec'])) patch['spec'] = row['spec'].trim()
  if (typeof row['enabled'] === 'boolean') patch['enabled'] = row['enabled']
  return patch
}

/**
 * A write from the window: the app's own routine changes only its name, time and on/off; putting a deleted one back
 * (Undo) keeps it the app's own; no other row can claim to be one.
 */
export async function guardRoutineWrite(store: DataStore, row: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = typeof row['id'] === 'string' ? row['id'] : ''
  const existing = id === '' ? null : await store.get('trigger', id)
  if (isBuiltinRoutine(existing)) return builtinPatch(row)
  const { builtin: _builtin, ...rest } = row
  if (existing === null && id === MEMORY_DAILY_ROUTINE) return { ...rest, builtin: MEMORY_DAILY_ROUTINE, kind: 'daily' }
  return rest
}
