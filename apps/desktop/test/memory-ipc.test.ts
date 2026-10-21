import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { registerMemoryIpc } from '../src/main/memory/ipc'
import { MemoryService } from '../src/main/memory/service'
import { MemoryTidy, TidyFile } from '../src/main/memory/tidy'
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
    tidy: new MemoryTidy({
      store,
      upkeep: new UpkeepFile(null),
      file: new TidyFile(null),
      complete: async () => JSON.stringify({ memories: [{ kind: 'person', title: 'Alex Meyer', body: 'CEO of Example Co, the client.', topics: 'clients' }] }),
    }),
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
  it('tidies only a file the person picked, in the background, with progress', async () => {
    const file = join(dir, 'bank.json')
    writeFileSync(file, JSON.stringify({ source: 'Bank', memories: [{ id: 'a', title: 'Ben', text: 'Ben is the CEO.', kind: 'person', project: 'clients' }] }))
    expect(await invoke(MEMORY_CHANNELS.previewTidy, file, false)).toMatchObject({ ok: false, message: 'Choose the file first.' })
    await expect(invoke(MEMORY_CHANNELS.startTidy, file, false)).rejects.toThrow('Choose the file first.')
    expect(await invoke(MEMORY_CHANNELS.tidyState)).toBeNull()

    picked = file
    await invoke(MEMORY_CHANNELS.pickImport)
    expect(await invoke(MEMORY_CHANNELS.previewTidy, file, false)).toMatchObject({ ok: true, notes: 1, projects: 1, steps: 1 })
    expect(await invoke(MEMORY_CHANNELS.startTidy, file, false)).toMatchObject({ running: true, steps: 1 })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(await invoke(MEMORY_CHANNELS.tidyState)).toMatchObject({ running: false, finished: true, done: 1, added: 1, canUndo: true })
    expect((await store.list('memory')).map((row) => row.title)).toEqual(['Alex Meyer'])
    expect(await invoke(MEMORY_CHANNELS.undoTidy)).toEqual({ removed: 1, restored: 0 })
    expect(await store.list('memory')).toHaveLength(0)
  })

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
    // The main thread with nothing in it: nothing to start fresh from, so nothing is written.
    expect(await invoke(MEMORY_CHANNELS.newChat)).toEqual({ dividerId: null, saving: false })
    expect(await invoke(MEMORY_CHANNELS.newChat, { chat: 'main', from: 'main' })).toEqual({ dividerId: null, saving: false })
    expect(await store.list('chat_item')).toHaveLength(0)
    // A project's New chat opens a chat of its own, with a divider that files the one it left.
    expect(await invoke(MEMORY_CHANNELS.newChat, { chat: 'pcabcdef123456', from: 'main' })).toMatchObject({ saving: false })
    const divider = (await store.list('chat_item')).find((row) => row.kind === 'notice')
    expect(JSON.parse(divider?.meta ?? '{}')['chat']).toBe('pcabcdef123456')
    await expect(invoke(MEMORY_CHANNELS.newChat, { chat: '../x', from: 'main' })).rejects.toThrow('plain letters')
    expect(await invoke(MEMORY_CHANNELS.searchChats, 'anything', 3)).toEqual([])
    const report = (await invoke(MEMORY_CHANNELS.runDaily)) as { ok: boolean }
    expect(report.ok).toBe(true)
    expect(await invoke(MEMORY_CHANNELS.upkeep)).toMatchObject({ report: { ok: true }, history: [] })
  })
})
