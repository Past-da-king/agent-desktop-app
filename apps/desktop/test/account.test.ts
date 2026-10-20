import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { SyncClient, SyncEngine, type SyncProgress } from '../../../packages/core/src/index'
import { startFakeSyncServer, waitFor } from '../../../packages/core/test/helpers'
import { AccountService } from '../src/main/account'
import { Store } from '../src/main/db'
import { Secrets, type SafeStorageLike } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'

interface Stack {
  dir: string
  store: Store
  settings: SettingsStore
  secrets: Secrets
  account: AccountService
}

const dirs: string[] = []
const stacks: Stack[] = []
let closeServer: (() => Promise<void>) | null = null

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

function makeStack(options: { autoStart?: boolean } = {}): Stack {
  const dir = mkdtempSync(join(tmpdir(), 'agent-account-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-machine' })
  const secrets = new Secrets(join(dir, 'secrets'), fakeStorage())
  const account = new AccountService(store, settings, secrets, {
    autoStart: options.autoStart ?? false,
    pollWaitSeconds: 1,
  })
  const stack = { dir, store, settings, secrets, account }
  stacks.push(stack)
  return stack
}

function restart(stack: Stack, autoStart = true): AccountService {
  return new AccountService(stack.store, stack.settings, stack.secrets, {
    autoStart,
    pollWaitSeconds: 1,
  })
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    stack.account.dispose()
    stack.store.close()
  }
  for (const stack of dirs.splice(0)) rmSync(stack, { recursive: true, force: true })
  await closeServer?.()
  closeServer = null
})

describe('AccountService', () => {
  it('registers an account and saves the token, email and server address', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const stack = makeStack()

    const result = await stack.account.signIn({
      serverUrl: server.url,
      email: 'new@example.com',
      password: 'secret1',
      mode: 'register',
    })

    expect(result).toEqual({ ok: true })
    expect(stack.settings.get()).toMatchObject({
      signedIn: true,
      syncEmail: 'new@example.com',
      syncUrl: server.url,
    })
    expect(stack.secrets.get('syncToken')).toBeTruthy()
    expect(stack.account.status().signedIn).toBe(true)
  })

  it('rejects bad details before calling the server', async () => {
    const stack = makeStack()
    const server = await startFakeSyncServer()
    closeServer = server.close

    expect(
      await stack.account.signIn({
        serverUrl: server.url,
        email: 'not-an-email',
        password: 'secret1',
        mode: 'login',
      }),
    ).toEqual({ ok: false, error: 'That email address does not look right.' })

    expect(
      await stack.account.signIn({
        serverUrl: server.url,
        email: 'a@b.com',
        password: '123',
        mode: 'login',
      }),
    ).toEqual({ ok: false, error: 'Use a password of at least 6 characters.' })

    expect(server.stats.requests).toBe(0)
  })

  it('reports a wrong password in plain words', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const owner = makeStack()
    await owner.account.signIn({
      serverUrl: server.url,
      email: 'taken@example.com',
      password: 'secret1',
      mode: 'register',
    })
    owner.account.dispose()

    const other = makeStack()
    const result = await other.account.signIn({
      serverUrl: server.url,
      email: 'taken@example.com',
      password: 'wrong-one',
      mode: 'login',
    })

    expect(result).toEqual({ ok: false, error: 'That email and password do not match.' })
  })

  it('signing out clears the token but keeps local data', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const stack = makeStack()
    await stack.account.signIn({
      serverUrl: server.url,
      email: 'keep@example.com',
      password: 'secret1',
      mode: 'register',
    })
    await stack.store.upsert('memory', { title: 'Still here', kind: 'fact' })

    await stack.account.signOut()

    expect(stack.secrets.get('syncToken')).toBeNull()
    expect(stack.settings.get().signedIn).toBe(false)
    expect(stack.settings.get().syncEmail).toBeNull()
    expect(await stack.store.list('memory')).toHaveLength(1)
    expect(stack.account.status().signedIn).toBe(false)
  })

  it('reports per-entity counts on the first sync', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const stack = makeStack()
    await stack.account.signIn({
      serverUrl: server.url,
      email: 'counts@example.com',
      password: 'secret1',
      mode: 'register',
    })
    stack.account.dispose()

    const token = stack.secrets.get('syncToken') ?? ''
    const otherStore = new Store(join(stack.dir, 'other.db'))
    const otherEngine = new SyncEngine(otherStore, () => new SyncClient(server.url, token))
    await otherStore.upsert('memory', { title: 'One', kind: 'fact' })
    await otherStore.upsert('memory', { title: 'Two', kind: 'fact' })
    await otherStore.upsert('goal', { title: 'A goal' })
    expect(await otherEngine.syncOnce()).toBe(true)
    otherStore.close()

    const restarted = restart({ ...stack, account: stack.account }, false)
    const progress: SyncProgress[] = []
    restarted.onProgress((event) => progress.push(event))

    try {
      const status = await restarted.firstSync()
      expect(status.signedIn).toBe(true)
      expect(status.error).toBeNull()
      expect(progress[0]?.phase).toBe('connecting')
      expect(progress[progress.length - 1]).toMatchObject({
        phase: 'done',
        counts: { memory: 2, goal: 1 },
      })
      expect((await stack.store.list('memory')).map((row) => row.title).sort()).toEqual([
        'One',
        'Two',
      ])
    } finally {
      restarted.dispose()
      stacks.push({ ...stack, account: restarted })
    }
  })

  it('resumes syncing from a saved token after a restart', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const stack = makeStack()
    await stack.account.signIn({
      serverUrl: server.url,
      email: 'resume@example.com',
      password: 'secret1',
      mode: 'register',
    })
    await stack.store.upsert('memory', { title: 'From this computer', kind: 'fact' })
    await stack.account.syncNow()
    stack.account.dispose()

    const token = stack.secrets.get('syncToken') ?? ''
    const otherStore = new Store(join(stack.dir, 'other.db'))
    const otherEngine = new SyncEngine(otherStore, () => new SyncClient(server.url, token))
    await otherStore.upsert('memory', { title: 'From the other device', kind: 'fact' })
    await otherEngine.syncOnce()
    otherStore.close()

    const resumed = restart(stack)
    stacks.push({ ...stack, account: resumed })
    try {
      await waitFor(
        async () =>
          (await stack.store.list('memory')).some((row) => row.title === 'From the other device'),
        5_000,
      )
      expect(resumed.status().signedIn).toBe(true)
    } finally {
      resumed.dispose()
    }
  })
})
