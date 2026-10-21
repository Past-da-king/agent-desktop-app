/**
 * The memory handlers the window can reach. The renderer is untrusted: it may only import a file the person picked
 * in the OS dialog during this session, and every argument is checked.
 */
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import type { MemoryImportPreview, UpkeepSummary } from '@agent/core'

import { MEMORY_CHANNELS } from '../../shared/memory-channels'
import type { IpcMainLike } from '../ipc'
import { parseExport, planImport, runImport, type BatchingStore } from './importer'
import type { MemoryService } from './service'

export interface MemoryIpcDeps {
  ipcMain: IpcMainLike
  service: MemoryService
  store: BatchingStore
  /** The OS file picker for a .json export. */
  pickFile?: () => Promise<string | null>
  log?: (message: string, detail?: Record<string, string | number>) => void
}

const MAX_IMPORT_BYTES = 200 * 1024 * 1024

export function registerMemoryIpc(deps: MemoryIpcDeps): void {
  const { ipcMain, service } = deps
  const picked = new Set<string>()

  ipcMain.handle(MEMORY_CHANNELS.newChat, async (_event, target) => {
    // Several chats at once: which chat New chat opened and which it left (plain ids; see runtime/chat-lines.ts).
    if (target === undefined || target === null) return service.newChat()
    if (typeof target !== 'object') throw new Error('new chat target must be an object')
    const chat = text((target as Record<string, unknown>)['chat'], 'chat id', 64)
    const from = text((target as Record<string, unknown>)['from'], 'chat id', 64)
    if (!/^[A-Za-z0-9_-]+$/.test(chat) || !/^[A-Za-z0-9_-]+$/.test(from)) throw new Error('chat id must be plain letters and digits')
    return service.newChat({ chat, from })
  })

  ipcMain.handle(MEMORY_CHANNELS.retrySave, async (_event, id) => {
    await service.retrySave(text(id, 'id', 128))
  })

  ipcMain.handle(MEMORY_CHANNELS.pickImport, async () => {
    const path = (await deps.pickFile?.()) ?? null
    if (path === null) return null
    picked.add(path)
    return { path, name: basename(path) }
  })

  const readPicked = async (raw: unknown): Promise<string> => {
    const path = text(raw, 'path', 4096)
    if (!picked.has(path)) throw new Error('Choose the file first.')
    const info = await stat(path)
    if (info.size > MAX_IMPORT_BYTES) throw new Error('That file is too big to import.')
    return readFile(path, 'utf8')
  }

  ipcMain.handle(MEMORY_CHANNELS.previewImport, async (_event, path, includeAll): Promise<MemoryImportPreview> => {
    try {
      return planImport(parseExport(await readPicked(path)), includeAll === true).preview
    } catch (error) {
      return failedPreview(error)
    }
  })

  ipcMain.handle(MEMORY_CHANNELS.runImport, async (_event, path, includeAll) => {
    try {
      const result = await runImport(deps.store, await readPicked(path), includeAll === true)
      deps.log?.('Memory imported', { added: result.added, updated: result.updated, unchanged: result.unchanged, deletedHere: result.deletedHere, redacted: result.redacted, ms: result.ms })
      return result
    } catch (error) {
      return { ...failedPreview(error), added: 0, updated: 0, unchanged: 0, deletedHere: 0, redacted: 0, ms: 0 }
    }
  })

  ipcMain.handle(MEMORY_CHANNELS.searchChats, async (_event, query, limit) => {
    const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.min(25, Math.max(1, Math.trunc(limit))) : 5
    return service.searchChats(text(query, 'query', 500), count)
  })

  ipcMain.handle(MEMORY_CHANNELS.runDaily, async () => service.runNow())

  ipcMain.handle(MEMORY_CHANNELS.upkeep, async (): Promise<UpkeepSummary> => {
    const state = service.upkeepState()
    return { report: state.report, lastRunAt: state.lastRunAt, history: state.history }
  })

  ipcMain.handle(MEMORY_CHANNELS.undoChange, async (_event, id) => service.undo(text(id, 'id', 128)))
}

function failedPreview(error: unknown): MemoryImportPreview {
  return {
    ok: false,
    message: error instanceof Error ? error.message : 'Could not read that file.',
    source: '',
    total: 0,
    byKind: {},
    skippedRetired: 0,
    skippedTransient: 0,
    invalid: 0,
  }
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${name} must be text`)
  if (value.length > max) throw new Error(`${name} is too long`)
  return value
}
