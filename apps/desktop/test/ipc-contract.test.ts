import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { registerIpc, type IpcMainLike } from '../src/main/ipc'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { CHANNELS, EVENTS } from '../src/shared/channels'

type Handler = (event: unknown, ...args: unknown[]) => unknown

let dir = ''
let store: Store
let settings: SettingsStore
let secrets: Secrets
let account: AccountService
let runner: Runner
let handlers: Map<string, Handler>
let sent: Array<{ channel: string; payload: unknown }>
let dispose: (() => void) | null = null
let fakeAi: FakeAi | null = null
let windowCalls: string[]
let routineRuns: string[]

const storage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, 'utf8'),
  decryptString: (encrypted) => encrypted.toString('utf8'),
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-ipc-'))
  store = new Store(join(dir, 'agent.db'))
  settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-machine' })
  secrets = new Secrets(join(dir, 'secrets'), storage)
  account = new AccountService(store, settings, secrets, { autoStart: false })
  handlers = new Map()
  sent = []
  windowCalls = []
  routineRuns = []

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }

  runner = new Runner({
    store,
    settings,
    secrets,
    tools: buildToolset({ store }),
    providerFactory: () => null,
    emit: (event) => sent.push({ channel: EVENTS.chat, payload: event }),
  })

  dispose = registerIpc({
    store,
    settings,
    secrets,
    account,
    chat: runner,
    routines: {
      runNow: async (id) => {
        routineRuns.push(id)
      },
    },
    ipcMain,
    windows: {
      minimize: () => windowCalls.push('minimize'),
      toggleMaximize: () => windowCalls.push('toggleMaximize'),
      close: () => windowCalls.push('close'),
      isMaximized: () => true,
    },
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    dialogs: {
      pickFiles: async () => [{ path: '/tmp/report.txt', name: 'report.txt', mime: 'text/plain' }],
      pickFolder: async () => '/tmp/box',
    },
  })
})

afterEach(async () => {
  dispose?.()
  dispose = null
  runner.dispose()
  account.dispose()
  store.close()
  await fakeAi?.close()
  fakeAi = null
  rmSync(dir, { recursive: true, force: true })
})

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler for ${channel}`)
  return handler({}, ...args)
}

/** The methods the renderer can call: everything except its local `on*` subscriptions. */
const METHODS: Record<string, string[]> = {
  settings: ['get', 'save', 'providers', 'setApiKey', 'checkKey', 'reset'],
  account: ['signIn', 'signOut', 'firstSync', 'syncNow', 'status'],
  data: ['list', 'upsert', 'remove'],
  chat: ['send', 'stop', 'state', 'answer', 'decide'],
  routines: ['runNow'],
  window: ['minimize', 'toggleMaximize', 'close', 'isMaximized'],
  files: ['pick', 'pickFolder'],
  shell: ['openExternal', 'reveal'],
}

describe('registerIpc', () => {
  it('registers a handler for every AgentApi method', () => {
    for (const [group, methods] of Object.entries(METHODS)) {
      const channels = CHANNELS[group as keyof typeof CHANNELS] as unknown as Record<string, string>
      for (const method of methods) {
        const channel = channels[method]
        expect(channel, `${group}.${method} has no channel`).toBeTypeOf('string')
        expect(handlers.has(channel!), `${group}.${method} has no handler`).toBe(true)
      }
    }
  })

  it('round trips settings and broadcasts the change', async () => {
    const read = await invoke(CHANNELS.settings.get)
    expect(read).toMatchObject({ deviceName: 'test-machine', theme: 'system' })

    const saved = await invoke(CHANNELS.settings.save, { theme: 'dark', userName: 'Sam' })
    expect(saved).toMatchObject({ theme: 'dark', userName: 'Sam' })
    expect(settings.get().theme).toBe('dark')

    expect(sent.some((event) => event.channel === EVENTS.settings)).toBe(true)
  })

  it('creates, lists and removes data, notifying the renderer each time', async () => {
    const created = (await invoke(CHANNELS.data.upsert, 'memory', {
      title: 'A fact',
      body: 'The sky is blue',
      kind: 'fact',
    })) as { id: string; title: string }

    expect(created.title).toBe('A fact')
    const list = (await invoke(CHANNELS.data.list, 'memory')) as Array<{ id: string }>
    expect(list.map((row) => row.id)).toEqual([created.id])

    await invoke(CHANNELS.data.remove, 'memory', created.id)
    expect(await invoke(CHANNELS.data.list, 'memory')).toEqual([])
    expect(sent.filter((event) => event.channel === EVENTS.data)).toHaveLength(2)
  })

  it('rejects a bad entity and a row that is not an object', async () => {
    await expect(invoke(CHANNELS.data.list, 'not-an-entity')).rejects.toThrow('Unknown entity')
    await expect(invoke(CHANNELS.data.upsert, 'memory', 'nope')).rejects.toThrow(
      'row must be an object',
    )
  })

  it('checks a key against a real local provider server and explains a 401', async () => {
    fakeAi = await startFakeAi((_body, index) =>
      index === 0 ? { text: 'OK' } : { status: 401, text: 'invalid x-api-key' },
    )
    await invoke(CHANNELS.settings.save, {
      provider: 'anthropic',
      model: 'test-model',
      baseUrl: fakeAi.url,
    })
    await invoke(CHANNELS.settings.setApiKey, 'sk-local-test')

    expect(await invoke(CHANNELS.settings.checkKey)).toEqual({ ok: true, message: 'That key works.' })

    expect(await invoke(CHANNELS.settings.checkKey)).toEqual({
      ok: false,
      message: 'That key was not accepted.',
    })
  })

  it('drives the window controls through the injected window', async () => {
    await invoke(CHANNELS.window.minimize)
    await invoke(CHANNELS.window.toggleMaximize)
    await invoke(CHANNELS.window.close)
    expect(await invoke(CHANNELS.window.isMaximized)).toBe(true)
    expect(windowCalls).toEqual(['minimize', 'toggleMaximize', 'close'])
  })

  it('sends a chat message and answers with a notice when there is no key', async () => {
    await invoke(CHANNELS.chat.send, 'hello', [])
    const items = await store.list('chat_item')
    expect(items[0]).toMatchObject({ kind: 'user', text: 'hello' })
    expect(items.some((item) => item.kind === 'notice' && item.text.includes('Add an AI key'))).toBe(true)
    expect(sent.some((event) => event.channel === EVENTS.chat)).toBe(true)
    expect(await invoke(CHANNELS.chat.state)).toMatchObject({ running: false })
  })

  it('runs a routine on demand and validates its id', async () => {
    await invoke(CHANNELS.routines.runNow, 'routine-1')
    expect(routineRuns).toEqual(['routine-1'])
    await expect(invoke(CHANNELS.routines.runNow, 42)).rejects.toThrow('routine id must be text')
  })

  it('rejects a bad chat message', async () => {
    await expect(invoke(CHANNELS.chat.send, 42)).rejects.toThrow('message must be text')
    await expect(invoke(CHANNELS.chat.decide, 'x', 'maybe')).rejects.toThrow(
      'decision must be approve or decline',
    )
  })

  it('opens the real file and folder pickers through the injected dialogs', async () => {
    expect(await invoke(CHANNELS.files.pick)).toEqual([
      { path: '/tmp/report.txt', name: 'report.txt', mime: 'text/plain' },
    ])
    expect(await invoke(CHANNELS.files.pickFolder)).toBe('/tmp/box')
  })

  it('answers not implemented yet for files when no dialogs are injected', async () => {
    const localHandlers = new Map<string, Handler>()
    const stop = registerIpc({
      store,
      settings,
      secrets,
      account,
      chat: runner,
      ipcMain: {
        handle(channel, listener) {
          localHandlers.set(channel, listener)
        },
      },
      windows: {
        minimize: () => undefined,
        toggleMaximize: () => undefined,
        close: () => undefined,
        isMaximized: () => false,
      },
    })
    try {
      const pick = localHandlers.get(CHANNELS.files.pick)
      if (pick === undefined) throw new Error('no handler for files.pick')
      await expect(pick({})).rejects.toThrow('not implemented yet')
    } finally {
      stop()
    }
  })
})
