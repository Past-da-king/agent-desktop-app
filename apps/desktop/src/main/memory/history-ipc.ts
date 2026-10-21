/**
 * The window's view of a memory page's versions, and putting an earlier one back. Restoring writes a new version
 * (made by "you", "restored version n"), so nothing in the history is ever lost.
 */
import { MEMORY_HISTORY_CHANNELS } from '../../shared/memory-history-channels'
import type { Store } from '../db'
import type { IpcMainLike } from '../ipc'
import { asWriter } from './history'

export function registerMemoryHistoryIpc(ipcMain: IpcMainLike, store: Store, nudge: () => void = () => undefined): void {
  ipcMain.handle(MEMORY_HISTORY_CHANNELS.history, async (_event, rawId) => store.memoryHistory(memoryId(rawId)))
  ipcMain.handle(MEMORY_HISTORY_CHANNELS.restoreVersion, async (_event, rawId, rawN) => {
    const id = memoryId(rawId)
    if (typeof rawN !== 'number' || !Number.isSafeInteger(rawN) || rawN < 1) throw new Error('version must be a number')
    return restoreVersion(store, id, rawN, 'you').then((done) => {
      if (done) nudge()
      return done
    })
  })
}

/** Makes a page say what version `n` said. False when there is no such version or it was a deletion. */
export async function restoreVersion(store: Store, memoryId: string, n: number, by: string): Promise<boolean> {
  const version = store.memoryHistory(memoryId).find((each) => each.n === n)
  if (version === undefined || version.deleted) return false
  const existing = await store.get('memory', memoryId)
  await asWriter(by, `restored version ${n}`, () =>
    store.upsert('memory', {
      id: memoryId,
      title: version.title,
      body: version.body,
      kind: version.kind,
      topics: version.topics,
      status: version.status,
      closedAt: version.status === 'closed' ? (existing?.closedAt ?? Date.now()) : null,
      aliases: version.aliases,
      pinned: version.pinned,
      source: existing?.source ?? 'user',
    }),
  )
  return true
}

function memoryId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '' || raw.length > 200) throw new Error('memory id must be text')
  return raw
}
