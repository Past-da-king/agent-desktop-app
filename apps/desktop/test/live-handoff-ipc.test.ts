/** A phone's Live voice hand-off (origin live_voice, spoken, session) reaches the runner on the origin, over chat.send and chat.sendOnce. */
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
let origins: Array<{ text: string; target: string | undefined; origin: unknown }> = []
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
  origins = []
  const ipcMain: IpcMainLike = { handle: (channel, listener) => void handlers.set(channel, listener) }
  const chat: ChatRunner = {
    send: async (text: string, _attachments?: Attachment[], target?: string, origin?: unknown) => void origins.push({ text, target, origin }),
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

describe('live voice hand-off over the wire', () => {
  it('chat.send options carry it to the runner as origin.live', async () => {
    await invoke(CHANNELS.chat.send, 'Update the EOD report', [], undefined, { origin: 'live_voice', spoken: 'do the EOD', session: 's1' })
    expect(origins[0]?.origin).toMatchObject({ live: { spoken: 'do the EOD', session: 's1' } })
  })
  it('chat.sendOnce input carries it too, also inside meta', async () => {
    await invoke(CHANNELS.chat.sendOnce, { sendId: "send-live-1", sentAt: Date.now(), text: 'Check mail', meta: { origin: 'live_voice', spoken: 'any mail?' } })
    expect(origins[0]?.origin).toMatchObject({ live: { spoken: 'any mail?', session: '' } })
  })
  it('an ordinary send carries no live marker', async () => {
    await invoke(CHANNELS.chat.send, 'my own words')
    expect(origins[0]?.origin).toBeUndefined()
  })
})
