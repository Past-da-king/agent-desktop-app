/**
 * Mini-apps in the window: how many pinned apps the sidebar shows in the room the navigation leaves (the 0.2.79
 * rule: Home, Chat, Tasks... Settings and the account never shrink; pinned apps shrink like project tiles and the rest
 * go into a "+N" tile that opens the Apps page). Pure, so it is unit tested directly.
 */
import { RAIL_PAD, RAIL_PAD_SMALL, RAIL_TILE, RAIL_TILE_SMALL, type RailRoom } from './projects'

export interface PinnedFit {
  small: boolean
  /** Apps drawn as tiles. */
  show: number
  /** Apps in the "+N" tile (0: no such tile). */
  more: number
}

function capacity(room: RailRoom, tile: number, pad: number): number {
  const row = room.extra + pad + tile + room.gap
  if (row <= 0) return 0
  return Math.max(0, Math.floor((room.room + room.gap) / row)) * Math.max(1, room.cols)
}

/**
 * At most `cap` apps; all of them at full size if they fit, else at the smaller size, else as many as fit with a
 * "+N" tile counting the rest. With no room at all, only the "+N" tile (it is the way to the rest).
 */
export function fitPinned(room: RailRoom | null, count: number, cap: number): PinnedFit {
  const limit = Math.max(1, Math.min(20, Math.round(cap)))
  const wanted = Math.min(count, limit)
  const over = count - wanted
  if (count === 0) return { small: false, show: 0, more: 0 }
  if (room === null) return { small: false, show: wanted, more: over }
  const need = wanted + (over > 0 ? 1 : 0)
  if (capacity(room, RAIL_TILE, RAIL_PAD) >= need) return { small: false, show: wanted, more: over }
  const small = capacity(room, RAIL_TILE_SMALL, RAIL_PAD_SMALL)
  if (small >= need) return { small: true, show: wanted, more: over }
  const show = Math.max(0, Math.min(wanted, small - 1))
  return { small: true, show, more: count - show }
}

/** The height the pinned area asks for: every pinned app (up to the cap) at full size, plus a "+N" row when over. */
export function pinnedBasis(count: number, cap: number, cols: number, extra: number, gap: number, pad: number): number {
  const limit = Math.max(1, Math.min(20, Math.round(cap)))
  const tiles = Math.min(count, limit) + (count > limit ? 1 : 0)
  const rows = Math.ceil(tiles / Math.max(1, cols))
  return rows === 0 ? 0 : rows * (extra + RAIL_PAD + RAIL_TILE) + (rows - 1) * gap + pad
}

/** "3 min ago", "yesterday", "12 Oct": when it was last opened. */
export function openedLine(at: number, now: number = Date.now()): string {
  if (at <= 0) return 'Not opened yet'
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'Opened just now'
  if (minutes < 60) return `Opened ${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Opened ${hours} h ago`
  if (hours < 48) return 'Opened yesterday'
  return `Opened ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}
