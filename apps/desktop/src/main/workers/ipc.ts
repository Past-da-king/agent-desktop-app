/** The window's view of the workers: list, events, logs, start/stop/restart, delete, a key typed by the person. */
import { WORKER_CHANNELS } from '../../shared/workers-channels'
import type { IpcMainLike } from '../ipc'
import type { WorkerStore } from './store'
import type { Supervisor } from './supervisor'

export function registerWorkersIpc(ipcMain: IpcMainLike, deps: { store: WorkerStore; supervisor: Supervisor; openPath: (path: string) => Promise<unknown> }): void {
  const { store, supervisor } = deps
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    [WORKER_CHANNELS.list]: () => supervisor.info(),
    [WORKER_CHANNELS.events]: (worker, limit) =>
      store.events({ ...(typeof worker === 'string' && worker !== '' ? { worker: idOf(worker) } : {}), limit: numberOf(limit, 100) }),
    [WORKER_CHANNELS.logs]: (id, limit) => store.logs(idOf(id), numberOf(limit, 200)),
    [WORKER_CHANNELS.start]: (id) => supervisor.startWorker(idOf(id)),
    [WORKER_CHANNELS.stop]: (id) => supervisor.stopWorker(idOf(id)),
    [WORKER_CHANNELS.restart]: (id) => supervisor.restart(idOf(id)),
    [WORKER_CHANNELS.remove]: (id) => supervisor.remove(idOf(id)),
    [WORKER_CHANNELS.setSecret]: (id, name, value) => {
      if (typeof name !== 'string' || typeof value !== 'string' || value.length > 20_000) throw new Error('A key needs a name and a value.')
      supervisor.setSecret(idOf(id), name, value.trim())
    },
    [WORKER_CHANNELS.openFolder]: async (id) => {
      await deps.openPath(store.dirOf(idOf(id)))
    },
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, ...args) => handler(...args))
  }
}

function idOf(raw: unknown): string {
  if (typeof raw !== 'string' || !/^w_[a-z0-9]{4,24}$/.test(raw)) throw new Error('Not a worker id.')
  return raw
}

function numberOf(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}
