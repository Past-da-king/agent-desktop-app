/**
 * What a linked phone is sent, and what it is not (data use, 28 Oct 2026). A phone on mobile data cannot afford the
 * computer's whole chat: helper steps alone were 20 to 60 MB an hour. A phone that says hello with `device.prefs`
 * (v2) hears only rows it keeps, with helper rows trimmed, each change tagged with its change-log `seq`, and helper
 * cards as deltas and only while it shows them. A device that never sends prefs (every older phone, the browser UI,
 * another node) is treated as before. Pure, so the handlers, the server and the tests share one definition.
 */
import type { ChatItem, DataChange } from '@agent/core'

import { isOpenCard } from './device-list'

export interface DevicePrefs {
  /** 2 = this module's shaping; anything lower or absent = the old whole-event behaviour. */
  v: number
  /** The phone is on a metered network (mobile data). */
  metered: boolean
  /** The phone has its helpers screen open now, so it wants the card stream while metered. */
  helpers: boolean
}

export const LEGACY_PREFS: DevicePrefs = { v: 0, metered: false, helpers: true }

export function parsePrefs(raw: unknown): DevicePrefs {
  if (typeof raw !== 'object' || raw === null) return LEGACY_PREFS
  const o = raw as Record<string, unknown>
  const v = typeof o['v'] === 'number' && Number.isFinite(o['v']) ? Math.floor(o['v']) : 0
  return { v, metered: o['metered'] === true, helpers: o['helpers'] !== false }
}

/** Entities a v2 phone keeps. */
const KEPT: ReadonlySet<string> = new Set(['chat_item', 'memory', 'task', 'goal', 'trigger', 'project'])

function metaOf(row: { meta?: unknown }): Record<string, unknown> {
  if (typeof row.meta !== 'string') return {}
  try {
    const value: unknown = JSON.parse(row.meta)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function chatOfRow(row: { meta?: unknown }): string {
  const chat = metaOf(row)['chat']
  return typeof chat === 'string' && chat !== '' ? chat : 'main'
}

/** A step a helper took: shown inside its card (helpers.cards), never one by one on the phone. */
export function isHelperStep(row: { kind?: unknown; meta?: unknown }): boolean {
  if (row.kind !== 'activity') return false
  const helper = metaOf(row)['helper']
  return helper !== undefined && helper !== null && helper !== '' && helper !== 0
}

/** Questions and approvals of any chat: a phone answers them from anywhere. */
export function isCardRow(row: { kind?: unknown }): boolean {
  return row.kind === 'question' || row.kind === 'approval'
}

/** Whether a phone that keeps main-chat rows keeps this chat row. */
export function phoneKeepsChatRow(row: { kind?: unknown; meta?: unknown }): boolean {
  if (isCardRow(row)) return true
  if (isHelperStep(row)) return false
  return chatOfRow(row) === 'main'
}

const META_STRING_CAP = 300
const META_OBJECT_CAP = 1_500

/** A helper's row without its long text: the brief, result and steps stay on the computer until the phone opens it. */
export function trimHelperRow<T extends { kind?: unknown; meta?: unknown }>(row: T): T {
  if (row.kind !== 'helper' || typeof row.meta !== 'string' || row.meta.length <= 1_200) return row
  const meta = metaOf(row)
  const out: Record<string, unknown> = {}
  let cut = false
  for (const [key, value] of Object.entries(meta)) {
    if (typeof value === 'string' && value.length > META_STRING_CAP) {
      out[key] = value.slice(0, META_STRING_CAP)
      cut = true
    } else if (typeof value === 'object' && value !== null && JSON.stringify(value).length > META_OBJECT_CAP) {
      cut = true
    } else out[key] = value
  }
  return cut ? { ...row, meta: JSON.stringify({ ...out, more: true }) } : row
}

/**
 * One data change as a v2 phone should hear it, or null for none. `reset` always goes (the phone reloads). A row it
 * keeps goes trimmed; a deletion goes for kept entities only.
 */
export function shapeChange(change: DataChange, prefs: DevicePrefs): DataChange | null {
  // A reset's batch is for the window on this computer; a device reads its own bounded list again.
  if (change.batch !== undefined) return { entity: change.entity, reset: true }
  if (prefs.v < 2) return change
  if (change.reset === true) return change
  // A mini-app's row carries its files: a device hears only that it changed, and reads the slim list (miniapps.list).
  if (change.entity === 'miniapp') return { entity: 'miniapp', id: change.id ?? (change.row as { id?: string } | undefined)?.id ?? '', ...(change.deleted === true ? { deleted: true } : {}) }
  if (!KEPT.has(change.entity)) return null
  if (change.entity === 'memory' && change.row !== undefined) {
    const project = (change.row as { project?: unknown }).project
    if (typeof project === 'string' && project !== '') return null
  }
  if (change.entity !== 'chat_item' || change.row === undefined) return change
  const row = change.row as ChatItem
  if (!phoneKeepsChatRow(row)) return null
  return { ...change, row: trimHelperRow(row) } as DataChange
}

/** An event the phone has no use for at all: the old "something changed in a chat" nudge makes it reload. */
export function dropsChatNudge(payload: unknown, prefs: DevicePrefs): boolean {
  if (prefs.v < 2) return false
  const type = typeof payload === 'object' && payload !== null ? (payload as { type?: unknown }).type : undefined
  return type === 'chat_changed'
}

// ---- helper cards as deltas ----

export interface CardLike {
  id: string
}

export interface CardsSnapshot<C extends CardLike = CardLike> {
  seq: number
  at: number
  cards: C[]
}

export interface CardsDelta<C extends CardLike = CardLike> {
  seq: number
  at: number
  /** The seq this delta applies on top of. */
  base: number
  upsert: C[]
  remove: string[]
  /** Every card id in order, so the phone can put them in the computer's order. */
  order: string[]
}

/** What one device was last sent of the cards. */
export interface CardsMemory {
  seq: number
  json: Map<string, string>
}

export function rememberCards(snapshot: CardsSnapshot): CardsMemory {
  return { seq: snapshot.seq, json: new Map(snapshot.cards.map((card) => [card.id, JSON.stringify(card)])) }
}

/** The delta from what a device holds to `snapshot`, and what it will hold after. Null when nothing differs. */
export function cardsDelta<C extends CardLike>(held: CardsMemory, snapshot: CardsSnapshot<C>): { delta: CardsDelta<C> | null; next: CardsMemory } {
  const next = rememberCards(snapshot)
  const upsert = snapshot.cards.filter((card) => held.json.get(card.id) !== next.json.get(card.id))
  const remove = [...held.json.keys()].filter((id) => !next.json.has(id))
  const sameOrder = upsert.length === 0 && remove.length === 0
  if (sameOrder) return { delta: null, next }
  return { delta: { seq: snapshot.seq, at: snapshot.at, base: held.seq, upsert, remove, order: snapshot.cards.map((card) => card.id) }, next }
}
