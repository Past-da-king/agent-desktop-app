/**
 * How the running list is folded on this device, kept across restarts (9 Nov 2026): whether the whole block is open
 * (open until the person closes it), and which project groups he closed. One choice for the device, not per chat.
 */
import { create } from 'zustand'

export const WORK_LIST_OPEN_KEY = 'agent.workListOpen'
export const WORK_GROUPS_CLOSED_KEY = 'agent.workGroupsClosed'

type Reads = Pick<Storage, 'getItem'>
type Writes = Pick<Storage, 'setItem' | 'removeItem'>

/** Open unless the person closed it ('0'). */
export function readWorkListOpen(store?: Reads | null): boolean {
  try {
    return store?.getItem(WORK_LIST_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeWorkListOpen(open: boolean, store?: Writes | null): void {
  try {
    store?.setItem(WORK_LIST_OPEN_KEY, open ? '1' : '0')
  } catch {
    // Storage refused: the choice lasts until the window closes.
  }
}

export function readClosedGroups(store?: Reads | null): string[] {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(WORK_GROUPS_CLOSED_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((each): each is string => typeof each === 'string' && each !== '').slice(0, 200) : []
  } catch {
    return []
  }
}

export function writeClosedGroups(ids: readonly string[], store?: Writes | null): void {
  try {
    if (ids.length === 0) store?.removeItem(WORK_GROUPS_CLOSED_KEY)
    else store?.setItem(WORK_GROUPS_CLOSED_KEY, JSON.stringify(ids))
  } catch {
    // As above.
  }
}

function prefStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

interface WorkListPref {
  open: boolean
  closed: ReadonlySet<string>
  toggle: () => void
  toggleGroup: (id: string) => void
}

export const useWorkList = create<WorkListPref>((set, get) => ({
  open: readWorkListOpen(prefStore()),
  closed: new Set(readClosedGroups(prefStore())),
  toggle: () => {
    const open = !get().open
    writeWorkListOpen(open, prefStore())
    set({ open })
  },
  toggleGroup: (id) => {
    const closed = new Set(get().closed)
    if (closed.has(id)) closed.delete(id)
    else closed.add(id)
    writeClosedGroups([...closed], prefStore())
    set({ closed })
  },
}))
