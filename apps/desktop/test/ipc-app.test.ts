import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AppInfo } from '@agent/core'

import { AccountService } from '../src/main/account'
import { APP_NAME, LICENCES_URL } from '../src/main/app-info'
import { Store } from '../src/main/db'
import { registerIpc, type IpcMainLike } from '../src/main/ipc'
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
let account: AccountService
let handlers: Map<string, Handler>
let opened: string[]
let dispose: (() => void) | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-ipc-app-'))
  store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-machine' })
  const secrets = new Secrets(join(dir, 'secrets'), storage)
  account = new AccountService(store, settings, secrets, { autoStart: false })
  handlers = new Map()
  opened = []

  const ipcMain: IpcMainLike = {
    handle(channel, listener) {
      handlers.set(channel, listener)
    },
  }

  const info: AppInfo = {
    name: APP_NAME,
    version: '9.9.9',
    platform: 'linux',
    electron: '1.2.3',
    logsPath: join(dir, 'logs'),
    licencesUrl: LICENCES_URL,
  }

  dispose = registerIpc({
    store,
    settings,
    secrets,
    account,
    ipcMain,
    windows: {
      minimize: () => undefined,
      toggleMaximize: () => undefined,
      close: () => undefined,
      isMaximized: () => false,
    },
    appInfo: () => info,
    openLogsFolder: () => {
      opened.push('logs')
    },
    openLicences: () => {
      opened.push('licences')
    },
  })
})

afterEach(() => {
  dispose?.()
  dispose = null
  account.dispose()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

async function invoke(channel: string): Promise<unknown> {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`no handler for ${channel}`)
  return handler({})
}

describe('app IPC group', () => {
  it('registers all three About channels', () => {
    expect(Object.keys(CHANNELS.app).sort()).toEqual(['info', 'openLicences', 'openLogsFolder'])
    for (const channel of Object.values(CHANNELS.app)) expect(handlers.has(channel)).toBe(true)
  })

  it('returns the version, platform and logs path for the About dialog', async () => {
    expect(await invoke(CHANNELS.app.info)).toMatchObject({
      name: 'Agent',
      version: '9.9.9',
      platform: 'linux',
      logsPath: join(dir, 'logs'),
    })
  })

  it('opens the logs folder through the injected shell', async () => {
    await invoke(CHANNELS.app.openLogsFolder)
    expect(opened).toEqual(['logs'])
  })

  it('opens the licence page through the injected shell', async () => {
    await invoke(CHANNELS.app.openLicences)
    expect(opened).toEqual(['licences'])
  })

  it('returns safe defaults when a caller does not inject app details', async () => {
    dispose?.()
    dispose = null
    const fallback = new Map<string, Handler>()
    const minimal = new Store(join(dir, 'fallback.db'))
    const settings = new SettingsStore(join(dir, 'fallback-settings.json'), {
      hostname: () => 'test-machine',
    })
    const secrets = new Secrets(join(dir, 'fallback-secrets'), storage)
    const fallbackAccount = new AccountService(minimal, settings, secrets, { autoStart: false })
    dispose = registerIpc({
      store: minimal,
      settings,
      secrets,
      account: fallbackAccount,
      ipcMain: {
        handle(channel, listener) {
          fallback.set(channel, listener)
        },
      },
      windows: {
        minimize: () => undefined,
        toggleMaximize: () => undefined,
        close: () => undefined,
        isMaximized: () => false,
      },
    })
    const handler = fallback.get(CHANNELS.app.info)
    const info = (await handler?.({})) as AppInfo
    expect(info.name).toBe('Agent')
    expect(info.version).toBe('0.0.0')
    expect(info.licencesUrl).toBe(LICENCES_URL)
    fallbackAccount.dispose()
    minimal.close()
  })
})
