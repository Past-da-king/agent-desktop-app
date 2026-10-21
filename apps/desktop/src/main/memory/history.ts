/**
 * Who is writing to memory right now, and why. Every memory write goes through the Store, which keeps a version of
 * the page each time it changes (db.ts); the writer is carried through every await by AsyncLocalStorage, so the
 * Store can say who made each version without every caller passing it along. A write with no writer around it
 * is recorded as "app".
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type { MemoryRow, MemoryStatus } from '@agent/core'

export interface MemoryWriter {
  /** "you", "agent", "helper <label>", "chat filing", "end of day", "import", "another device". */
  by: string
  reason?: string
}

const writer = new AsyncLocalStorage<MemoryWriter>()

/** Runs `work` with every memory write in it recorded as made by `by`, for `reason`. */
export function asWriter<T>(by: string, reason: string | undefined, work: () => Promise<T>): Promise<T> {
  return writer.run({ by, ...(reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim().slice(0, 300) }) }, work)
}

export function currentWriter(): MemoryWriter {
  return writer.getStore() ?? { by: 'app' }
}

/** Who an agent tool call is: the main agent, or one helper by its label. */
export function agentWriter(agentLabel: string): string {
  return agentLabel === 'main' || agentLabel === '' ? 'agent' : agentLabel === 'routine' ? 'routine' : `helper ${agentLabel}`
}

/** The fields a version keeps. Pinning counts; the timestamps do not. */
export const TRACKED = ['title', 'body', 'kind', 'topics', 'status', 'aliases', 'pinned'] as const

export interface VersionFields {
  title: string
  body: string
  kind: MemoryRow['kind']
  topics: string
  status: MemoryStatus
  aliases: string
  pinned: boolean
}

/** A page's tracked fields, with the defaults an older page lacks. */
export function versionFields(payload: Record<string, unknown>): VersionFields {
  return {
    title: str(payload['title']),
    body: str(payload['body']),
    kind: (str(payload['kind']) || 'fact') as MemoryRow['kind'],
    topics: str(payload['topics']),
    status: payload['status'] === 'closed' ? 'closed' : 'open',
    aliases: str(payload['aliases']),
    pinned: payload['pinned'] === true,
  }
}

/** Which tracked fields differ between two versions of a page. */
export function changedFields(before: VersionFields, after: VersionFields): string[] {
  return TRACKED.filter((key) => before[key] !== after[key])
}

/** Comma list -> clean list: trimmed, no empties, no repeats (case-insensitive), at most 20. */
export function aliasList(value: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value.split(',')) {
    const alias = raw.trim().replace(/\s+/g, ' ').slice(0, 60)
    const key = alias.toLowerCase()
    if (alias === '' || seen.has(key)) continue
    seen.add(key)
    out.push(alias)
  }
  return out.slice(0, 20)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
