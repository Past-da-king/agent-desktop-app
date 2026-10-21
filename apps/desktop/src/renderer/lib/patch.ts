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
