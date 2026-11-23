/**
 * Many plan accounts of one kind (23 Nov 2026). Runs the real CliHost against a stand-in Codex engine (a tiny script
 * that answers with the sign-in home it was started with), so what is proven is what the engine would really see:
 *  - every account runs in its own CODEX_HOME, a fresh one is NOT signed in (it must not borrow ~/.codex);
 *  - the first account of a kind keeps the computer's own login (migration in place), later ones get fresh homes;
 *  - failover moves a run to the next signed-in account of the same kind when one hits its limit, and logs which ran;
 *  - nothing returned for the phone holds an auth file's contents.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, accountLabels, type AiAccount, type Settings } from '@agent/core'

import { CliHost, type CliTurnRequest } from '../src/main/runtime/cli-host'

const SECRET = 'sk-SENTINEL-TOKEN-do-not-leak-0123456789'

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.sig`
}

/** A Codex login file as `codex login` writes it. */
function codexAuth(dir: string, email: string, plan: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'auth.json'),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: jwt({ email, 'https://api.openai.com/auth': { chatgpt_plan_type: plan } }), access_token: SECRET, refresh_token: `${SECRET}-refresh`, account_id: 'acct' },
      last_refresh: new Date().toISOString(),
    }),
  )
}

/** The stand-in engine: answers with the CODEX_HOME it was started with, or a usage limit when that home says so. */
const FAKE = `#!/bin/sh
cat >/dev/null
echo '{"type":"thread.started","thread_id":"th-'$$'"}'
H="\${CODEX_HOME:-\$FAKE_HOME/.codex}"
if [ -f "$H/limit" ]; then
  echo '{"type":"turn.failed","error":{"message":"You have hit your usage limit. Try again later."}}'
  exit 0
fi
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"HOME='"$CODEX_HOME"'"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"output_tokens":1}}'
`

let root = ''
let fakeHome = ''
let engine = ''
let cli: CliHost
let list: AiAccount[] = []
const saved: Record<string, string | undefined> = {}

const plan = (id: string, kind: 'claude' | 'codex' = 'codex'): AiAccount => ({ id, label: id, kind, model: '', hasKey: false })
const settings = (): Settings => ({ ...DEFAULT_SETTINGS, accounts: list, shell: 'always' })

function request(accountId: string | undefined, over: Partial<CliTurnRequest> = {}): CliTurnRequest {
  return {
    cli: 'codex',
    ...(accountId === undefined ? {} : { accountId }),
    thread: 'routine',
    tools: [],
    system: 'x',
    prompt: 'hi',
    context: { approve: async () => ({ approved: true }), shell: 'always' } as unknown as CliTurnRequest['context'],
    signal: new AbortController().signal,
    onEvent: async () => undefined,
    onCall: async () => undefined,
    onResult: async () => undefined,
    ...over,
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-multi-'))
  fakeHome = join(root, 'home')
  mkdirSync(fakeHome, { recursive: true })
  engine = join(root, 'fake-codex.sh')
  writeFileSync(engine, FAKE)
  chmodSync(engine, 0o755)
  for (const key of ['AGENT_CODEX_PATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'FAKE_HOME']) saved[key] = process.env[key]
  process.env['AGENT_CODEX_PATH'] = engine
  process.env['FAKE_HOME'] = fakeHome
  delete process.env['CODEX_HOME']
  delete process.env['CLAUDE_CONFIG_DIR']
  list = []
  cli = new CliHost(join(root, 'cli'), settings, process.cwd(), { home: fakeHome, root: join(root, 'accounts'), env: { ...process.env } })
})

afterEach(async () => {
  await cli.close()
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('one sign-in home per plan account', () => {
  it('the first account keeps the computer login, a second one runs in its own fresh home', async () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('two')]
    const first = await cli.turn(request('one'))
    const second = await cli.turn(request('two'))
    // The first account: the engine's default (CODEX_HOME not set), so it behaves exactly as before.
    expect(first.text).toBe('HOME=')
    // The second: its own folder under the app's data, never ~/.codex.
    expect(second.text).toBe(`HOME=${join(root, 'accounts', 'two')}`)
    expect(existsSync(join(root, 'accounts', 'two'))).toBe(true)
  })

  it('a fresh account is not signed in, even though the computer has a Codex login', () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('two')]
    expect(cli.signedIn('codex', 'one')).toBe(true)
    expect(cli.signedIn('codex', 'two')).toBe(false)
    expect(cli.identity('codex', 'two')).toEqual({ signedIn: false, email: '', plan: '' })
  })

  it('records the migration explicitly and keeps it across restarts', () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('two')]
    cli.entry('codex', 'two')
    const file = JSON.parse(readFileSync(join(root, 'cli', 'account-homes.json'), 'utf8')) as { migrated: boolean; entries: Record<string, { dir: string; shared: boolean }> }
    expect(file.migrated).toBe(true)
    expect(file.entries['one']).toEqual({ cli: 'codex', dir: join(fakeHome, '.codex'), shared: true })
    expect(file.entries['two']?.shared).toBe(false)
    const again = new CliHost(join(root, 'cli'), settings, process.cwd(), { home: fakeHome, root: join(root, 'accounts'), env: { ...process.env } })
    expect(again.entry('codex', 'one').shared).toBe(true)
    expect(again.entry('codex', 'two').dir).toBe(join(root, 'accounts', 'two'))
  })

  it('shows which email and plan each account is signed in as', async () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('two')]
    codexAuth(cli.entry('codex', 'two').dir, 'info@example.org', 'team')
    const status = await cli.status(list)
    expect(status.map((each) => [each.id, each.email, each.plan, each.signedIn, each.sharedLogin])).toEqual([
      ['one', 'me@example.com', 'Plus', true, true],
      ['two', 'info@example.org', 'Team', true, false],
    ])
  })
})

describe('failover when an account hits its limit', () => {
  it('retries on the next signed-in account of the same kind and logs which one ran', async () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('two'), plan('three')]
    codexAuth(cli.entry('codex', 'two').dir, 'two@example.org', 'plus')
    codexAuth(cli.entry('codex', 'three').dir, 'three@example.org', 'plus')
    writeFileSync(join(join(fakeHome, '.codex'), 'limit'), '1')
    const ran: string[] = []
    cli.onRan = (each) => ran.push(`${each.account}${each.failedOverFrom === undefined ? '' : `<-${each.failedOverFrom}`}`)
    const result = await cli.turn(request('one', { failover: ['two', 'three'] }))
    expect(result.error).toBeUndefined()
    expect(result.text).toBe(`HOME=${join(root, 'accounts', 'two')}`)
    expect(ran).toEqual(['one', 'two<-one'])
    expect(readFileSync(join(root, 'cli', 'account-runs.log'), 'utf8')).toContain('failover-from=one')
    // The account that hit its limit is skipped for a while.
    expect(cli.limited('one')).toBe(true)
  })

  it('does nothing extra when failover is empty, and skips an account that is not signed in', async () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('two')]
    writeFileSync(join(fakeHome, '.codex', 'limit'), '1')
    const off = await cli.turn(request('one'))
    expect(off.error).toMatch(/reached its limit/)
    const signedOutOnly = await cli.turn(request('one', { failover: ['two'] }))
    expect(signedOutOnly.error).toMatch(/reached its limit/)
  })

  it('never fails over to another kind of plan', async () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('claude1', 'claude')]
    writeFileSync(join(fakeHome, '.codex', 'limit'), '1')
    const result = await cli.turn(request('one', { failover: ['claude1'] }))
    expect(result.error).toMatch(/reached its limit/)
  })
})

describe('what leaves this computer holds no login', () => {
  it('status and labels carry email, plan and usage only: no token, no auth file contents', async () => {
    codexAuth(join(fakeHome, '.codex'), 'me@example.com', 'plus')
    list = [plan('one'), plan('two')]
    codexAuth(cli.entry('codex', 'two').dir, 'info@example.org', 'team')
    const status = await cli.status(list)
    const labels = accountLabels(status)
    const wire = JSON.stringify({ status, labels })
    expect(wire).not.toContain(SECRET)
    expect(wire).not.toContain('refresh')
    expect(wire).not.toContain('id_token')
    expect(wire).not.toContain('access_token')
    expect(Object.keys(labels[0] ?? {}).sort()).toEqual(['email', 'id', 'kind', 'label', 'limited', 'plan', 'usage'])
  })
})

describe('Claude usage', () => {
  it("shows the plan's usage from its own /usage numbers, with the account's own token and never in the output", async () => {
    list = [plan('c1', 'claude'), plan('c2', 'claude')]
    const seen: string[] = []
    const asked = new CliHost(join(root, 'cli2'), settings, process.cwd(), {
      home: fakeHome,
      root: join(root, 'accounts2'),
      env: { ...process.env },
      fetch: (async (_url: string, init?: { headers?: Record<string, string> }) => {
        seen.push(init?.headers?.['Authorization'] ?? '')
        return new Response(JSON.stringify({ five_hour: { utilization: 42, resets_at: '2026-11-23T18:00:00+00:00' }, seven_day: { utilization: 60, resets_at: '2026-11-27T03:00:00+00:00' }, seven_day_opus: null }), { status: 200 })
      }) as unknown as typeof fetch,
    })
    for (const id of ['c1', 'c2']) {
      const dir = asked.entry('claude', id).dir
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `${SECRET}-${id}`, refreshToken: 'r', subscriptionType: 'max' } }))
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.com` } }))
    }
    const status = await asked.status(list)
    expect(status.map((each) => [each.email, each.plan, each.usage.map((w) => `${w.label} ${w.usedPercent}`).join(',')])).toEqual([
      ['c1@example.com', 'Max', '5 hours 42,Weekly 60'],
      ['c2@example.com', 'Max', '5 hours 42,Weekly 60'],
    ])
    // Each account asked with its own token.
    expect(seen).toEqual([`Bearer ${SECRET}-c1`, `Bearer ${SECRET}-c2`])
    expect(JSON.stringify(status)).not.toContain(SECRET)
    await asked.close()
  })
})
