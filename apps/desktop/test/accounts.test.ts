/**
 * Several AI accounts (plans and keys), picked per project for the agent and for its helpers; the old single choice
 * becomes the first account; a change of engine waits for the chat's next new chat.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, LEGACY_ACCOUNT, MAIN_CHAT, accountsOf, mainPickOf, pickModel, resolvePick, type AiAccount, type LlmProvider, type Settings } from '@agent/core'

import { AccountStore, keyFor, migrateLegacyAccount } from '../src/main/accounts'
import { FileBrainLocks } from '../src/main/brain-locks'
import { Store } from '../src/main/db'
import { Secrets } from '../src/main/secrets'
import { SettingsStore } from '../src/main/settings'
import { MemoryBrainLocks, brainFor, chatBrainOf, helperBrain, pickBrain, pickFor, type BrainDeps } from '../src/main/runtime/brains'

const dirs: string[] = []
function dir(): string {
  const made = mkdtempSync(join(tmpdir(), 'accounts-'))
  dirs.push(made)
  return made
}
afterEach(() => {
  for (const each of dirs.splice(0)) rmSync(each, { recursive: true, force: true })
})

const plain = { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() }

function fresh(patch: Partial<Settings> = {}): { settings: SettingsStore; secrets: Secrets } {
  const base = dir()
  const settings = new SettingsStore(join(base, 'settings.json'), { hostname: () => 'pc' })
  settings.save(patch)
  return { settings, secrets: new Secrets(join(base, 'secrets'), plain) }
}

const fakeProvider = (model: string): LlmProvider => ({ complete: async () => ({ message: { role: 'ASSISTANT', blocks: [{ t: 'text', text: model }] }, stopReason: 'end' }) }) as unknown as LlmProvider

function deps(settings: SettingsStore, secrets: Secrets, extra: Partial<BrainDeps> = {}): BrainDeps {
  return { settings, secrets, providerFactory: (current) => fakeProvider(current.model), hasCli: true, locks: new MemoryBrainLocks(), ...extra }
}

describe('the old single choice becomes an account', () => {
  it('moves an API key set-up and its key to account "default", once', () => {
    const { settings, secrets } = fresh({ mode: 'api_key', provider: 'opencode_go', model: 'deepseek-v4.1-flash', hasKey: true })
    secrets.set('apiKey', 'sk-old')
    const made = migrateLegacyAccount(settings, secrets)
    expect(made).toMatchObject({ id: LEGACY_ACCOUNT, kind: 'api', provider: 'opencode_go', model: 'deepseek-v4.1-flash', label: 'OpenCode Go', hasKey: true })
    expect(keyFor(secrets, LEGACY_ACCOUNT)).toBe('sk-old')
    expect(settings.get().ai.main).toEqual({ account: LEGACY_ACCOUNT, model: '' })
    // The old fields still read the same, for older code.
    expect(settings.get()).toMatchObject({ mode: 'api_key', provider: 'opencode_go', model: 'deepseek-v4.1-flash', hasKey: true })
    expect(migrateLegacyAccount(settings, secrets)).toBeNull()
  })

  it('a plan signed in beside an API key becomes a second account, ready to pick', () => {
    const { settings, secrets } = fresh({ mode: 'api_key', provider: 'opencode_go', model: 'deepseek-v4.1-flash', hasKey: true, cli: 'claude', cliModel: 'opus' })
    migrateLegacyAccount(settings, secrets)
    expect(settings.get().accounts.map((a) => [a.id, a.kind, a.model])).toEqual([[LEGACY_ACCOUNT, 'api', 'deepseek-v4.1-flash'], ['plan-claude', 'claude', 'opus']])
    expect(settings.get().ai.main.account).toBe(LEGACY_ACCOUNT)
  })

  it('moves a plan set-up, and does nothing on a fresh install', () => {
    const { settings, secrets } = fresh({ mode: 'subscription', cli: 'claude', cliModel: 'opus' })
    expect(migrateLegacyAccount(settings, secrets)).toMatchObject({ kind: 'claude', model: 'opus', label: 'Claude plan' })
    const empty = fresh()
    expect(migrateLegacyAccount(empty.settings, empty.secrets)).toBeNull()
    expect(accountsOf(empty.settings.get())).toEqual([])
  })

  it('reads the old fields as an account even before the move (tests and old views)', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, mode: 'api_key', provider: 'openai', model: 'fake-model', hasKey: true }
    expect(accountsOf(settings)).toHaveLength(1)
    expect(mainPickOf(settings, 'main')).toEqual({ account: LEGACY_ACCOUNT, model: '' })
    expect(pickModel(settings, mainPickOf(settings, 'helpers'))).toBe('fake-model')
  })
})

describe('the accounts list', () => {
  it('adds, changes, keys and removes accounts; the old fields follow the main pick', () => {
    const { settings, secrets } = fresh()
    const store = new AccountStore(settings, secrets)
    const go = store.add({ label: 'OpenCode Go', kind: 'api', provider: 'opencode_go', model: 'deepseek-v4.1-flash' })
    const claude = store.add({ kind: 'claude', model: 'opus' })
    expect(claude.label).toBe('Claude plan')
    expect(settings.get().ai.main.account).toBe(go.id)
    expect(settings.get()).toMatchObject({ mode: 'api_key', provider: 'opencode_go', model: 'deepseek-v4.1-flash', hasKey: false })

    store.setKey(go.id, 'sk-go')
    expect(store.find(go.id)?.hasKey).toBe(true)
    expect(store.key(go.id)).toBe('sk-go')
    expect(settings.get().hasKey).toBe(true)

    settings.save({ ai: { main: { account: claude.id, model: 'fable' }, helpers: { account: go.id, model: '' } } })
    expect(settings.get()).toMatchObject({ mode: 'subscription', cli: 'claude', cliModel: 'fable' })

    store.update(go.id, { label: 'Go', model: 'kimi-k3' })
    expect(store.find(go.id)).toMatchObject({ label: 'Go', model: 'kimi-k3', hasKey: true })

    store.remove(claude.id)
    expect(settings.get().ai.main.account).toBe(go.id)
    expect(settings.get().ai.helpers.account).toBe(go.id)
    store.remove(go.id)
    expect(store.all()).toEqual([])
    expect(settings.get()).toMatchObject({ mode: 'none', hasKey: false, ai: { main: { account: '', model: '' } } })
    expect(secrets.get('apiKey-' + go.id)).toBeNull()
  })

  it('onboarding writing the old fields updates the main account', () => {
    const { settings, secrets } = fresh({ mode: 'api_key', provider: 'openai', model: 'gpt-x', hasKey: true })
    migrateLegacyAccount(settings, secrets)
    settings.save({ mode: 'subscription', cli: 'codex', cliModel: '' })
    expect(accountsOf(settings.get())[0]).toMatchObject({ id: LEGACY_ACCOUNT, kind: 'codex', label: 'ChatGPT plan' })
  })

  it('drops accounts that are not accounts and keeps ids unique', () => {
    const { settings } = fresh()
    settings.save({ accounts: [{ id: 'a', label: 'A', kind: 'api', provider: 'openai', model: 'm', hasKey: false }, { id: 'a', label: 'B', kind: 'api', model: '', hasKey: false }, { id: '', label: 'x', kind: 'api', model: '', hasKey: false }, { id: 'b', kind: 'weird' } as unknown as AiAccount] })
    expect(settings.get().accounts.map((a) => a.id)).toEqual(['a'])
  })
})

describe('which AI a chat thinks with', () => {
  function world(): { settings: SettingsStore; secrets: Secrets; store: Store; go: AiAccount; claude: AiAccount; codex: AiAccount } {
    const { settings, secrets } = fresh()
    const accounts = new AccountStore(settings, secrets)
    const go = accounts.add({ label: 'OpenCode Go', kind: 'api', provider: 'opencode_go', model: 'deepseek-v4.1-flash' })
    accounts.setKey(go.id, 'sk-go')
    const claude = accounts.add({ kind: 'claude', model: 'opus' })
    const codex = accounts.add({ kind: 'codex' })
    settings.save({ ai: { main: { account: claude.id, model: 'fable' }, helpers: { account: go.id, model: '' } } })
    return { settings, secrets, store: new Store(':memory:'), go, claude, codex }
  }

  it('the main thread: its agent on one pick, its helpers on another; a project overrides either', async () => {
    const w = world()
    const d = deps(w.settings, w.secrets, { store: w.store })
    expect(await pickBrain(d, MAIN_CHAT)).toMatchObject({ kind: 'plan', cli: 'claude', model: 'fable' })
    expect(await helperBrain(d, MAIN_CHAT)).toMatchObject({ kind: 'api', model: 'deepseek-v4.1-flash' })

    const project = await w.store.upsert('project', { name: 'Creek', description: '', icon: { glyph: 'folder', color: 'iris' }, path: '', profile: '', hidden: false, chats: ['pc1'], ai: { main: { account: w.go.id, model: 'kimi-k3' }, helpers: { account: '', model: '' } } })
    expect(await pickBrain(d, 'pc1')).toMatchObject({ kind: 'api', model: 'kimi-k3' })
    // Helpers left as "same as the main thread" follow the project's own agent first.
    expect(await pickFor(d, 'pc1', 'helpers')).toEqual({ account: w.go.id, model: 'kimi-k3' })
    await w.store.upsert('project', { id: project.id, ai: { main: { account: '', model: '' }, helpers: { account: w.codex.id, model: '' } } })
    // Back to the main thread's plan: a change of family, so this chat stays on the key until its next new chat.
    expect(await pickBrain(d, 'pc1')).toMatchObject({ kind: 'api', model: 'kimi-k3' })
    expect((await chatBrainOf(d, 'pc1')).main).toMatchObject({ wanted: { account: w.claude.id }, deferred: true })
    expect(await helperBrain(d, 'pc1')).toMatchObject({ kind: 'plan', cli: 'codex' })
    w.store.close()
  })

  it('says plainly what is missing', () => {
    const { settings, secrets } = fresh()
    const accounts = new AccountStore(settings, secrets)
    const d = deps(settings, secrets)
    expect(brainFor(d, { account: '', model: '' })).toMatchObject({ kind: 'none', message: 'Add an AI key in Settings to start' })
    const api = accounts.add({ label: 'Mine', kind: 'api', provider: 'openai' })
    expect(brainFor(d, { account: api.id, model: '' })).toMatchObject({ kind: 'none', message: 'Mine has no API key yet. Add an AI key in Settings.' })
    const claude = accounts.add({ kind: 'claude' })
    expect(brainFor({ ...d, hasCli: false }, { account: claude.id, model: '' })).toMatchObject({ kind: 'none' })
    expect(brainFor(d, { account: claude.id, model: '' })).toMatchObject({ kind: 'plan', cli: 'claude', model: '' })
  })

  it('a change within the family applies at once; a change of family waits for the next new chat', async () => {
    const w = world()
    const locks = new MemoryBrainLocks()
    const d = deps(w.settings, w.secrets, { store: w.store, locks })
    await w.store.upsert('chat_item', { kind: 'user', text: 'hi', meta: '{}' })
    expect(await pickBrain(d, MAIN_CHAT)).toMatchObject({ kind: 'plan', cli: 'claude', model: 'fable' })
    // Same family: another model on the plan.
    w.settings.save({ ai: { ...w.settings.get().ai, main: { account: w.claude.id, model: 'opus' } } })
    expect(await pickBrain(d, MAIN_CHAT)).toMatchObject({ kind: 'plan', model: 'opus' })
    // Different family: the key. The chat stays on the plan, and the picker says so.
    w.settings.save({ ai: { ...w.settings.get().ai, main: { account: w.go.id, model: '' } } })
    expect(await pickBrain(d, MAIN_CHAT)).toMatchObject({ kind: 'plan', cli: 'claude', model: 'opus' })
    const brain = await chatBrainOf(d, MAIN_CHAT)
    expect(brain.main).toMatchObject({ wanted: { account: w.go.id }, using: { account: w.claude.id, model: 'opus' }, deferred: true })
    // Helpers switch at once.
    w.settings.save({ ai: { ...w.settings.get().ai, helpers: { account: w.codex.id, model: '' } } })
    expect(await helperBrain(d, MAIN_CHAT)).toMatchObject({ kind: 'plan', cli: 'codex' })
    // New chat: a divider; the switch lands.
    await w.store.upsert('chat_item', { kind: 'notice', text: 'New chat', meta: JSON.stringify({ divider: true, at: Date.now() }) })
    expect(await pickBrain(d, MAIN_CHAT)).toMatchObject({ kind: 'api', model: 'deepseek-v4.1-flash' })
    expect((await chatBrainOf(d, MAIN_CHAT)).main.deferred).toBe(false)
    w.store.close()
  })

  it('locks survive a restart', () => {
    const file = join(dir(), 'brain-locks.json')
    const locks = new FileBrainLocks(file)
    locks.set('main', { account: 'a1', model: 'opus', family: 'plan:claude', divider: 5 })
    expect(new FileBrainLocks(file).get('main')).toEqual({ account: 'a1', model: 'opus', family: 'plan:claude', divider: 5 })
    expect(new FileBrainLocks(file).get('other')).toBeNull()
  })
})

describe('picks', () => {
  it('a project pick falls back to the main thread, and helpers to the agent', () => {
    const settings: Settings = { ...DEFAULT_SETTINGS, accounts: [{ id: 'a', label: 'A', kind: 'api', provider: 'openai', model: 'm1', hasKey: true }, { id: 'b', label: 'B', kind: 'claude', model: '', hasKey: false }], ai: { main: { account: 'a', model: '' }, helpers: { account: '', model: '' } } }
    expect(resolvePick(settings, undefined, 'helpers')).toEqual({ account: 'a', model: '' })
    expect(resolvePick(settings, { main: { account: 'b', model: 'opus' }, helpers: { account: '', model: '' } }, 'helpers')).toEqual({ account: 'b', model: 'opus' })
    expect(resolvePick(settings, { main: { account: 'gone', model: '' }, helpers: { account: '', model: '' } }, 'main')).toEqual({ account: 'a', model: '' })
  })
})
