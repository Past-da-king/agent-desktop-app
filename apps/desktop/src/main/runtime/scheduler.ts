/**
 * The routine scheduler (PLAN.md M7): every 30 seconds it looks for routines that are due and runs
 * them through the Runner as background ROUTINE runs. It also runs on start and when the computer
 * wakes from sleep, so a slot missed while the app was closed is caught up once, not once per slot.
 *
 * One routine at a time, always. A tick and a "Run now" share one queue, so they can never overlap.
 */
import type { TriggerRow } from '@agent/core'

import type { DataStore } from './data'
import { updateLive } from './data'
import { isLimitFailure, limitRetryLeft, limitWaitMs, waitWords } from './limit-backoff'
import type { RoutineRunResult } from './runner'

/**
 * One slot of a routine as the brain that runs it holds it: `key` is the same on every brain for the same slot
 * (routine id + the slot's time), so a tool or message that supports an idempotency key can dedupe on it; `fence` is the
 * monotonic token the claim authority gave this claim; `verify` asks the authority again that this brain still holds
 * it (checked before the run starts).
 */
export interface RoutineSlot {
  key: string
  fence: number
  verify?: () => Promise<boolean>
}

export interface RoutineRunner {
  runRoutine(trigger: TriggerRow, slot?: { key: string; fence: number }): Promise<RoutineRunResult>
}

/** Called once a routine finishes with a result worth a notification. */
export type RoutineResultNotice = (triggerId: string, name: string, result: string) => void

export interface SchedulerDeps {
  store: DataStore
  runner: RoutineRunner
  /** Tests pin the clock; production uses the real one. */
  now?: () => number
  /** How often the scheduler wakes. Production is 30 seconds. */
  intervalMs?: number
  /** The notification side; the scheduler decides when a result is worth showing. */
  notifyRoutine?: RoutineResultNotice
  /**
   * Runs a built-in routine (TriggerRow.builtin) on "Run now". Its timing belongs to its owner (End of day: the
   * memory service, which also catches up a missed day), so the tick never runs it.
   */
  runBuiltin?: (trigger: TriggerRow) => Promise<RoutineRunResult>
  /** "Run now" on an event routine: its desk looks at what is waiting (workers/router.ts). */
  runEvent?: (trigger: TriggerRow) => Promise<RoutineRunResult>
  /**
   * Devices (s12): every brain holds the same routines, so a due one runs on exactly one of them. False: another
   * brain runs this slot (its lastRunAt arrives by replication). Absent: this brain runs every routine (alone).
   */
  claim?: (trigger: TriggerRow, slotKey: string) => Promise<boolean | RoutineSlot>
  /**
   * Decisions (docs/decisions.md): asked before a routine that opted in (deltaCheck) runs. skip: true skips this run (nothing
   * new); anything else, an error included, runs it as always. Absent: every routine runs.
   */
  precheck?: (trigger: TriggerRow) => Promise<{ skip: boolean; reason: string }>
  /** The zone daily times are read in (an IANA name). Absent: the zone of this computer. */
  timeZone?: string
}

export const SCHEDULER_INTERVAL_MS = 30_000

/** A daily run this late (the app was closed or asleep at its time) is skipped unless the routine says catch up. */
export const CATCH_UP_MS = 15 * 60_000
export const LAST_RESULT_CHARS = 300
export const WAITING_RESULT = 'Waiting for you'

export class Scheduler {
  private readonly store: DataStore
  private readonly runner: RoutineRunner
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly notifyRoutine: RoutineResultNotice
  private readonly runBuiltin: ((trigger: TriggerRow) => Promise<RoutineRunResult>) | null
  private readonly runEvent: ((trigger: TriggerRow) => Promise<RoutineRunResult>) | null
  private readonly claim: ((trigger: TriggerRow, slotKey: string) => Promise<boolean | RoutineSlot>) | null
  private readonly timeZone: string | undefined
  private readonly precheck: ((trigger: TriggerRow) => Promise<{ skip: boolean; reason: string }>) | null
  /** Slots another brain took (claim said no), by routine id, with the lastRunAt they were due at. */
  private readonly elsewhere = new Map<string, number | null>()
  /**
   * Routines whose last run failed because the AI is at its limit (rate limit, quota, plan limit): each is tried
   * again once the wait is over (5 min, 15 min, an hour) instead of failing again on every slot, and the person is
   * told once when it first fails and once if it gives up.
   */
  private readonly limited = new Map<string, { hits: number; retryAt: number }>()

  private timer: ReturnType<typeof setInterval> | null = null
  private chain: Promise<void> = Promise.resolve()
  private pendingTick: Promise<void> | null = null
  private stopped = false

  constructor(deps: SchedulerDeps) {
    this.store = deps.store
    this.runner = deps.runner
    this.now = deps.now ?? Date.now
    this.intervalMs = deps.intervalMs ?? SCHEDULER_INTERVAL_MS
    this.notifyRoutine = deps.notifyRoutine ?? (() => undefined)
    this.runBuiltin = deps.runBuiltin ?? null
    this.runEvent = deps.runEvent ?? null
    this.claim = deps.claim ?? null
    this.timeZone = deps.timeZone
    this.precheck = deps.precheck ?? null
  }

  /** Look for due routines now, then again every interval. Safe to call more than once. */
  start(): void {
    if (this.timer !== null) return
    this.stopped = false
    void this.tick()
    this.timer = setInterval(() => {
      void this.tick()
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** The computer just woke up: catch up immediately rather than waiting for the next wake. */
  resume(): Promise<void> {
    return this.tick()
  }

  /** One pass over every routine. Only one pass runs at a time. */
  tick(): Promise<void> {
    if (this.pendingTick !== null) return this.pendingTick
    const pending = this.doTick().finally(() => {
      if (this.pendingTick === pending) this.pendingTick = null
    })
    this.pendingTick = pending
    return pending
  }

  /** Run one routine on demand, even if it is paused. Queued behind anything already running. */
  async runNow(id: string): Promise<void> {
    const trigger = await this.store.get('trigger', id)
    if (trigger === null) throw new Error('That routine is not there any more.')
    await this.runExclusive(() => this.execute(trigger, true))
  }

  private async doTick(): Promise<void> {
    if (this.stopped) return
    const now = this.now()
    const triggers = await this.store.list('trigger')
    // A slot another brain ran has come back with its result: the person hears it here as if it ran here.
    for (const trigger of triggers) {
      if (!this.elsewhere.has(trigger.id)) continue
      if (trigger.lastRunAt === this.elsewhere.get(trigger.id)) continue
      this.elsewhere.delete(trigger.id)
      if (trigger.lastResult !== '' && trigger.lastResult !== WAITING_RESULT) this.notifyRoutine(trigger.id, trigger.name, trigger.lastResult)
    }
    for (const id of [...this.limited.keys()]) {
      const row = triggers.find((trigger) => trigger.id === id)
      // Deleted, or paused by the person while it waited (a one-off is switched off by its own run): no retry.
      if (row === undefined || (!row.enabled && row.kind !== 'at')) this.limited.delete(id)
    }
    for (const trigger of triggers) {
      if (this.stopped) return
      const waiting = this.limited.get(trigger.id)
      if (waiting !== undefined) {
        // Its slots are not run while it waits for the limit to reset; the retry is its next run.
        if (waiting.retryAt > now) continue
        try {
          await this.runExclusive(() => this.execute(trigger, true))
        } catch {
          // As below: one routine must not stop the pass.
        }
        continue
      }
      if (isBuiltin(trigger) || !trigger.enabled || !isDue(trigger, now, this.timeZone)) continue
      try {
        // The slot is checked again, and claimed, inside the queue: by the time this job reaches the front the routine
        // may have run (by hand, or on another brain) or been paused or deleted.
        await this.runExclusive(() => this.execute(trigger, false))
      } catch {
        // A routine that cannot be recorded must not stop the scheduler for every other routine.
      }
    }
  }

  private async execute(trigger: TriggerRow, force: boolean): Promise<void> {
    // Re-read: it may have been paused or deleted while this run waited its turn.
    const fresh = await this.store.get('trigger', trigger.id)
    if (fresh === null) return
    if (!fresh.enabled && !force) return

    // A tick's job is checked against the row and the clock as they are NOW (a manual run or another brain may have
    // run the slot while this waited in the queue). "Run now" and a limit retry are explicit and skip this.
    let slot: RoutineSlot | null = null
    if (!force) {
      if (isBuiltin(fresh) || !isDue(fresh, this.now(), this.timeZone)) return
      if (this.claim !== null) {
        const claimed = await this.claim(fresh, slotKey(fresh, this.now(), this.timeZone))
        if (claimed === false) {
          this.elsewhere.set(fresh.id, fresh.lastRunAt)
          return
        }
        if (claimed !== true) slot = claimed
      }
      // The authority still says this brain holds the slot: checked before the slot is recorded.
      if (slot?.verify !== undefined && !(await slot.verify())) return
    }

    // The slot is taken the moment the run starts (28 Oct 2026: a run cut off by an update, or killed, left the day's
    // slot open, and the next start ran it again unseen). Whatever happens to this run, this slot never runs again.
    const startedAt = this.now()
    if (!isBuiltin(fresh) && fresh.kind !== 'event') {
      await this.store.upsert('trigger', { id: fresh.id, lastRunAt: startedAt, lastStartedAt: startedAt })
    }

    let outcome: RoutineRunResult
    try {
      if (isBuiltin(fresh)) {
        if (this.runBuiltin === null) throw new Error('That routine can only run from its own page.')
        outcome = await this.runBuiltin(fresh)
      } else if (fresh.kind === 'event') {
        if (this.runEvent === null) throw new Error('Event routines run when their worker sends something.')
        outcome = await this.runEvent(fresh)
      } else {
        const verdict = fresh.deltaCheck === true && this.precheck !== null ? await this.precheck(fresh).catch(() => ({ skip: false, reason: 'error' })) : { skip: false, reason: '' }
        // The fencing token is checked once more right before the run starts, and the slot key goes into the run.
        if (!verdict.skip && slot?.verify !== undefined && !(await slot.verify())) {
          outcome = { text: 'Skipped: another brain holds this slot.', waiting: false, skipped: true }
        } else {
          outcome = verdict.skip
            ? { text: 'Skipped: ' + verdict.reason, waiting: false, skipped: true }
            : await this.runner.runRoutine(fresh, slot === null ? undefined : { key: slot.key, fence: slot.fence })
        }
      }
    } catch (error) {
      outcome = {
        text: error instanceof Error ? error.message || 'The routine could not run.' : 'The routine could not run.',
        waiting: false,
        failed: true,
      }
    }

    const finishedAt = this.now()
    // The run itself failed on the AI's limit: it is tried again after a wait, a few times, and said once.
    const hitLimit = outcome.failed === true && outcome.stopped !== true && !isBuiltin(fresh) && fresh.kind !== 'event' && isLimitFailure(outcome.text)
    const hits = hitLimit ? (this.limited.get(fresh.id)?.hits ?? 0) + 1 : 0
    const retrying = hitLimit && limitRetryLeft(hits)
    if (retrying) this.limited.set(fresh.id, { hits, retryAt: finishedAt + limitWaitMs(hits) })
    else this.limited.delete(fresh.id)
    const again = retrying ? ` It is tried again in ${waitWords(limitWaitMs(hits))}.` : ''
    const result = outcome.waiting
      ? WAITING_RESULT
      : (clip(outcome.text.trim(), LAST_RESULT_CHARS - again.length) || 'No result.') + again

    // Only the run is recorded, on the row as it is now: a pause or an edit made during the run stays, and a routine
    // deleted during the run stays deleted (the store refuses to bring it back). A one-off switches itself off only
    // if it is still the same one-off (not moved to another time meanwhile).
    await updateLive(this.store, 'trigger', fresh.id, (current) => ({
      lastRunAt: finishedAt,
      lastResult: result,
      ...(fresh.kind === 'at' && current.kind === 'at' && current.spec === fresh.spec ? { enabled: false } : {}),
    }))

    // A retry that hit the limit again says nothing: the person was told at the first one.
    if (!outcome.waiting && outcome.skipped !== true && !(retrying && hits > 1)) this.notifyRoutine(fresh.id, fresh.name, result)
  }

  /** One queue for ticks and Run now, so two routines never run at the same time. */
  private runExclusive(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }
}

/** A routine the app runs itself; its owner decides when. */
function isBuiltin(trigger: TriggerRow): boolean {
  return typeof trigger.builtin === 'string' && trigger.builtin !== ''
}

/**
 * Is this routine due at `now`?
 *
 * at: the moment has passed and it has not run since. daily: today's time has passed and it has not
 * run today (so a closed app catches up once today, never once per missed day). interval: enough
 * minutes since the last run, or since it was created when it has never run.
 */
export function isDue(trigger: TriggerRow, now: number, timeZone?: string): boolean {
  switch (trigger.kind) {
    case 'at': {
      const at = Date.parse(trigger.spec)
      if (!Number.isFinite(at) || at > now) return false
      return trigger.lastRunAt === null || trigger.lastRunAt < at
    }
    case 'daily': {
      const minutes = minutesOfDay(trigger.spec)
      if (minutes === null) return false
      const todayAt = dailySlotAt(now, minutes, timeZone)
      if (now < todayAt) return false
      if (trigger.lastRunAt !== null && dayKey(trigger.lastRunAt, timeZone) === dayKey(now, timeZone)) return false
      // Missed by more than a few minutes (closed, asleep): skipped unless it says catch up. A run started today
      // and cut off counts as run (lastRunAt is set as it starts).
      if (now - todayAt > CATCH_UP_MS && trigger.catchUp !== true) return false
      return true
    }
    case 'interval': {
      const minutes = Number(trigger.spec)
      if (!Number.isInteger(minutes) || minutes <= 0) return false
      const anchor = trigger.lastRunAt ?? trigger.createdAt
      return now - anchor >= minutes * 60_000
    }
    // Event routines run when a worker emits (workers/router.ts), never on the clock.
    case 'event':
      return false
    default:
      // A kind from a newer build: leave it alone rather than guess.
      return false
  }
}

/** Minutes after local midnight for "HH:mm", or null when it is not a real time. */
export function minutesOfDay(spec: string): number | null {
  if (!/^\d{1,2}:\d{2}$/.test(spec)) return null
  const [hours, minutes] = spec.split(':').map((part) => Number(part))
  if (hours === undefined || minutes === undefined) return null
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * The key of the slot a routine is due for, the same on every brain: daily is its day and time, a one-off its moment,
 * an interval the run it follows. With the routine id it is the idempotency key of that run.
 */
export function slotKey(trigger: TriggerRow, now: number, timeZone?: string): string {
  switch (trigger.kind) {
    case 'daily':
      return `${dayKey(now, timeZone)}T${trigger.spec}`
    case 'at':
      return trigger.spec
    default:
      return `i${trigger.lastRunAt ?? trigger.createdAt}`
  }
}

interface Wall {
  day: string
  minutes: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

/** The wall clock in `timeZone` (the zone of this computer when absent) at `stamp`: its date and minutes after midnight. */
function wallAt(stamp: number, timeZone?: string): Wall {
  const zone = timeZone ?? ''
  // The computer's zone can change while the app runs (TZ in tests), so it is not cached.
  let format = zone === '' ? undefined : formatters.get(zone)
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-CA', {
      ...(zone === '' ? {} : { timeZone: zone }),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    if (zone !== '') formatters.set(zone, format)
  }
  const parts: Record<string, string> = {}
  for (const part of format.formatToParts(new Date(stamp))) parts[part.type] = part.value
  return { day: `${parts['year']}-${parts['month']}-${parts['day']}`, minutes: Number(parts['hour']) * 60 + Number(parts['minute']) }
}

function dayKey(stamp: number, timeZone?: string): string {
  return wallAt(stamp, timeZone).day
}

/**
 * The moment the local wall clock reads `minutes` after midnight on the day `now` falls on: built from the wall-clock
 * time itself, never by adding elapsed minutes to midnight, so it is right on the days the clock changes. A time the
 * day skips (the spring gap) is the first valid minute after it; a time the day has twice (the fall) is the first one.
 */
export function dailySlotAt(now: number, minutes: number, timeZone?: string): number {
  const today = wallAt(now, timeZone)
  const [year, month, day] = today.day.split('-').map(Number) as [number, number, number]
  // The wanted wall-clock time read as if it were UTC; the zone's offset around it settles the real moment.
  const asUtc = Date.UTC(year, month - 1, day, 0, minutes)
  const offsetAt = (stamp: number): number => {
    const minute = stamp - (((stamp % 60_000) + 60_000) % 60_000)
    const wall = wallAt(minute, timeZone)
    const [y, m, d] = wall.day.split('-').map(Number) as [number, number, number]
    return Date.UTC(y, m - 1, d, 0, wall.minutes) - minute
  }
  const candidates = new Set<number>()
  for (const probe of [asUtc - 86_400_000, asUtc, asUtc + 86_400_000]) {
    const moment = asUtc - offsetAt(probe)
    const wall = wallAt(moment, timeZone)
    if (wall.day === today.day && wall.minutes === minutes) candidates.add(moment)
  }
  if (candidates.size > 0) return Math.min(...candidates)
  // The clock skips this time: the first valid minute at or after it.
  let moment = asUtc - offsetAt(asUtc - 86_400_000)
  for (let step = 0; step < 24 * 60; step += 1) {
    const before = wallAt(moment - 60_000, timeZone)
    if (before.day !== today.day || before.minutes < minutes) break
    moment -= 60_000
  }
  return moment
}

export function startOfLocalDay(stamp: number): number {
  const date = new Date(stamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}
