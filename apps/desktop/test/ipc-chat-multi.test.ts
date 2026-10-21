/** The IPC side of several chats and pasted files: arguments are checked, the chat id reaches the runner. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Attachment, ChatRunInfo, RunState } from '@agent/core'

import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { registerIpc, type ChatRunner, type IpcMainLike } from '../src/main/ipc'
import { savePastedFile } from '../src/main/pasted'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { CHANNELS } from '../src/shared/channels'

type Handler = (event: unknown, ...args: unknown[]) => unknown

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
}

let dir = ''
let store: Store
let handlers: Map<string, Handler>
let calls: string[]
let dispose: (() => void) | null = null

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-ipc-multi-'))
  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-machine' })
  const secrets = new Secrets(join(dir, 'secrets'), storage)
  const account = new AccountService(store, settings, secrets, { autoStart: false })
  handlers = new Map()
  calls = []
  const ipcMain: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) }
  const chat: ChatRunner = {
    send: async (text: string, _attachments?: Attachment[], target?: string) => void calls.push(`send:${text}:${target ?? '-'}`),
    stop: (target?: string) => void calls.push(`stop:${target ?? '-'}`),
    state: (target?: string): RunState => ({ running: target === 'cbusychat0001', waiting: [] }),
    states: (): ChatRunInfo[] => [{ chat: 'cbusychat0001', running: true, waiting: [], alongside: 1 }],
    branch: async (itemId: string) => {
      calls.push(`branch:${itemId}`)
      return 'cnewbranch0001'
    },
    answer: async () => undefined,
    decide: async () => undefined,
    tap: async () => undefined,
  }
  dispose = registerIpc({
    store,
    settings,
    secrets,
    account,
    chat,
    ipcMain,
    windows: { minimize: () => undefined, toggleMaximize: () => undefined, close: () => undefined, isMaximized: () => false },
    pasted: {
      save: async (name, mime, bytes) => savePastedFile(join(dir, 'attachments'), name, mime, bytes),
      clipboardFiles: async () => [{ path: join(dir, 'copied.pdf'), name: 'copied.pdf', mime: 'application/pdf', size: 10 }],
    },
  })
})

afterEach(() => {
  dispose?.()
  dispose = null
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('chat channels for several chats', () => {
  it('passes the chat id through, and leaves it out for the first chat', async () => {
    await invoke(CHANNELS.chat.send, 'hello', [], 'cbusychat0001')
    await invoke(CHANNELS.chat.send, 'hi', [], '')
    await invoke(CHANNELS.chat.send, 'old caller', [])
    await invoke(CHANNELS.chat.stop, 'cbusychat0001')
    await invoke(CHANNELS.chat.stop)
    expect(calls).toEqual(['send:hello:cbusychat0001', 'send:hi:-', 'send:old caller:-', 'stop:cbusychat0001', 'stop:-'])
    expect(await invoke(CHANNELS.chat.state, 'cbusychat0001')).toEqual({ running: true, waiting: [] })
    expect(await invoke(CHANNELS.chat.states)).toEqual([{ chat: 'cbusychat0001', running: true, waiting: [], alongside: 1 }])
    expect(await invoke(CHANNELS.chat.branch, 'item-1')).toBe('cnewbranch0001')
  })

  it('refuses chat ids that could name a folder outside the app', async () => {
    await expect(invoke(CHANNELS.chat.send, 'x', [], '../../etc')).rejects.toThrow('chat id must be plain')
    await expect(invoke(CHANNELS.chat.stop, 42)).rejects.toThrow('chat id must be text')
    await expect(invoke(CHANNELS.chat.branch, 7)).rejects.toThrow('message id must be text')
  })
})

describe('pasted files', () => {
  it('saves pasted bytes and makes them previewable', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const saved = (await invoke(CHANNELS.files.savePasted, 'Pasted image.png', 'image/png', png)) as Attachment
    expect(saved).toMatchObject({ name: 'Pasted image.png', mime: 'image/png', size: 8 })
    expect(await invoke(CHANNELS.files.thumbnail, saved.path)).toMatch(/^data:image\/png;base64,/)
  })

  it('checks what the renderer sends', async () => {
    await expect(invoke(CHANNELS.files.savePasted, 'a.png', 'image/png', 'not bytes')).rejects.toThrow('must be binary')
    await expect(invoke(CHANNELS.files.savePasted, 'a.bin', 'application/octet-stream', new Uint8Array(21 * 1024 * 1024))).rejects.toThrow('too big')
  })

  it('reads the files on the clipboard', async () => {
    expect(await invoke(CHANNELS.files.clipboardFiles)).toEqual([{ path: join(dir, 'copied.pdf'), name: 'copied.pdf', mime: 'application/pdf', size: 10 }])
  })
})
