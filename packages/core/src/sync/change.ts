/**
 * One syncable row, in a form both apps understand without sharing a database schema.
 * Port of reference/kotlin-shared/sync/Change.kt.
 *
 * `payload` is the full row as JSON minus its `id`. Deletes are tombstoned so a delete on one device
 * is not resurrected by a stale copy on another. `seq` is the server's global order, 0/absent until
 * the server has accepted the change.
 */
import type { EntityName } from '../ipc'

export interface Change {
  entity: EntityName
  id: string
  deleted: boolean
  stamp: string
  payload: Record<string, unknown>
  seq?: number
}

const ENTITY_NAMES: readonly EntityName[] = [
  'chat_item',
  'turn',
  'memory',
  'goal',
  'task',
  'trigger',
  'project',
  'device',
  'device_command',
  'turn_lease',
]

export function isEntityName(value: unknown): value is EntityName {
  return typeof value === 'string' && (ENTITY_NAMES as readonly string[]).includes(value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one change from server JSON. Null when the shape is not usable (the caller skips it). */
export function changeFromJson(value: unknown): Change | null {
  if (!isRecord(value)) return null
  const { entity, id, deleted, stamp, payload, seq } = value
  if (!isEntityName(entity)) return null
  if (typeof id !== 'string' || id === '') return null
  if (typeof stamp !== 'string' || stamp === '') return null
  const change: Change = {
    entity,
    id,
    deleted: deleted === true,
    stamp,
    payload: isRecord(payload) ? payload : {},
  }
  if (typeof seq === 'number' && Number.isFinite(seq)) change.seq = seq
  return change
}

/** The wire shape the server accepts. */
export function changeToJson(change: Change): Record<string, unknown> {
  const out: Record<string, unknown> = {
    entity: change.entity,
    id: change.id,
    deleted: change.deleted,
    stamp: change.stamp,
    payload: change.payload,
  }
  if (change.seq !== undefined) out.seq = change.seq
  return out
}
