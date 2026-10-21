import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { registerMemoryIpc } from '../src/main/memory/ipc'
import { MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'
import { MEMORY_CHANNELS } from '../src/shared/memory-channels'

type Handler = (event: unknown, ...args: unknown[]) => unknown

let dir = ''
let store: Store
let index: ChatIndex
let handlers: Map<string, Handler>
let picked: string | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-memory-ipc-'))
  store = new Store(join(dir, 'agent.db'))
  index = new ChatIndex(join(dir, 'chat-search.db'))
  handlers = new Map()
  const service = new MemoryService({
    store,
    index,
    upkeep: new UpkeepFile(join(dir, 'memory-upkeep.json')),
    complete: async () => JSON.stringify({ where: '**Goals**\n- Keep going with the plan.', changes: [], memories: [] }),
  })
  registerMemoryIpc({
    ipcMain: { handle: (channel, listener) => handlers.set(channel, listener) },
    service,
    store,
    pickFile: async () => picked,
  })
})

afterEach(() => {
  index.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

describe('memory IPC', () => {
  it('registers every memory channel', () => {
    for (const channel of Object.values(MEMORY_CHANNELS)) expect(handlers.has(channel), channel).toBe(true)
  })

  it('imports only a file the person picked', async () => {
    const file = join(dir, 'bank.json')
    writeFileSync(file, JSON.stringify({ source: 'Bank', memories: [{ id: 'a', title: 'Ben', text: 'CEO.', kind: 'person' }] }))
    expect(await invoke(MEMORY_CHANNELS.previewImport, file, false)).toMatchObject({ ok: false, message: 'Choose the file first.' })

    picked = null
    expect(await invoke(MEMORY_CHANNELS.pickImport)).toBeNull()
    picked = file
    expect(await invoke(MEMORY_CHANNELS.pickImport)).toEqual({ path: file, name: 'bank.json' })
    expect(await invoke(MEMORY_CHANNELS.previewImport, file, false)).toMatchObject({ ok: true, byKind: { person: 1 } })
    expect(await invoke(MEMORY_CHANNELS.runImport, file, false)).toMatchObject({ ok: true, added: 1 })
    expect(await store.list('memory')).toHaveLength(1)
    await expect(invoke(MEMORY_CHANNELS.retrySave, 42)).rejects.toThrow('id must be text')
  })

  it('starts a new chat, searches chats and runs the daily pass', async () => {
    expect(await invoke(MEMORY_CHANNELS.newChat)).toMatchObject({ saving: false })
    expect(await invoke(MEMORY_CHANNELS.searchChats, 'anything', 3)).toEqual([])
    const report = (await invoke(MEMORY_CHANNELS.runDaily)) as { ok: boolean }
    expect(report.ok).toBe(true)
    expect(await invoke(MEMORY_CHANNELS.upkeep)).toMatchObject({ report: { ok: true }, history: [] })
  })
})
