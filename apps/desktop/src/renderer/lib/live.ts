import type { ChatItem } from '@agent/core'

import { liveFromMeta } from '../../shared/sender'
import { parseMeta } from './meta'

/** One job his Live voice assistant handed to the agent: its own words, and his when they were kept. */
export interface LiveEntry {
  request: string
  spoken: string
  at: number
}

/** The hand-offs a call row records (`meta.handoffList`, saved with the call). */
export function handoffsOfCall(meta: Record<string, unknown>): LiveEntry[] {
  const raw = meta['handoffList']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const e = entry as Record<string, unknown>
    if (typeof e['request'] !== 'string' || e['request'].trim() === '') return []
    return [{ request: e['request'], spoken: typeof e['spoken'] === 'string' ? e['spoken'] : '', at: typeof e['at'] === 'number' ? e['at'] : 0 }]
  })
}

/** A row the Live assistant wrote into the chat (stored as `meta.live`): never his own message. */
export function isLiveHandoff(item: ChatItem): boolean {
  return item.kind === 'user' && liveFromMeta(parseMeta(item.meta)) !== null
}

/**
 * A Live session is a call, so its hand-offs fold into the call block and never draw as a bubble of his. Hand-off rows
 * leave the thread; each goes inside the call row with the same session id, and a session whose call is not saved yet
 * (still going) shows as one collapsed Live voice block at its first hand-off.
 */
export function foldLiveHandoffs(rows: ChatItem[]): ChatItem[] {
  if (!rows.some(isLiveHandoff)) return rows
  const bySession = new Map<string, LiveEntry[]>()
  const firstRow = new Map<string, ChatItem>()
  for (const row of rows) {
    if (!isLiveHandoff(row)) continue
    const live = liveFromMeta(parseMeta(row.meta))
    const key = live?.session === '' || live === null ? `row:${row.id}` : live.session
    const list = bySession.get(key) ?? []
    list.push({ request: row.text, spoken: live?.spoken ?? '', at: row.createdAt })
    bySession.set(key, list)
    if (!firstRow.has(key)) firstRow.set(key, row)
  }
  const saved = new Set<string>()
  for (const row of rows) {
    if (row.kind !== 'call') continue
    const meta = parseMeta(row.meta)
    if (typeof meta['session'] === 'string' && meta['session'] !== '') saved.add(meta['session'])
  }
  const out: ChatItem[] = []
  for (const row of rows) {
    if (isLiveHandoff(row)) {
      const live = liveFromMeta(parseMeta(row.meta))
      const key = live?.session === '' || live === null ? `row:${row.id}` : live.session
      // The call row carries it, or this is the session's first hand-off and stands in for the call until it is saved.
      if (saved.has(key) || firstRow.get(key)?.id !== row.id) continue
      const entries = bySession.get(key) ?? []
      out.push({
        ...row,
        kind: 'call',
        text: 'Live voice',
        meta: JSON.stringify({ source: 'live', pending: true, durationMs: 0, lines: [], session: key, handoffList: entries }),
      })
      continue
    }
    if (row.kind === 'call') {
      const meta = parseMeta(row.meta)
      const session = typeof meta['session'] === 'string' ? meta['session'] : ''
      const extra = session === '' ? undefined : bySession.get(session)
      if (extra !== undefined) {
        const have = handoffsOfCall(meta)
        const merged = [...have, ...extra.filter((e) => !have.some((h) => h.request === e.request))].sort((a, b) => a.at - b.at)
        out.push({ ...row, meta: JSON.stringify({ ...meta, source: 'live', handoffList: merged, handoffs: merged.length }) })
        continue
      }
    }
    out.push(row)
  }
  return out
}
