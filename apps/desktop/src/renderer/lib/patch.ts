/** Patching a listed entity in the window from one change, keeping the store's createdAt order. */

/** Where a row with this createdAt goes: after every row created no later (the store's own order). */
export function placeOf<R extends { createdAt: number }>(rows: readonly R[], createdAt: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = (low + high) >> 1
    if ((rows[mid]?.createdAt ?? 0) <= createdAt) low = mid + 1
    else high = mid
  }
  return low
}

/** The list with one change applied: a new row in order, a changed row in its place, a deleted row gone. */
export function patched<R extends { id: string; createdAt: number }>(rows: readonly R[], change: { row?: unknown; id?: string; deleted?: boolean }): R[] {
  if (change.deleted === true) {
    const id = change.id ?? (change.row as R | undefined)?.id
    return rows.filter((row) => row.id !== id)
  }
  const row = change.row as R | undefined
  if (row === undefined) return [...rows]
  const index = rows.findIndex((each) => each.id === row.id)
  const next = [...rows]
  if (index >= 0) {
    // Only the createdAt order matters; a changed row keeps its place unless its time moved.
    if (rows[index]?.createdAt === row.createdAt) {
      next[index] = row
      return next
    }
    next.splice(index, 1)
  }
  next.splice(placeOf(next, row.createdAt), 0, row)
  return next
}

/**
 * The list with many changes applied in one pass (a helper's burst, a sync's batch): the same list the changes
 * applied one by one with patched() give, without copying and searching the whole list once per change.
 */
export function patchedMany<R extends { id: string; createdAt: number }>(
  rows: readonly R[],
  changes: ReadonlyArray<{ row?: unknown; id?: string; deleted?: boolean }>,
): R[] {
  const final = new Map<string, R | null>()
  for (const change of changes) {
    const row = change.row as R | undefined
    const id = change.deleted === true ? (change.id ?? row?.id) : row?.id
    if (id === undefined) continue
    // A row changed again keeps its first place among the new ones; one deleted and written again goes last.
    if (final.get(id) === null) final.delete(id)
    final.set(id, change.deleted === true ? null : (row as R))
  }
  if (final.size === 0) return [...rows]
  const kept: R[] = []
  for (const row of rows) {
    if (!final.has(row.id)) {
      kept.push(row)
      continue
    }
    const next = final.get(row.id)
    if (next === null || next === undefined) {
      final.delete(row.id)
      continue
    }
    // Only the createdAt order matters; a changed row keeps its place unless its time moved.
    if (next.createdAt === row.createdAt) {
      kept.push(next)
      final.delete(row.id)
    }
  }
  const adds = [...final.values()].filter((row): row is R => row !== null).sort((a, b) => a.createdAt - b.createdAt)
  if (adds.length === 0) return kept
  const out: R[] = []
  let at = 0
  for (const add of adds) {
    while (at < kept.length && (kept[at]?.createdAt ?? 0) <= add.createdAt) out.push(kept[at++] as R)
    out.push(add)
  }
  while (at < kept.length) out.push(kept[at++] as R)
  return out
}
