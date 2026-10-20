import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SyncClient, SyncEngine, type SyncProgress } from '../../../packages/core/src/index'
import { startFakeSyncServer } from '../../../packages/core/test/helpers'
import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'

/**
 * The onboarding flow exactly as the four screens drive it: create an account, run the first
 * sync and watch the per-kind progress, then save the style choices with `onboarded: true`.
 * The sync service is the real fake server over HTTP, not a mocked fetch.
 */

interface Stack {
  dir: string
  store: Store
  settings: SettingsStore
  secrets: Secrets
  account: AccountService
}

function fakeStorage(): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`vault:${plain}`, 'utf8'),
    decryptString: (encrypted) => {
      const text = encrypted.toString('utf8')
      if (!text.startsWith('vault:')) throw new Error('not encrypted')
      return text.slice('vault:'.length)
    },
  }
}

const dirs: string[] = []
const stacks: Stack[] = []
let closeServer: (() => Promise<void>) | null = null

function makeStack(): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'agent-onboarding-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'onboarding-test' })
  const secrets = new Secrets(join(dir, 'secrets'), fakeStorage())
  const account = new AccountService(store, settings, secrets, { autoStart: false, pollWaitSeconds: 1 })
  const stack = { dir, store, settings, secrets, account }
  stacks.push(stack)
  return stack
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.account.dispose()
    stack.store.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  await closeServer?.()
  closeServer = null
})

describe('onboarding flow', () => {
  it('registers, counts the first sync per kind and saves onboarded settings', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const stack = makeStack()

    const signIn = await stack.account.signIn({
      serverUrl: server.url,
      email: 'flow@example.com',
      password: 'secret1',
      mode: 'register',
    })
    expect(signIn).toEqual({ ok: true })
    expect(stack.settings.get()).toMatchObject({
      signedIn: true,
      syncEmail: 'flow@example.com',
      syncUrl: server.url,
    })
    expect(stack.secrets.get('syncToken')).toBeTruthy()

    // Another device on the same account writes one row of three kinds.
    const token = stack.secrets.get('syncToken') ?? ''
    const otherStore = new Store(join(stack.dir, 'other.db'))
    const otherEngine = new SyncEngine(otherStore, () => new SyncClient(server.url, token))
    await otherStore.upsert('memory', { title: 'The good cafe', kind: 'fact' })
    await otherStore.upsert('goal', { title: 'Find a quiet place to work' })
    await otherStore.upsert('task', { title: 'Book the table', owner: 'user' })
    await otherStore.upsert('trigger', { name: 'Morning brief', kind: 'daily', spec: '07:00', prompt: 'Summarise today' })
    expect(await otherEngine.syncOnce()).toBe(true)
    otherStore.close()

    const progress: SyncProgress[] = []
    const off = stack.account.onProgress((event) => progress.push(event))
    try {
      const status = await stack.account.firstSync()
      expect(status.signedIn).toBe(true)
      expect(status.error).toBeNull()
    } finally {
      off()
    }

    expect(progress[0]?.phase).toBe('connecting')
    expect(progress.some((event) => event.phase === 'pulling')).toBe(true)
    expect(progress[progress.length - 1]).toMatchObject({
      phase: 'done',
      counts: { memory: 1, goal: 1, task: 1, trigger: 1 },
    })

    const saved = stack.settings.save({
      userName: 'Sam',
      agentName: 'Nova',
      accent: 'ocean',
      mascot: 'ghost',
      theme: 'dark',
      mode: 'api_key',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      onboarded: true,
    })
    expect(saved).toMatchObject({ onboarded: true, userName: 'Sam', agentName: 'Nova', accent: 'ocean' })

    // A reload reads the same choices back from disk.
    const reread = new SettingsStore(join(stack.dir, 'settings.json'), { hostname: () => 'onboarding-test' })
    expect(reread.get()).toMatchObject({
      onboarded: true,
      signedIn: true,
      syncEmail: 'flow@example.com',
      userName: 'Sam',
      agentName: 'Nova',
      accent: 'ocean',
      mascot: 'ghost',
      model: 'claude-sonnet-5-5',
    })
  })

  it('turns a taken email, a wrong password and an unreachable server into plain words', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const stack = makeStack()

    expect(
      await stack.account.signIn({
        serverUrl: server.url,
        email: 'taken@example.com',
        password: 'secret1',
        mode: 'register',
      }),
    ).toEqual({ ok: true })
    stack.account.dispose()

    const second = makeStack()
    expect(
      await second.account.signIn({
        serverUrl: server.url,
        email: 'taken@example.com',
        password: 'secret1',
        mode: 'register',
      }),
    ).toEqual({ ok: false, error: 'There is already an account with that email. Try signing in.' })

    expect(
      await second.account.signIn({
        serverUrl: server.url,
        email: 'taken@example.com',
        password: 'wrong-one',
        mode: 'login',
      }),
    ).toEqual({ ok: false, error: 'That email and password do not match.' })
  })

  it('explains an empty or unreachable sync address instead of hanging', async () => {
    const stack = makeStack()

    expect(
      await stack.account.signIn({
        serverUrl: '',
        email: 'person@example.com',
        password: 'secret1',
        mode: 'login',
      }),
    ).toEqual({
      ok: false,
      error: 'Add the address of your sync server under Advanced, or use this computer only.',
    })

    expect(
      await stack.account.signIn({
        serverUrl: 'http://127.0.0.1:1',
        email: 'person@example.com',
        password: 'secret1',
        mode: 'login',
      }),
    ).toEqual({
      ok: false,
      error: 'Could not reach the sync server. Check the address, or use this computer only.',
    })

    expect(stack.settings.get().signedIn).toBe(false)
    expect(stack.secrets.get('syncToken')).toBeNull()
  })
})
