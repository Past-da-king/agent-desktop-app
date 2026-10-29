/**
 * Wake-ups (docs/plans/wake-ups.md, 29 Oct 2026): when something needs the person NOW, his devices ring until he
 * answers. This file is the pure model, shared by the main process, the headless node and the renderer; no I/O, the
 * clock is passed in, so every rule is tested on a fake clock.
 *
 * Rows (entity `wakeup`, synced like every row) are each written by one writer, so last-writer-wins can never undo
 * an answer:
 *   kind 'wake'    the wake itself, written by the agent tool (wake_me) and changed only by it (dedupe, withdraw)
 *   kind 'ack'     id `<wake>:ack`, written by the device he answered on ("I'm on it"). Terminal.
 *   kind 'snooze'  id `<wake>:snooze:<n>`, the n-th snooze, with the time it rings again
 *   kind 'seen'    id `<wake>:seen:<device>`, a device has it and is ringing (delivery proof)
 * The state is folded from them: acked, withdrawn, snoozed (until), ringing (from `at`), or pending (before `at`).
 *
 * It never stops by itself: no timeout. A wake that was already ringing when its source went away (a cancelled
 * meeting) keeps ringing, marked cancelled, until he answers. No agent tool can answer or silence one.
 *
 * Generic: what triggers a wake (meetings, messages, mail, anything) is the agents' and routines' call, not code.
 */
import type { WakeupRow } from '@agent/core'

export type WakeSeverity = 'critical' | 'urgent' | 'heads_up'
export type WakeDevices = 'auto' | 'here' | 'all'
export type WakeState = 'pending' | 'ringing' | 'snoozed' | 'acked' | 'withdrawn'

export const SEVERITIES: readonly WakeSeverity[] = ['critical', 'urgent', 'heads_up']
export const DEVICE_CHOICES: readonly WakeDevices[] = ['auto', 'here', 'all']

/** Urgent rings where he is first; every other device joins after this long without an answer. */
export const ESCALATE_AFTER_MS = 60_000
/** A device a wake was sent to that has not said it has it after this long: every device rings. */
export const DELIVERY_WAIT_MS = 30_000
/** The same dedupe key within this window merges into the wake that is there (no double ring). */
export const DEDUPE_WINDOW_MS = 10 * 60_000
/** At most this many wakes per source in RATE_WINDOW_MS; more are refused with a log line. */
export const RATE_LIMIT = 5
export const RATE_WINDOW_MS = 10 * 60_000
/** A wake can be booked at most this far ahead. */
export const MAX_AHEAD_MS = 14 * 24 * 60 * 60_000
/** Rows kept for the Wake-ups log. */
export const KEEP_MS = 30 * 24 * 60 * 60_000
export const DEFAULT_SNOOZE_MINUTES = 5
export const TITLE_MAX = 140
export const WHAT_MAX = 600
/** A heads-up rings one cycle a minute (the screen stays up); critical and urgent ring without a break. */
export const HEADS_UP_CYCLE_MS = 60_000

/**
 * The colour of each severity: the app's own light-theme tokens (renderer/styles/tokens.css --err, --tert, --ok), edge to
 * edge with white text in both themes so it reads the same at 3 am as at noon (test/wakeups-ui.test.ts keeps parity).
 */
export const SEVERITY_LOOK: Record<WakeSeverity, { label: string; token: string; bg: string; on: string }> = {
  critical: { label: 'Critical', token: '--err', bg: '#B3261E', on: '#FFFFFF' },
  urgent: { label: 'Urgent', token: '--tert', bg: '#8A5100', on: '#FFFFFF' },
  heads_up: { label: 'Heads-up', token: '--ok', bg: '#1E6B3A', on: '#FFFFFF' },
}

export interface WakeSource {
  kind: string
  ref: string
  link: string
}

/** A wake with its folded state, what every device and the log work from. */
export interface WakeView {
  id: string
  severity: WakeSeverity
  title: string
  whatToDo: string
  source: WakeSource
  devices: WakeDevices
  /** Device ids it was sent to first (empty: every device). */
  targets: string[]
  dedupeKey: string
  /** When it was booked to ring first. */
  at: number
  /** When it rings (or rang) this time: `at`, or the end of the latest snooze. */
  ringAt: number
  state: WakeState
  cancelled: boolean
  firedBy: string
  firedOn: string
  createdAt: number
  updatedAt: number
  ackedAt: number | null
  ackedBy: string
  snoozes: number
  /** Devices that said they have it (ringing), with when. */
  seen: Record<string, number>
  /** Times a repeat fire merged into it (dedupe). */
  repeats: number
}

/** A device that can ring: a computer with the app, or a phone. Servers never ring. */
export interface Ringer {
  id: string
  name: string
  kind: 'desktop' | 'phone' | 'tablet' | 'server'
}

// ---- reading rows ------------------------------------------------------------------------------------------------

export function isSeverity(value: unknown): value is WakeSeverity {
  return typeof value === 'string' && (SEVERITIES as readonly string[]).includes(value)
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function sourceOf(value: unknown): WakeSource {
  const v = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  return { kind: str(v['kind']) || 'agent', ref: str(v['ref']), link: str(v['link']) }
}

/** Every wake folded with its answers, newest first. */
export function foldWakes(rows: readonly WakeupRow[], now: number): WakeView[] {
  const byWake = new Map<string, WakeupRow[]>()
  const wakes: WakeupRow[] = []
  for (const row of rows) {
    if (row.kind === 'wake') wakes.push(row)
    else if (str(row.wake) !== '') {
      const list = byWake.get(row.wake) ?? []
      list.push(row)
      byWake.set(row.wake, list)
    }
  }
  return wakes.map((wake) => foldOne(wake, byWake.get(wake.id) ?? [], now)).sort((a, b) => b.createdAt - a.createdAt)
}

export function foldOne(wake: WakeupRow, related: readonly WakeupRow[], now: number): WakeView {
  const ack = related.find((row) => row.kind === 'ack') ?? null
  const snoozes = related.filter((row) => row.kind === 'snooze').sort((a, b) => num(a.n) - num(b.n) || num(a.until) - num(b.until))
  const last = snoozes[snoozes.length - 1]
  const seen: Record<string, number> = {}
  for (const row of related) if (row.kind === 'seen' && str(row.device) !== '') seen[row.device] = num(row.at)
  const at = num(wake.at)
  const ringAt = last !== undefined ? Math.max(at, num(last.until)) : at
  let state: WakeState
  if (ack !== null) state = 'acked'
  else if (wake.withdrawn === true) state = 'withdrawn'
  else if (last !== undefined && now < ringAt) state = 'snoozed'
  else if (now >= ringAt) state = 'ringing'
  else state = 'pending'
  return {
    id: wake.id,
    severity: isSeverity(wake.severity) ? wake.severity : 'urgent',
    title: str(wake.title),
    whatToDo: str(wake.whatToDo),
    source: sourceOf(wake.source),
    devices: (DEVICE_CHOICES as readonly string[]).includes(str(wake.devices)) ? (wake.devices as WakeDevices) : 'auto',
    targets: Array.isArray(wake.targets) ? wake.targets.filter((t): t is string => typeof t === 'string') : [],
    dedupeKey: str(wake.dedupeKey),
    at,
    ringAt,
    state,
    cancelled: wake.cancelled === true,
    firedBy: str(wake.firedBy),
    firedOn: str(wake.firedOn),
    createdAt: num(wake.createdAt),
    updatedAt: num(wake.updatedAt),
    ackedAt: ack === null ? null : num(ack.at),
    ackedBy: ack === null ? '' : str(ack.byName) || str(ack.by),
    snoozes: snoozes.length,
    seen,
    repeats: num(wake.repeats),
  }
}

/** The title as the ringing screen says it: a cancelled source keeps ringing, marked. */
export function shownTitle(view: Pick<WakeView, 'title' | 'cancelled'>): string {
  return view.cancelled ? `Cancelled: ${view.title}` : view.title
}

// ---- who rings -----------------------------------------------------------------------------------------------------

export interface RingDecision {
  ring: boolean
  /** Sound on (false: shown silently, a heads-up in quiet hours). */
  sound: boolean
  /** Why (log and tests). */
  why: string
}

/**
 * Whether this device rings for a wake now.
 * - critical: every device at once, through quiet hours.
 * - urgent: the devices it was sent to; every device after ESCALATE_AFTER_MS without an answer; through quiet hours.
 * - heads_up: the devices it was sent to only; silent in quiet hours.
 * - any severity: a device it was sent to that has not said it has it after DELIVERY_WAIT_MS makes every device ring.
 */
export function ringsHere(view: WakeView, selfId: string, now: number, options: { quiet?: boolean } = {}): RingDecision {
  const no = (why: string): RingDecision => ({ ring: false, sound: false, why })
  if (view.state !== 'ringing') return no(view.state)
  const targeted = view.targets.length === 0 || view.targets.includes(selfId)
  const sound = !(view.severity === 'heads_up' && options.quiet === true)
  if (view.severity === 'critical') return { ring: true, sound: true, why: 'critical rings every device' }
  if (targeted) return { ring: true, sound, why: view.targets.length === 0 ? 'sent to every device' : 'sent here' }
  const since = now - view.ringAt
  if (since >= DELIVERY_WAIT_MS && view.targets.some((id) => view.seen[id] === undefined)) {
    return { ring: true, sound, why: 'the device it was sent to did not get it' }
  }
  if (view.severity === 'urgent' && since >= ESCALATE_AFTER_MS) return { ring: true, sound: true, why: 'no answer after 60 s' }
  return no('sent to another device')
}

/** The next moment a wake's decision can change (a timer for it), or null when nothing is due. */
export function nextChange(view: WakeView, now: number): number | null {
  if (view.state === 'acked' || view.state === 'withdrawn') return null
  if (view.state === 'pending' || view.state === 'snoozed') return view.ringAt
  const marks = [view.ringAt + DELIVERY_WAIT_MS, view.ringAt + ESCALATE_AFTER_MS].filter((t) => t > now)
  return marks.length === 0 ? null : Math.min(...marks)
}

/**
 * Where a wake goes first. all: every device (empty list). here: this device when it can ring. auto: the device he
 * is using (his newest activity), else every device.
 */
export function chooseTargets(
  devices: WakeDevices,
  ringers: readonly Ringer[],
  options: { selfId: string; selfRings: boolean; activeDevice: string | null },
): string[] {
  if (devices === 'all') return []
  if (devices === 'here' && options.selfRings) return [options.selfId]
  const active = options.activeDevice
  if (active !== null && ringers.some((r) => r.id === active && r.kind !== 'server')) return [active]
  return []
}

// ---- firing --------------------------------------------------------------------------------------------------------

export interface FireInput {
  severity: WakeSeverity
  title: string
  whatToDo: string
  source: WakeSource
  devices: WakeDevices
  dedupeKey: string
  /** When to ring; null: now. */
  at: number | null
}

export type FirePlan =
  | { kind: 'create'; row: Partial<WakeupRow>; message: string }
  | { kind: 'merge'; id: string; row: Partial<WakeupRow>; message: string }
  | { kind: 'refuse'; message: string }

/** Who fired it, for the rate limit: the source kind and ref, else the agent. */
export function rateKey(input: Pick<FireInput, 'source'>, firedBy: string): string {
  return `${input.source.kind}|${input.source.ref || firedBy}`
}

/**
 * What a wake_me call does: refuse (bad input, rate limit, already answered), merge into the wake with the same
 * dedupe key (a moved booking, a repeat message: no double ring), or create a new wake.
 */
export function planFire(input: FireInput, rows: readonly WakeupRow[], now: number, who: { firedBy: string; firedOn: string; targets: string[] }): FirePlan {
  const title = input.title.trim().slice(0, TITLE_MAX)
  const whatToDo = input.whatToDo.trim().slice(0, WHAT_MAX)
  if (title === '') return { kind: 'refuse', message: 'A wake-up needs a title.' }
  if (whatToDo === '') return { kind: 'refuse', message: 'A wake-up needs what_to_do: exactly what he must attend to.' }
  const at = input.at === null ? now : input.at
  if (!Number.isFinite(at)) return { kind: 'refuse', message: 'at must be an ISO time.' }
  if (at > now + MAX_AHEAD_MS) return { kind: 'refuse', message: 'A wake-up can be booked at most 14 days ahead.' }
  const ringAt = Math.max(at, now)
  const views = foldWakes(rows, now)

  if (input.dedupeKey !== '') {
    const same = views.find(
      (v) =>
        v.dedupeKey === input.dedupeKey &&
        (v.state === 'pending' || v.state === 'ringing' || v.state === 'snoozed' || now - Math.max(v.updatedAt, v.ackedAt ?? 0) < DEDUPE_WINDOW_MS),
    )
    if (same !== undefined) {
      if (same.state === 'acked') {
        return { kind: 'refuse', message: `He already answered that wake-up (${same.id.slice(0, 8)}) ${ago(now - (same.ackedAt ?? now))}; not rung again.` }
      }
      if (same.state === 'withdrawn') {
        return {
          kind: 'merge',
          id: same.id,
          row: { withdrawn: false, cancelled: false, severity: input.severity, title, whatToDo, source: input.source, at: ringAt, updatedAt: now, repeats: same.repeats + 1 },
          message: `Wake-up ${same.id.slice(0, 8)} booked again for ${stamp(ringAt)}.`,
        }
      }
      if (same.state === 'pending') {
        return {
          kind: 'merge',
          id: same.id,
          row: { severity: input.severity, title, whatToDo, source: input.source, at: ringAt, updatedAt: now, repeats: same.repeats + 1 },
          message: ringAt <= now ? `Wake-up ${same.id.slice(0, 8)} is ringing now.` : `Wake-up ${same.id.slice(0, 8)} updated: rings ${stamp(ringAt)}.`,
        }
      }
      // Ringing or snoozed: no double ring. The words are kept up to date; a higher severity is taken, never a lower.
      const severity = rank(input.severity) > rank(same.severity) ? input.severity : same.severity
      return {
        kind: 'merge',
        id: same.id,
        row: { severity, title, whatToDo, source: input.source, updatedAt: now, repeats: same.repeats + 1 },
        message: `Wake-up ${same.id.slice(0, 8)} is already ${same.state === 'ringing' ? 'ringing' : 'snoozed'}; merged into it, no second ring.`,
      }
    }
  }

  const key = rateKey(input, who.firedBy)
  const recent = rows.filter((row) => row.kind === 'wake' && num(row.createdAt) > now - RATE_WINDOW_MS && str(row.rateKey) === key)
  if (recent.length >= RATE_LIMIT) {
    return {
      kind: 'refuse',
      message: `Not rung: ${RATE_LIMIT} wake-ups from this source in the last 10 minutes already. If this is truly new, fold it into one wake-up with a dedupe_key.`,
    }
  }

  return {
    kind: 'create',
    row: {
      kind: 'wake',
      wake: '',
      severity: input.severity,
      title,
      whatToDo,
      source: input.source,
      devices: input.devices,
      targets: who.targets,
      dedupeKey: input.dedupeKey,
      rateKey: key,
      at: ringAt,
      firedBy: who.firedBy,
      firedOn: who.firedOn,
      withdrawn: false,
      cancelled: false,
      repeats: 0,
      updatedAt: now,
    },
    message: '',
  }
}

/** What a withdraw does: a wake not yet ringing goes away; a ringing or snoozed one keeps ringing, marked cancelled. */
export function planWithdraw(view: WakeView, now: number): { row: Partial<WakeupRow> | null; message: string } {
  if (view.state === 'acked') return { row: null, message: `He already answered wake-up ${view.id.slice(0, 8)}.` }
  if (view.state === 'withdrawn') return { row: null, message: `Wake-up ${view.id.slice(0, 8)} was already withdrawn.` }
  if (view.state === 'pending') return { row: { withdrawn: true, updatedAt: now }, message: `Wake-up ${view.id.slice(0, 8)} withdrawn; it will not ring.` }
  if (view.cancelled) return { row: null, message: `Wake-up ${view.id.slice(0, 8)} is already marked cancelled and keeps ringing until he answers.` }
  return {
    row: { cancelled: true, updatedAt: now },
    message: `Wake-up ${view.id.slice(0, 8)} is already ${view.state === 'snoozed' ? 'snoozed' : 'ringing'}, so it rings until he answers; its screen now says "Cancelled: ${view.title}".`,
  }
}

// ---- answers (only from his hands: the ringing screen on a device, or Settings) ----------------------------------

export function ackRow(wakeId: string, by: { id: string; name: string }, now: number): Partial<WakeupRow> & { id: string } {
  return { id: `${wakeId}:ack`, kind: 'ack', wake: wakeId, by: by.id, byName: by.name, at: now }
}

export function snoozeRow(view: WakeView, by: { id: string; name: string }, now: number, minutes: number): Partial<WakeupRow> & { id: string } {
  const n = view.snoozes + 1
  const length = Math.min(120, Math.max(1, Math.round(minutes))) * 60_000
  return { id: `${view.id}:snooze:${n}`, kind: 'snooze', wake: view.id, n, until: now + length, by: by.id, byName: by.name, at: now }
}

export function seenRow(wakeId: string, deviceId: string, now: number): Partial<WakeupRow> & { id: string } {
  return { id: `${wakeId}:seen:${deviceId}`, kind: 'seen', wake: wakeId, device: deviceId, at: now }
}

// ---- quiet hours ---------------------------------------------------------------------------------------------------

const QUIET = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/

/** "22:00-07:00" quiet hours; '' is none. `minutes` is the local minute of the day. */
export function inQuietHours(spec: string, minutes: number): boolean {
  const found = QUIET.exec(spec.trim())
  if (found === null) return false
  const start = Number(found[1]) * 60 + Number(found[2])
  const end = Number(found[3]) * 60 + Number(found[4])
  if (start === end) return false
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end
}

export function validQuietHours(spec: string): boolean {
  if (spec.trim() === '') return true
  const found = QUIET.exec(spec.trim())
  return found !== null && Number(found[1]) < 24 && Number(found[3]) < 24 && Number(found[2]) < 60 && Number(found[4]) < 60
}

// ---- for a device without the store (the phone) ------------------------------------------------------------------

/** The wakes a device must know about: ringing or snoozed now, or booked in the next 48 h. */
export function liveWakes(views: readonly WakeView[], now: number): WakeView[] {
  return views.filter((v) => v.state === 'ringing' || v.state === 'snoozed' || (v.state === 'pending' && v.ringAt <= now + 48 * 60 * 60_000))
}

/** One line of the Wake-ups log. */
export function logLine(view: WakeView, clock: (at: number) => string): string {
  const state =
    view.state === 'acked'
      ? `answered ${clock(view.ackedAt ?? 0)}${view.ackedBy === '' ? '' : ` on ${view.ackedBy}`}`
      : view.state === 'pending'
        ? `rings ${clock(view.ringAt)}`
        : view.state === 'snoozed'
          ? `snoozed until ${clock(view.ringAt)}`
          : view.state
  return `${SEVERITY_LOOK[view.severity].label}: ${shownTitle(view)} (${state}; from ${view.firedBy || 'an agent'}, ${view.source.kind})`
}

function rank(severity: WakeSeverity): number {
  return severity === 'critical' ? 3 : severity === 'urgent' ? 2 : 1
}

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  return minutes === 0 ? 'just now' : `${minutes} min ago`
}

function stamp(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}
