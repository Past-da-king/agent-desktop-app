/**
 * The window's view of the Vault: list (no values), add and edit, delete, and the person's own show and copy.
 * Show and copy are the person's clicks in this window: a paired device may only list (shared/rpc-methods.ts).
 */
import type { VaultItemInput } from '@agent/core'

import { VAULT_CHANNELS } from '../../shared/vault-channels'
import type { IpcMainLike } from '../ipc'
import { importAos } from './aos-import'
import type { VaultStore } from './store'

export interface VaultIpcDeps {
  vault: VaultStore
  /** The system clipboard (absent on a headless node). */
  clipboard?: { write(text: string): void; read(): string | Promise<string> }
  /** How long a copied value stays on the clipboard. */
  clearAfterMs?: number
}

export function registerVaultIpc(ipcMain: IpcMainLike, deps: VaultIpcDeps): void {
  const { vault } = deps
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    [VAULT_CHANNELS.list]: () => vault.list(),
    [VAULT_CHANNELS.save]: (input) => {
      if (typeof input !== 'object' || input === null) throw new Error('That is not a vault item.')
      return vault.save(input as VaultItemInput, 'person')
    },
    [VAULT_CHANNELS.remove]: (id) => {
      vault.remove(idOf(id), 'person')
    },
    [VAULT_CHANNELS.reveal]: (id, field) => {
      const hit = vault.resolve(idOf(id), typeof field === 'string' && field !== '' ? field : undefined)
      if ('error' in hit) throw new Error(hit.error)
      vault.log(hit.item.id, 'reveal', 'person')
      return hit.value
    },
    [VAULT_CHANNELS.copy]: (id, field) => {
      const clipboard = deps.clipboard
      if (clipboard === undefined) throw new Error('There is no clipboard here.')
      const hit = vault.resolve(idOf(id), typeof field === 'string' && field !== '' ? field : undefined)
      if ('error' in hit) throw new Error(hit.error)
      clipboard.write(hit.value)
      vault.log(hit.item.id, 'copy', 'person')
      const value = hit.value
      const timer = setTimeout(() => {
        void Promise.resolve()
          .then(() => clipboard.read())
          .then((now) => {
            if (now === value) clipboard.write('')
          })
          .catch(() => undefined)
      }, deps.clearAfterMs ?? 30_000)
      timer.unref?.()
    },
    [VAULT_CHANNELS.audit]: (limit) => vault.audit(typeof limit === 'number' ? limit : 100),
    [VAULT_CHANNELS.importAos]: (folder) => importAos(vault, typeof folder === 'string' ? folder : undefined, 'person'),
  }
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_event, ...args) => handler(...args))
  }
}

function idOf(raw: unknown): string {
  if (typeof raw !== 'string' || !/^v_[a-f0-9]{4,24}$/.test(raw)) throw new Error('Not a vault item id.')
  return raw
}
