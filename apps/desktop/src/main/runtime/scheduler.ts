/**
 * The routine scheduler (PLAN.md M7): every 30 seconds it looks for routines that are due and runs
 * them through the Runner as background ROUTINE runs. It also runs on start and when the computer
 * wakes from sleep, so a slot missed while the app was closed is caught up once, not once per slot.
 *
 * One routine at a time, always. A tick and a "Run now" share one queue, so they can never overlap.
 */
import type { TriggerRow } from '@agent/core'

import type { DataStore } from './data'
import type { RoutineRunResult } from './runner'

export interface RoutineRunner {
  runRoutine(trigger: TriggerRow): Promise<RoutineRunResult>
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
}

export const SCHEDULER_INTERVAL_MS = 30_000
export const LAST_RESULT_CHARS = 300
export const WAITING_RESULT = 'Waiting for you'

export class Scheduler {
  private readonly store: DataStore
  private readonly runner: RoutineRunner
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly notifyRoutine: RoutineResultNotice

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
    for (const trigger of triggers) {
      if (this.stopped) return
      if (!trigger.enabled || !isDue(trigger, now)) continue
      try {
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

    let outcome: RoutineRunResult
    try {
      outcome = await this.runner.runRoutine(fresh)
    } catch (error) {
      outcome = {
        text: error instanceof Error ? error.message || 'The routine could not run.' : 'The routine could not run.',
        waiting: false,
      }
    }

    const result = outcome.waiting
      ? WAITING_RESULT
      : clip(outcome.text.trim(), LAST_RESULT_CHARS) || 'No result.'
    const finishedAt = this.now()

    await this.store.upsert('trigger', {
      id: fresh.id,
      lastRunAt: finishedAt,
      lastResult: result,
      // A one-off has done its job. Everything else keeps its own paused/running state.
      enabled: fresh.kind === 'at' ? false : fresh.enabled,
    })

    if (!outcome.waiting) this.notifyRoutine(fresh.id, fresh.name, result)
  }

  /** One queue for ticks and Run now, so two routines never run at the same time. */
  private runExclusive(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => undefined)
    return next
  }
}

/**
 * Is this routine due at `now`?
 *
 * at: the moment has passed and it has not run since. daily: today's time has passed and it has not
 * run today (so a closed app catches up once today, never once per missed day). interval: enough
 * minutes since the last run, or since it was created when it has never run.
 */
export function isDue(trigger: TriggerRow, now: number): boolean {
  switch (trigger.kind) {
    case 'at': {
      const at = Date.parse(trigger.spec)
      if (!Number.isFinite(at) || at > now) return false
      return trigger.lastRunAt === null || trigger.lastRunAt < at
    }
    case 'daily': {
      const minutes = minutesOfDay(trigger.spec)
      if (minutes === null) return false
      const todayAt = startOfLocalDay(now) + minutes * 60_000
      if (now < todayAt) return false
      return trigger.lastRunAt === null || startOfLocalDay(trigger.lastRunAt) !== startOfLocalDay(now)
    }
    case 'interval': {
      const minutes = Number(trigger.spec)
      if (!Number.isInteger(minutes) || minutes <= 0) return false
      const anchor = trigger.lastRunAt ?? trigger.createdAt
      return now - anchor >= minutes * 60_000
    }
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

export function startOfLocalDay(stamp: number): number {
  const date = new Date(stamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}
