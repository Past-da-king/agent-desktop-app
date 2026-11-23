/**
 * Plan accounts with their own sign-in homes: the home table and its migration, the one place the engines' folder
 * variables are set, identity and usage read from a home, failover rules, and the labels sent to other devices.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, accountLabels, failoverIds, type AiAccount, type AiAccountStatus, type Settings } from '@agent/core'

import { Store } from '../src/main/db'
import { Secrets } from '../src/main/secrets'
import { SettingsStore, picksFrom } from '../src/main/settings'
import { BundleKeeper } from '../src/main/devices/bundle'
import { AccountHomes, claudeIdentity, claudeLimitWindow, codexIdentity, codexUsage, engineHomeEnv, identityFromStatus, sharedHome } from '../src/main/runtime/account-home'

const SECRET = 'sk-SENTINEL-TOKEN-do-not-leak-0123456789'
let dir = ''
let home = ''

const plan = (id: string, kind: 'claude' | 'codex' = 'codex'): AiAccount => ({ id, label: id, kind, model: '', hasKey: false })
const api = (id: string): AiAccount => ({ id, label: id, kind: 'api', provider: 'anthropic', model: '', hasKey: true })

function homes(list: () => AiAccount[], env: NodeJS.ProcessEnv = {}): AccountHomes {
  return new AccountHomes({ file: join(dir, 'homes.json'), root: join(dir, 'accounts'), accounts: list, env, home })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-homes-'))
  home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('home table and migration', () => {
  it('the first account of each kind keeps the computer login; every other one gets its own folder', () => {
    const table = homes(() => [plan('a'), plan('b'), plan('c', 'claude'), plan('d', 'claude'), api('k')])
    expect(table.resolve('a', 'codex')).toEqual({ cli: 'codex', dir: join(home, '.codex'), shared: true })
    expect(table.resolve('b', 'codex')).toEqual({ cli: 'codex', dir: join(dir, 'accounts', 'b'), shared: false })
    expect(table.resolve('c', 'claude')).toEqual({ cli: 'claude', dir: join(home, '.claude'), shared: true })
    expect(table.resolve('d', 'claude').dir).toBe(join(dir, 'accounts', 'd'))
    expect(Object.keys(table.entries()).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('honours CODEX_HOME / CLAUDE_CONFIG_DIR already set on the computer as the shared home', () => {
    const table = homes(() => [plan('a'), plan('c', 'claude')], { CODEX_HOME: '/custom/codex', CLAUDE_CONFIG_DIR: '/custom/claude' })
    expect(table.resolve('a', 'codex').dir).toBe('/custom/codex')
    expect(table.resolve('c', 'claude').dir).toBe('/custom/claude')
    expect(sharedHome('codex', {}, '/h')).toBe(join('/h', '.codex'))
  })

  it('an account added after the migration never takes the shared login, even for a kind with no account yet', () => {
    let list: AiAccount[] = [plan('a')]
    const table = homes(() => list)
    table.resolve('a', 'codex')
    list = [plan('a'), plan('n', 'claude')]
    const fresh = table.resolve('n', 'claude')
    expect(fresh.shared).toBe(false)
    expect(fresh.dir).toBe(join(dir, 'accounts', 'n'))
  })

  it('does not migrate while there are no accounts (a node still waiting for its sync)', () => {
    let list: AiAccount[] = []
    const table = homes(() => list)
    table.migrate()
    list = [plan('a'), plan('b')]
    expect(table.resolve('a', 'codex').shared).toBe(true)
    expect(table.resolve('b', 'codex').shared).toBe(false)
  })

  it('no account named (an older caller): the computer login', () => {
    expect(homes(() => []).resolve(undefined, 'codex')).toEqual({ cli: 'codex', dir: join(home, '.codex'), shared: true })
  })

  it('forgetting an account removes its own folder and never the shared login', () => {
    const table = homes(() => [plan('a'), plan('b')])
    const mine = table.resolve('b', 'codex')
    writeFileSync(join(mine.dir, 'auth.json'), '{}')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), '{}')
    table.forget('b')
    table.forget('a')
    expect(() => readFileSync(join(mine.dir, 'auth.json'))).toThrow()
    expect(readFileSync(join(home, '.codex', 'auth.json'), 'utf8')).toBe('{}')
  })
})

describe('engineHomeEnv is the one place the sign-in variables are set', () => {
  it('a fresh Codex home sets CODEX_HOME only; a fresh Claude home sets CLAUDE_CONFIG_DIR only', () => {
    const base = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/stray', CODEX_HOME: '/stray2' }
    const codex = engineHomeEnv({ cli: 'codex', dir: '/x/a', shared: false }, base)
    expect(codex['CODEX_HOME']).toBe('/x/a')
    expect(codex['CLAUDE_CONFIG_DIR']).toBe('/stray')
    const claude = engineHomeEnv({ cli: 'claude', dir: '/x/b', shared: false }, base)
    expect(claude['CLAUDE_CONFIG_DIR']).toBe('/x/b')
    expect(claude['PATH']).toBe('/bin')
  })

  it('the shared login leaves the engine its default', () => {
    expect(engineHomeEnv({ cli: 'codex', dir: '/h/.codex', shared: true }, { PATH: '/bin' })['CODEX_HOME']).toBeUndefined()
    expect(engineHomeEnv({ cli: 'codex', dir: '/custom', shared: true }, { CODEX_HOME: '/custom' })['CODEX_HOME']).toBe('/custom')
  })

  it('no other source file sets them', () => {
    const files = ['runtime/cli-agent.ts', 'runtime/cli-host.ts', 'runtime/run-detail.ts', 'runtime/runner.ts', 'runtime/helpers.ts', 'index.ts']
    for (const file of files) {
      const text = readFileSync(join(__dirname, '..', 'src', 'main', file), 'utf8')
      expect(text, file).not.toMatch(/env\[['"](CLAUDE_CONFIG_DIR|CODEX_HOME)['"]\]\s*=/)
      expect(text, file).not.toMatch(/(CLAUDE_CONFIG_DIR|CODEX_HOME)\s*:\s*[^'\s]/)
    }
  })
})

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.sig`
}

describe('identity and usage come from the account home', () => {
  it('Codex: email and plan from the id token, signed out without a token', () => {
    const where = join(dir, 'c1')
    mkdirSync(where, { recursive: true })
    expect(codexIdentity(where).signedIn).toBe(false)
    writeFileSync(join(where, 'auth.json'), JSON.stringify({ tokens: { id_token: jwt({ email: 'info@example.org', 'https://api.openai.com/auth': { chatgpt_plan_type: 'team' } }), access_token: SECRET } }))
    expect(codexIdentity(where)).toEqual({ signedIn: true, email: 'info@example.org', plan: 'Team' })
    expect(JSON.stringify(codexIdentity(where))).not.toContain(SECRET)
  })

  it('Claude: signed in by the credentials file, email from the config beside it', () => {
    const where = join(dir, 'cl1')
    mkdirSync(where, { recursive: true })
    writeFileSync(join(where, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET, refreshToken: 'r', subscriptionType: 'max' } }))
    writeFileSync(join(where, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }))
    expect(claudeIdentity(where, false, home)).toEqual({ signedIn: true, email: 'a@example.com', plan: 'Max' })
    // The computer's own login keeps its account name beside the folder (~/.claude.json).
    const own = join(home, '.claude')
    mkdirSync(own, { recursive: true })
    writeFileSync(join(own, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET } }))
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'own@example.com' } }))
    expect(claudeIdentity(own, true, home).email).toBe('own@example.com')
    expect(claudeIdentity(own, false, home).email).toBe('')
  })

  it('reads email and plan from `claude auth status` json', () => {
    expect(identityFromStatus('{"loggedIn":true,"email":"x@y.z","subscriptionType":"pro"}')).toEqual({ email: 'x@y.z', plan: 'Pro' })
    expect(identityFromStatus('not json')).toEqual({ email: '', plan: '' })
  })

  it('Codex usage: used_percent and resets_at from the newest session file', () => {
    const sessions = join(dir, 'cx', 'sessions', '2026', '11', '23')
    mkdirSync(sessions, { recursive: true })
    const event = (used: number): string =>
      JSON.stringify({
        timestamp: '2026-11-23T10:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'token_count', rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_at: 1_795_000_000 }, secondary: { used_percent: 7.5, window_minutes: 10080, resets_at: 1_795_500_000 } } },
      })
    writeFileSync(join(sessions, 'rollout-2026-11-23T10-00-00-abc.jsonl'), `${JSON.stringify({ type: 'session_meta' })}\n${event(12)}\n${event(42)}\n`)
    const seen = codexUsage(join(dir, 'cx'))
    expect(seen.windows).toEqual([
      { label: '5 hours', usedPercent: 42, resetsAt: 1_795_000_000_000 },
      { label: 'Weekly', usedPercent: 7.5, resetsAt: 1_795_500_000_000 },
    ])
    expect(codexUsage(join(dir, 'none')).windows).toEqual([])
  })

  it('Claude rate limit report becomes a usage window', () => {
    expect(claudeLimitWindow({ rateLimitType: 'five_hour', utilization: 0.37, resetsAt: 1_795_000_000 })).toEqual({ label: '5 hours', usedPercent: 37, resetsAt: 1_795_000_000_000 })
    expect(claudeLimitWindow({ rateLimitType: 'seven_day', status: 'rejected' })?.usedPercent).toBe(100)
    expect(claudeLimitWindow({ status: 'allowed' })).toBeNull()
  })
})

describe('failover rules', () => {
  const base = (failover: Settings['ai']['failover']): Settings => ({
    ...DEFAULT_SETTINGS,
    accounts: [plan('a'), plan('b'), plan('c'), plan('x', 'claude'), api('k')],
    ai: { ...DEFAULT_SETTINGS.ai, failover },
  })

  it('is off until switched on, per role', () => {
    expect(failoverIds(base(undefined), 'main', 'a')).toEqual([])
    expect(failoverIds(base({ main: { on: true, order: [] } }), 'helpers', 'a')).toEqual([])
  })

  it('follows the set order, then the rest of the same kind; never another kind or an API key', () => {
    expect(failoverIds(base({ main: { on: true, order: ['c'] } }), 'main', 'a')).toEqual(['c', 'b'])
    expect(failoverIds(base({ main: { on: true, order: ['x', 'k', 'zzz', 'b'] } }), 'main', 'a')).toEqual(['b', 'c'])
    expect(failoverIds(base({ main: { on: true, order: [] } }), 'main', 'k')).toEqual([])
  })

  it('is stored cleaned: two roles, a boolean and short ids', () => {
    const picks = picksFrom({ main: { account: 'a', model: '' }, helpers: { account: '', model: '' }, failover: { main: { on: true, order: ['b', 'b', 5, '../x'] }, nope: { on: true, order: [] } } })
    expect(picks?.failover).toEqual({ main: { on: true, order: ['b', 'x'] } })
  })
})

describe('what is sent to the phone and linked computers', () => {
  const status: AiAccountStatus = { id: 'a', kind: 'codex', label: 'A', signedIn: true, email: 'e@x.y', plan: 'Plus', usage: [{ label: '5 hours', usedPercent: 3, resetsAt: null }], usageAt: 1, limited: false, sharedLogin: true }

  it('labels are built field by field', () => {
    const labels = accountLabels([{ ...status, ...({ token: SECRET, home: '/secret/path' } as object) } as AiAccountStatus])
    expect(labels).toEqual([{ id: 'a', kind: 'codex', label: 'A', email: 'e@x.y', plan: 'Plus', usage: [{ label: '5 hours', usedPercent: 3, resetsAt: null }], limited: false }])
    expect(JSON.stringify(labels)).not.toContain(SECRET)
    expect(JSON.stringify(labels)).not.toContain('/secret/path')
  })

  it('the state bundle carries labels and never the contents of an auth file or a home path', async () => {
    const authDir = join(dir, 'auth-home')
    mkdirSync(authDir, { recursive: true })
    writeFileSync(join(authDir, 'auth.json'), JSON.stringify({ tokens: { access_token: SECRET, refresh_token: SECRET } }))
    const store = new Store(':memory:')
    try {
      const settings = new SettingsStore(join(dir, 'settings.json'))
      settings.save({ accounts: [plan('a'), plan('b')] })
      const secrets = new Secrets(join(dir, 'secrets'), { isEncryptionAvailable: () => false, encryptString: (t: string) => Buffer.from(t), decryptString: (b: Buffer) => b.toString('utf8') })
      const keeper = new BundleKeeper({
        settings: { get: () => settings.get(), save: (patch) => settings.save(patch) },
        secrets,
        local: store,
        accountLabels: async () => accountLabels([status]),
      })
      const bundle = await keeper.build(false)
      expect(bundle.accountLabels).toEqual(accountLabels([status]))
      const wire = JSON.stringify(bundle)
      expect(wire).not.toContain(SECRET)
      expect(wire).not.toContain(authDir)
      expect(wire).not.toContain('account-homes')
      for (const account of bundle.accounts) expect(Object.keys(account)).not.toContain('home')
    } finally {
      store.close()
    }
  })
})
