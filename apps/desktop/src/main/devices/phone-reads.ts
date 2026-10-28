/**
 * The reads a linked phone makes in small pieces (data use, 28 Oct 2026): a first list of just the newest messages,
 * and "what changed after seq N". The decisions about which rows a phone keeps are in shared/device-feed.ts.
 */
import type { ChatItem, DataChange, EntityName } from '@agent/core'

import { parsePrefs, shapeChange, trimHelperRow, type DevicePrefs } from '../../shared/device-feed'
import { isOpenCard } from '../../shared/device-list'
import { lightRow } from '../../shared/light-row'
import type { Store } from '../db'

/** The phone's own view of a list: `{ v: 2, limit }` for the newest messages and open cards of the main chat. */
export interface PhoneListOpts {
  v: number
  /** chat_item only: how many of the newest main-chat messages (open cards of any chat come besides). */
  limit?: number
  /** Answer `{ seq, rows, more }` instead of a bare array, with the change-log seq the list was read at. */
  withSeq?: boolean
}

export function isPhoneListOpts(raw: unknown): raw is PhoneListOpts {
  return typeof raw === 'object' && raw !== null && typeof (raw as { v?: unknown }).v === 'number' && (raw as { v: number }).v >= 2
}

const V2: DevicePrefs = parsePrefs({ v: 2 })

/** Changes a delta answers before it gives up and tells the phone to read afresh. */
export const SINCE_MAX_ENTRIES = 3_000
const SINCE_PAGE = 500

type PhoneStore = Pick<Store, 'list' | 'listWhere' | 'logSeq' | 'changesAfter' | 'phoneChatPage'>

export async function listForPhone(store: PhoneStore, entity: EntityName, opts: PhoneListOpts): Promise<unknown> {
  const seq = store.logSeq()
  let rows: unknown[]
  let more = false
  if (entity === 'chat_item') {
    const page = await store.phoneChatPage(undefined, opts.limit ?? 20)
    more = page.more
    const waiting = [...(await store.listWhere('chat_item', { kind: 'question' })), ...(await store.listWhere('chat_item', { kind: 'approval' }))].filter((row) => isOpenCard(row))
    const have = new Set(page.rows.map((row) => row.id))
    const all: ChatItem[] = [...page.rows, ...waiting.filter((row) => !have.has(row.id))]
    all.sort((a, b) => a.createdAt - b.createdAt)
    rows = all.map((row) => trimHelperRow(lightRow('chat_item', row)))
  } else {
    const kept = (await store.list(entity)).filter((row) => shapeChange({ entity, row } as DataChange, V2) !== null)
    rows = kept.map((row) => lightRow(entity, row))
  }
  return opts.withSeq === true ? { seq, rows, more } : rows
}

export interface SinceAnswer {
  /** Read afresh: the phone's seq is not one this computer knows, or too much changed to send as a delta. */
  reset?: true
  /** The seq the phone holds after applying `changes`. */
  seq: number
  changes?: DataChange[]
}

export function changesForPhone(store: PhoneStore, since: number): SinceAnswer {
  const now = store.logSeq()
  if (!Number.isFinite(since) || since < 0 || since > now) return { reset: true, seq: now }
  const out: DataChange[] = []
  let cursor = Math.floor(since)
  let entries = 0
  for (;;) {
    const page = store.changesAfter(cursor, SINCE_PAGE)
    if (page.cursor === cursor) break
    entries += page.changes.length
    if (entries > SINCE_MAX_ENTRIES) return { reset: true, seq: now }
    for (const change of page.changes) {
      const entity = change.entity as EntityName
      const shaped = shapeChange(
        change.deleted ? ({ entity, id: change.id, deleted: true } as DataChange) : ({ entity, row: { id: change.id, ...(change.payload as object) } } as DataChange),
        V2,
      )
      if (shaped !== null) out.push(shaped.row === undefined ? shaped : ({ ...shaped, row: lightRow(entity, shaped.row) } as DataChange))
    }
    cursor = page.cursor
    if (page.changes.length < SINCE_PAGE && cursor >= now) break
  }
  return { seq: cursor, changes: out }
}
