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

interface Rig {
  dir: string
  store: Store
  settings: SettingsStore
  secrets: Secrets
  account: AccountService
}

const temps: string[] = []
const rigs: Rig[] = []
let closeServer: (() => Promise<void>) | null = null

function makeRig(autoStart = false): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'agent-onboarding-'))
  temps.push(dir)
  const store = new Store(join(dir, 'agent.db'))
  const settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test-desktop' })
  const secrets = new Secrets(join(dir, 'secrets'), fakeStorage())
  const account = new AccountService(store, settings, secrets, { autoStart, pollWaitSeconds: 1 })
  const rig = { dir, store, settings, secrets, account }
  rigs.push(rig)
  return rig
}

afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.account.dispose()
    rig.store.close()
  }
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  await closeServer?.()
  closeServer = null
})

describe('onboarding flow', () => {
  it('registers, reports the first sync per kind, and saves the finished settings', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const rig = makeRig()

    const created = await rig.account.signIn({
      serverUrl: server.url,
      email: 'sam@example.test',
      password: 'secret1',
      mode: 'register',
    })
    expect(created).toEqual({ ok: true })
    expect(rig.settings.get()).toMatchObject({
      signedIn: true,
      syncEmail: 'sam@example.test',
      syncUrl: server.url,
      onboarded: false,
    })

    // Stop the background loop so the first sync below is the only pass that runs.
    rig.account.dispose()
    const restarted = new AccountService(rig.store, rig.settings, rig.secrets, {
      autoStart: false,
      pollWaitSeconds: 1,
    })
    rigs.push({ ...rig, account: restarted })

    // Another computer puts rows on the server before this one runs its first sync.
    const token = rig.secrets.get('syncToken') ?? ''
    expect(token).not.toBe('')
    const otherStore = new Store(join(rig.dir, 'other.db'))
    const otherEngine = new SyncEngine(otherStore, () => new SyncClient(server.url, token))
    await otherStore.upsert('memory', { title: 'Likes oat milk', kind: 'preference' })
    await otherStore.upsert('memory', { title: 'Lives in Durban', kind: 'fact' })
    await otherStore.upsert('task', { title: 'Book the train', status: 'todo', owner: 'user' })
    await otherStore.upsert('goal', { title: 'Move house', status: 'open' })
    await otherStore.upsert('trigger', {
      name: 'Morning brief',
      kind: 'daily',
      spec: '07:00',
      prompt: 'Brief me',
      enabled: true,
    })
    await otherStore.upsert('chat_item', { kind: 'user', text: 'Hello' })
    expect(await otherEngine.syncOnce()).toBe(true)
    otherStore.close()

    const progress: SyncProgress[] = []
    restarted.onProgress((event) => progress.push(event))
    const status = await restarted.firstSync()

    expect(status.signedIn).toBe(true)
    expect(status.error).toBeNull()
    expect(progress[0]?.phase).toBe('connecting')
    expect(progress.some((event) => event.phase === 'pulling')).toBe(true)
    expect(progress[progress.length - 1]).toMatchObject({
      phase: 'done',
      counts: { memory: 2, task: 1, goal: 1, trigger: 1, chat_item: 1 },
    })
    expect((await rig.store.list('memory')).map((row) => row.title).sort()).toEqual([
      'Likes oat milk',
      'Lives in Durban',
    ])
    expect(await rig.store.list('task')).toHaveLength(1)

    // The style step writes these, then the app opens Home.
    const saved = rig.settings.save({
      userName: 'Sam',
      agentName: 'Nova',
      accent: 'rose',
      mascot: 'ghost',
      theme: 'dark',
      mode: 'api_key',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      onboarded: true,
    })
    expect(saved).toMatchObject({ userName: 'Sam', agentName: 'Nova', accent: 'rose', theme: 'dark' })
    expect(saved.onboarded).toBe(true)

    const fromDisk = new SettingsStore(join(rig.dir, 'settings.json'), { hostname: () => 'test-desktop' })
    expect(fromDisk.get()).toMatchObject({
      onboarded: true,
      userName: 'Sam',
      agentName: 'Nova',
      syncEmail: 'sam@example.test',
      signedIn: true,
    })

    restarted.dispose()
  })

  it('reports server mistakes in plain words', async () => {
    const server = await startFakeSyncServer()
    closeServer = server.close
    const owner = makeRig()
    await owner.account.signIn({
      serverUrl: server.url,
      email: 'taken@example.test',
      password: 'secret1',
      mode: 'register',
    })

    const duplicate = makeRig()
    expect(
      await duplicate.account.signIn({
        serverUrl: server.url,
        email: 'taken@example.test',
        password: 'secret1',
        mode: 'register',
      }),
    ).toEqual({
      ok: false,
      error: 'There is already an account with that email. Try signing in.',
    })

    expect(
      await duplicate.account.signIn({
        serverUrl: server.url,
        email: 'taken@example.test',
        password: 'not-the-password',
        mode: 'login',
      }),
    ).toEqual({ ok: false, error: 'That email and password do not match.' })

    await server.close()
    closeServer = null
    expect(
      await duplicate.account.signIn({
        serverUrl: server.url,
        email: 'other@example.test',
        password: 'secret1',
        mode: 'register',
      }),
    ).toEqual({
      ok: false,
      error: 'Could not reach the sync server. Check the address, or use this computer only.',
    })
  })
})
