/**
 * A complete in-memory [SyncStore]. Used by tests and as the reference implementation of the
 * last-writer-wins apply rules: own echoes are skipped, every remote stamp is folded into our HLC,
 * and a local row with an equal or newer stamp is never overwritten.
 */
import type { EntityName } from '../ipc'
import type { Change } from './change'
import { Hlc, compareStamps, decodeStamp, encodeStamp } from './hlc'
import type { SyncStore } from './store'

interface StoredRow {
  stamp: string
  deleted: boolean
  payload: Record<string, unknown>
  /** Written by this device and not yet pushed. Rows applied from the server are never pushed back. */
  local: boolean
}

const SEP = '\u0000'

function keyFor(entity: EntityName, id: string): string {
  return `${entity}${SEP}${id}`
}

function splitKey(key: string): { entity: EntityName; id: string } | null {
  const at = key.indexOf(SEP)
  if (at < 0) return null
  const entity = key.slice(0, at)
  const id = key.slice(at + SEP.length)
  if (id === '') return null
  return { entity: entity as EntityName, id }
}

export class MemorySyncStore implements SyncStore {
  readonly deviceId: string
  private readonly hlc: Hlc
  private readonly rows = new Map<string, StoredRow>()
  private mark: string | null = null
  private seq = 0

  constructor(deviceId: string, clock: () => number = Date.now) {
    this.deviceId = deviceId
    this.hlc = new Hlc(deviceId, clock)
  }

  async localChanges(afterStamp: string | null): Promise<Change[]> {
    const after = afterStamp === null ? null : decodeStamp(afterStamp)
    const out: Change[] = []
    for (const [key, row] of this.rows) {
      const stamp = decodeStamp(row.stamp)
      const parsed = splitKey(key)
      if (stamp === null || parsed === null || !row.local) continue
      if (after !== null && compareStamps(stamp, after) <= 0) continue
      out.push({
        entity: parsed.entity,
        id: parsed.id,
        deleted: row.deleted,
        stamp: row.stamp,
        payload: { ...row.payload },
      })
    }
    out.sort((a, b) => {
      const left = decodeStamp(a.stamp)
      const right = decodeStamp(b.stamp)
      if (left === null || right === null) return 0
      return compareStamps(left, right)
    })
    return out
  }

  async applyRemote(changes: Change[]): Promise<void> {
    for (const change of changes) {
      const remote = decodeStamp(change.stamp)
      if (remote === null) continue
      // Our own echo: do not fold it into the clock and do not clobber newer local work.
      if (remote.device === this.deviceId) continue

      this.hlc.observe(remote)
      const key = keyFor(change.entity, change.id)
      const existing = this.rows.get(key)
      if (existing !== undefined) {
        const local = decodeStamp(existing.stamp)
        if (local !== null && compareStamps(local, remote) >= 0) continue
      }
      this.rows.set(key, {
        stamp: change.stamp,
        deleted: change.deleted,
        payload: { ...change.payload },
        local: false,
      })
    }
  }

  async pushMark(): Promise<string | null> {
    return this.mark
  }

  async setPushMark(stamp: string): Promise<void> {
    this.mark = stamp
  }

  async cursor(): Promise<number> {
    return this.seq
  }

  async setCursor(seq: number): Promise<void> {
    this.seq = seq
  }

  /** Create or replace a local row. The stamp comes from this device's HLC. */
  async put(
    entity: EntityName,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<Change> {
    return this.write(entity, id, false, payload)
  }

  /** Tombstone a local row. The old payload is kept so a reader can still explain the delete. */
  async remove(entity: EntityName, id: string): Promise<Change> {
    const existing = this.rows.get(keyFor(entity, id))
    return this.write(entity, id, true, existing?.payload ?? {})
  }

  /** The payload of a live row, or undefined when it does not exist or is deleted. */
  get(entity: EntityName, id: string): Record<string, unknown> | undefined {
    const row = this.rows.get(keyFor(entity, id))
    if (row === undefined || row.deleted) return undefined
    return { ...row.payload }
  }

  /** The current stamp of a row, tombstone included. Mainly for assertions in tests. */
  stampOf(entity: EntityName, id: string): string | undefined {
    return this.rows.get(keyFor(entity, id))?.stamp
  }

  private async write(
    entity: EntityName,
    id: string,
    deleted: boolean,
    payload: Record<string, unknown>,
  ): Promise<Change> {
    const change: Change = {
      entity,
      id,
      deleted,
      stamp: encodeStamp(this.hlc.now()),
      payload: { ...payload },
    }
    this.rows.set(keyFor(entity, id), {
      stamp: change.stamp,
      deleted,
      payload: change.payload,
      local: true,
    })
    return change
  }
}
