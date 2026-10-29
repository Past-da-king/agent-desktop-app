/**
 * Wake-ups, the pure model (shared/wakeups.ts) on a fake clock: severity to devices, escalation after 60 s, a device
 * that never got it, quiet hours, dedupe, rate limit, withdraw versus cancelled-while-ringing, snooze, and that a
 * wake never stops by itself.
 */
import { describe, expect, it } from 'vitest'

import type { WakeupRow } from '@agent/core'

import {
  ackRow,
  chooseTargets,
  DELIVERY_WAIT_MS,
  ESCALATE_AFTER_MS,
  foldWakes,
  inQuietHours,
  liveWakes,
  nextChange,
  planFire,
  planWithdraw,
  RATE_LIMIT,
  ringsHere,
  seenRow,
  shownTitle,
  snoozeRow,
  type FireInput,
  type WakeView,
} from '../src/shared/wakeups'

const T0 = Date.UTC(2026, 9, 29, 10, 0, 0)
const PC = 'pc-1'
const PHONE = 'phone-1'
const PC2 = 'pc-2'

function input(over: Partial<FireInput> = {}): FireInput {
  return { severity: 'urgent', title: 'Standup starts now', whatToDo: 'Join the standup', source: { kind: 'test', ref: '', link: '' }, devices: 'auto', dedupeKey: '', at: null, ...over }
}

let seq = 0
/** A tiny in-memory row list, the way the store holds them. */
class Rows {
  rows: WakeupRow[] = []
  fire(over: Partial<FireInput>, now: number, targets: string[] = [], firedBy = 'agent'): ReturnType<typeof planFire> {
    const plan = planFire(input(over), this.rows, now, { firedBy, firedOn: PC, targets })
    if (plan.kind === 'create') this.rows.push({ ...(plan.row as WakeupRow), id: `w${++seq}`, createdAt: now })
    if (plan.kind === 'merge') this.patch(plan.id, plan.row)
    return plan
  }
  add(row: Partial<WakeupRow> & { id: string }, now: number): void {
    this.rows = this.rows.filter((r) => r.id !== row.id)
    this.rows.push({ ...(row as WakeupRow), createdAt: now })
  }
  patch(id: string, row: Partial<WakeupRow>): void {
    this.rows = this.rows.map((r) => (r.id === id ? { ...r, ...row } : r))
  }
  view(now: number, id?: string): WakeView {
    const views = foldWakes(this.rows, now)
    const found = id === undefined ? views[0] : views.find((v) => v.id === id)
    if (found === undefined) throw new Error('no wake')
    return found
  }
}

describe('wake-up model', () => {
  it('rings from its time and never stops by itself (no timeout, hours later still ringing)', () => {
    const rows = new Rows()
    rows.fire({ at: T0 + 60_000 }, T0, [PC])
    expect(rows.view(T0).state).toBe('pending')
    expect(ringsHere(rows.view(T0), PC, T0).ring).toBe(false)
    expect(rows.view(T0 + 60_000).state).toBe('ringing')
    expect(ringsHere(rows.view(T0 + 60_000), PC, T0 + 60_000).ring).toBe(true)
    const later = T0 + 9 * 60 * 60_000
    expect(rows.view(later).state).toBe('ringing')
    expect(ringsHere(rows.view(later), PC, later).ring).toBe(true)
  })

  it('an ack from any device stops it on every device', () => {
    const rows = new Rows()
    rows.fire({ severity: 'critical' }, T0, [])
    expect(ringsHere(rows.view(T0), PC, T0).ring).toBe(true)
    expect(ringsHere(rows.view(T0), PHONE, T0).ring).toBe(true)
    rows.add(ackRow(rows.view(T0).id, { id: PHONE, name: 'Phone' }, T0 + 5_000), T0 + 5_000)
    const v = rows.view(T0 + 5_000)
    expect(v.state).toBe('acked')
    expect(v.ackedBy).toBe('Phone')
    for (const device of [PC, PHONE, PC2]) expect(ringsHere(v, device, T0 + 5_000).ring).toBe(false)
  })

  it('a seen row or a late snooze cannot undo an ack (each row has one writer)', () => {
    const rows = new Rows()
    rows.fire({}, T0, [PC])
    const id = rows.view(T0).id
    rows.add(ackRow(id, { id: PC, name: 'PC' }, T0 + 1_000), T0 + 1_000)
    rows.add(seenRow(id, PHONE, T0 + 2_000), T0 + 2_000)
    rows.add(snoozeRow(rows.view(T0 + 2_000), { id: PHONE, name: 'Phone' }, T0 + 2_000, 5), T0 + 2_000)
    expect(rows.view(T0 + 3_000).state).toBe('acked')
  })

  it('critical rings every device at once, through quiet hours', () => {
    const rows = new Rows()
    rows.fire({ severity: 'critical' }, T0, [PHONE])
    const v = rows.view(T0)
    for (const device of [PC, PHONE, PC2]) expect(ringsHere(v, device, T0, { quiet: true })).toMatchObject({ ring: true, sound: true })
  })

  it('urgent rings where he is, the others join after 60 s without an answer', () => {
    const rows = new Rows()
    rows.fire({ severity: 'urgent' }, T0, [PC])
    const id = rows.view(T0).id
    rows.add(seenRow(id, PC, T0 + 500), T0 + 500)
    expect(ringsHere(rows.view(T0 + 1_000), PC, T0 + 1_000).ring).toBe(true)
    expect(ringsHere(rows.view(T0 + 1_000), PHONE, T0 + 1_000).ring).toBe(false)
    expect(ringsHere(rows.view(T0 + ESCALATE_AFTER_MS - 1), PHONE, T0 + ESCALATE_AFTER_MS - 1).ring).toBe(false)
    expect(ringsHere(rows.view(T0 + ESCALATE_AFTER_MS), PHONE, T0 + ESCALATE_AFTER_MS)).toMatchObject({ ring: true, sound: true })
    expect(nextChange(rows.view(T0 + 1_000), T0 + 1_000)).toBe(T0 + DELIVERY_WAIT_MS)
  })

  it('heads-up rings only where it was sent, and is silent in quiet hours', () => {
    const rows = new Rows()
    rows.fire({ severity: 'heads_up' }, T0, [PC])
    const id = rows.view(T0).id
    rows.add(seenRow(id, PC, T0 + 100), T0 + 100)
    const late = T0 + 10 * 60_000
    expect(ringsHere(rows.view(late), PHONE, late).ring).toBe(false)
    expect(ringsHere(rows.view(late), PC, late, { quiet: true })).toMatchObject({ ring: true, sound: false })
    expect(ringsHere(rows.view(late), PC, late, { quiet: false })).toMatchObject({ ring: true, sound: true })
  })

  it('a device it was sent to that never said it has it: every device rings after 30 s ("phone not reached")', () => {
    const rows = new Rows()
    rows.fire({ severity: 'heads_up' }, T0, [PHONE])
    expect(ringsHere(rows.view(T0 + 1_000), PC, T0 + 1_000).ring).toBe(false)
    const after = T0 + DELIVERY_WAIT_MS
    expect(ringsHere(rows.view(after), PC, after)).toMatchObject({ ring: true, why: 'the device it was sent to did not get it' })
  })

  it('snooze stops it on every device and rings again at the end, same severity', () => {
    const rows = new Rows()
    rows.fire({ severity: 'critical' }, T0, [])
    rows.add(snoozeRow(rows.view(T0 + 2_000), { id: PC, name: 'PC' }, T0 + 2_000, 5), T0 + 2_000)
    const during = T0 + 3 * 60_000
    expect(rows.view(during).state).toBe('snoozed')
    for (const device of [PC, PHONE]) expect(ringsHere(rows.view(during), device, during).ring).toBe(false)
    const back = T0 + 2_000 + 5 * 60_000
    expect(nextChange(rows.view(during), during)).toBe(back)
    expect(rows.view(back).state).toBe('ringing')
    expect(rows.view(back).severity).toBe('critical')
    expect(ringsHere(rows.view(back), PHONE, back).ring).toBe(true)
    // A second snooze is the next row, not an overwrite.
    const second = snoozeRow(rows.view(back), { id: PHONE, name: 'Phone' }, back, 5)
    expect(second.id.endsWith(':snooze:2')).toBe(true)
  })

  it('the same dedupe key merges: no second ring while one rings; a booking that moved is updated', () => {
    const rows = new Rows()
    const first = rows.fire({ dedupeKey: 'evt-1|15', at: T0 + 15 * 60_000 }, T0)
    expect(first.kind).toBe('create')
    const moved = rows.fire({ dedupeKey: 'evt-1|15', at: T0 + 30 * 60_000, title: 'Standup (moved)' }, T0 + 1_000)
    expect(moved.kind).toBe('merge')
    expect(rows.rows.filter((r) => r.kind === 'wake')).toHaveLength(1)
    expect(rows.view(T0 + 1_000).ringAt).toBe(T0 + 30 * 60_000)
    const ringingAt = T0 + 30 * 60_000
    const again = rows.fire({ dedupeKey: 'evt-1|15', severity: 'heads_up' }, ringingAt + 1_000)
    expect(again).toMatchObject({ kind: 'merge' })
    expect(again.message).toContain('no second ring')
    expect(rows.rows.filter((r) => r.kind === 'wake')).toHaveLength(1)
    // A lower severity never lowers a ringing wake.
    expect(rows.view(ringingAt + 1_000).severity).toBe('urgent')
  })

  it('a repeat of a wake he answered within 10 minutes is refused, later it is new', () => {
    const rows = new Rows()
    rows.fire({ dedupeKey: 'msg-9' }, T0)
    rows.add(ackRow(rows.view(T0).id, { id: PC, name: 'PC' }, T0 + 1_000), T0 + 1_000)
    expect(rows.fire({ dedupeKey: 'msg-9' }, T0 + 5 * 60_000).kind).toBe('refuse')
    expect(rows.fire({ dedupeKey: 'msg-9' }, T0 + 12 * 60_000).kind).toBe('create')
  })

  it('rate limit: at most 5 per source in 10 minutes', () => {
    const rows = new Rows()
    for (let i = 0; i < RATE_LIMIT; i++) expect(rows.fire({ title: `t${i}` }, T0 + i * 1_000).kind).toBe('create')
    const refused = rows.fire({ title: 'one more' }, T0 + 10_000)
    expect(refused.kind).toBe('refuse')
    expect(rows.fire({ title: 'other source', source: { kind: 'mail', ref: 'x', link: '' } }, T0 + 10_000).kind).toBe('create')
    expect(rows.fire({ title: 'later' }, T0 + 11 * 60_000).kind).toBe('create')
  })

  it('withdraw before it rings removes it; a ringing one keeps ringing, marked Cancelled', () => {
    const rows = new Rows()
    rows.fire({ at: T0 + 60_000 }, T0, [PC])
    const pending = planWithdraw(rows.view(T0), T0)
    expect(pending.row).toMatchObject({ withdrawn: true })
    rows.patch(rows.view(T0).id, pending.row ?? {})
    expect(rows.view(T0 + 120_000).state).toBe('withdrawn')
    expect(ringsHere(rows.view(T0 + 120_000), PC, T0 + 120_000).ring).toBe(false)

    const other = new Rows()
    other.fire({}, T0, [PC])
    const ringing = planWithdraw(other.view(T0 + 1_000), T0 + 1_000)
    expect(ringing.row).toMatchObject({ cancelled: true })
    other.patch(other.view(T0).id, ringing.row ?? {})
    const v = other.view(T0 + 2_000)
    expect(v.state).toBe('ringing')
    expect(ringsHere(v, PC, T0 + 2_000).ring).toBe(true)
    expect(shownTitle(v)).toBe('Cancelled: Standup starts now')
  })

  it('refuses a wake with no title or no what_to_do, or booked too far ahead', () => {
    expect(planFire(input({ title: ' ' }), [], T0, { firedBy: 'a', firedOn: PC, targets: [] }).kind).toBe('refuse')
    expect(planFire(input({ whatToDo: '' }), [], T0, { firedBy: 'a', firedOn: PC, targets: [] }).kind).toBe('refuse')
    expect(planFire(input({ at: T0 + 30 * 24 * 60 * 60_000 }), [], T0, { firedBy: 'a', firedOn: PC, targets: [] }).kind).toBe('refuse')
  })

  it('targets: all is every device, here is this device, auto is where he is or every device', () => {
    const ringers = [
      { id: PC, name: 'PC', kind: 'desktop' as const },
      { id: PHONE, name: 'Phone', kind: 'phone' as const },
    ]
    expect(chooseTargets('all', ringers, { selfId: PC, selfRings: true, activeDevice: PHONE })).toEqual([])
    expect(chooseTargets('here', ringers, { selfId: PC, selfRings: true, activeDevice: PHONE })).toEqual([PC])
    expect(chooseTargets('auto', ringers, { selfId: PC, selfRings: true, activeDevice: PHONE })).toEqual([PHONE])
    expect(chooseTargets('auto', ringers, { selfId: PC, selfRings: true, activeDevice: null })).toEqual([])
    // A headless server asked for "here" cannot ring: where he is instead.
    expect(chooseTargets('here', ringers, { selfId: 'srv', selfRings: false, activeDevice: PC })).toEqual([PC])
  })

  it('quiet hours across midnight', () => {
    expect(inQuietHours('22:00-07:00', 23 * 60)).toBe(true)
    expect(inQuietHours('22:00-07:00', 6 * 60 + 59)).toBe(true)
    expect(inQuietHours('22:00-07:00', 7 * 60)).toBe(false)
    expect(inQuietHours('', 23 * 60)).toBe(false)
    expect(inQuietHours('13:00-14:00', 13 * 60 + 30)).toBe(true)
  })

  it('live wakes for the phone: ringing, snoozed and the next 48 h, not answered or withdrawn ones', () => {
    const rows = new Rows()
    rows.fire({ title: 'now' }, T0)
    rows.fire({ title: 'soon', at: T0 + 60 * 60_000 }, T0)
    rows.fire({ title: 'far', at: T0 + 5 * 24 * 60 * 60_000 }, T0)
    rows.fire({ title: 'answered' }, T0)
    const answered = foldWakes(rows.rows, T0).find((v) => v.title === 'answered')
    rows.add(ackRow(answered?.id ?? '', { id: PC, name: 'PC' }, T0), T0)
    expect(liveWakes(foldWakes(rows.rows, T0), T0).map((v) => v.title).sort()).toEqual(['now', 'soon'])
  })
})
