/**
 * Signing in to a plan account without the computer's default browser (23 Nov 2026).
 *
 * The default browser is usually already signed in as ONE account, so signing a second account in from it signs in
 * as the first. Now: Codex always uses its device-code flow (`codex login --device-auth`, which opens no browser),
 * Claude is started with BROWSER pointed at a no-op so it opens nothing itself; the card shows the sign-in address
 * and the code, and the app opens the address in its own private window (an in-memory partition per sign-in).
 * Runs the real CliHost against stand-in engines, so what is proven is what the engines see.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type AiAccount, type Settings } from '@agent/core'

import { CliHost } from '../src/main/runtime/cli-host'

let root = ''
let fakeHome = ''
let cli: CliHost
let list: AiAccount[] = []
const saved: Record<string, string | undefined> = {}
const plan = (id: string, kind: 'claude' | 'codex'): AiAccount => ({ id, label: id, kind, model: '', hasKey: false })
const settings = (): Settings => ({ ...DEFAULT_SETTINGS, accounts: list })

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'none' })}.${part(claims)}.sig`
}
const AUTH = JSON.stringify({ tokens: { id_token: jwt({ email: 'info@example.org', 'https://api.openai.com/auth': { chatgpt_plan_type: 'team' } }), access_token: 'x' } })

/** `codex login --device-auth`: prints the address and code, waits for a file to appear, then writes the login. */
const FAKE_CODEX = `#!/bin/sh
echo "$@" > "$CODEX_HOME/args.txt"
printf '\\033[90mFollow these steps\\033[0m\\n1. Open this link\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n2. Enter this one-time code\\n   \\033[94mYIAE-T7PBT\\033[0m\\n'
i=0
while [ ! -f "$CODEX_HOME/approve" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
[ -f "$CODEX_HOME/approve" ] || exit 1
echo '${AUTH}' > "$CODEX_HOME/auth.json"
echo "Successfully logged in"
`

/** `claude auth login`: prints the address, asks for the pasted code, writes the login when it gets one. */
const FAKE_CLAUDE = `#!/bin/sh
echo "BROWSER=$BROWSER" > "$CLAUDE_CONFIG_DIR/env.txt"
echo "Opening browser to sign in"
echo "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=s1"
printf "Paste code here if prompted > "
read line
echo "$line" > "$CLAUDE_CONFIG_DIR/pasted.txt"
echo '{"claudeAiOauth":{"accessToken":"t","refreshToken":"r","subscriptionType":"max"}}' > "$CLAUDE_CONFIG_DIR/.credentials.json"
echo '{"oauthAccount":{"emailAddress":"b@example.com"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
echo "Login successful"
`

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-signin-'))
  fakeHome = join(root, 'home')
  mkdirSync(fakeHome, { recursive: true })
  const codex = join(root, 'fake-codex.sh')
  const claude = join(root, 'fake-claude.sh')
  writeFileSync(codex, FAKE_CODEX)
  writeFileSync(claude, FAKE_CLAUDE)
  chmodSync(codex, 0o755)
  chmodSync(claude, 0o755)
  for (const key of ['AGENT_CODEX_PATH', 'AGENT_CLAUDE_PATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'BROWSER']) saved[key] = process.env[key]
  process.env['AGENT_CODEX_PATH'] = codex
  process.env['AGENT_CLAUDE_PATH'] = claude
  delete process.env['CODEX_HOME']
  delete process.env['CLAUDE_CONFIG_DIR']
  list = [plan('c1', 'codex'), plan('c2', 'codex'), plan('k1', 'claude'), plan('k2', 'claude')]
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

describe('Codex: sign in with a code', () => {
  it('runs the device flow in that account home and shows the address and code', async () => {
    cli.entry('codex', 'c1')
    const home = cli.entry('codex', 'c2').dir
    const opened: string[] = []
    const done = cli.login('codex', (url) => opened.push(url), 'c2', { mode: 'code' })
    await until(() => cli.signInPrompt('c2') !== null)
    expect(cli.signInPrompt('c2')).toMatchObject({ url: 'https://auth.openai.com/codex/device', code: 'YIAE-T7PBT', needsPaste: false })
    expect(readFileSync(join(home, 'args.txt'), 'utf8').trim()).toBe('login --device-auth')
    // Code mode opens nothing: the person uses the address wherever they like.
    expect(opened).toEqual([])
    // The prompt reaches the card through status.
    const status = await cli.status(list)
    expect(status.find((each) => each.id === 'c2')?.signIn).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'YIAE-T7PBT', needsPaste: false })
    expect(status.find((each) => each.id === 'c1')?.signIn).toBeUndefined()
    writeFileSync(join(home, 'approve'), '1')
    const result = await done
    expect(result).toEqual({ ok: true, message: 'Signed in to ChatGPT as info@example.org (Team).' })
    expect(cli.signInPrompt('c2')).toBeNull()
    expect(cli.signedIn('codex', 'c2')).toBe(true)
  })

  it('the private window mode hands the address to the app, once, and never to a browser callback of the engine', async () => {
    const home = cli.entry('codex', 'c2').dir
    const opened: string[] = []
    const done = cli.login('codex', (url) => opened.push(url), 'c2', { mode: 'window' })
    await until(() => opened.length > 0)
    expect(opened).toEqual(['https://auth.openai.com/codex/device'])
    writeFileSync(join(home, 'approve'), '1')
    expect((await done).ok).toBe(true)
  })

  it('cancel stops the sign-in and clears the prompt', async () => {
    cli.entry('codex', 'c1')
    const done = cli.login('codex', () => undefined, 'c2', { mode: 'code' })
    await until(() => cli.signInPrompt('c2') !== null)
    cli.cancelSignIn('c2')
    const result = await done
    expect(result.ok).toBe(false)
    expect(cli.signInPrompt('c2')).toBeNull()
  })
})

describe('Claude: sign in with the address and the pasted code', () => {
  it('starts with BROWSER pointed at a no-op, shows the address, and takes the code the page shows', async () => {
    cli.entry('claude', 'k1')
    const home = cli.entry('claude', 'k2').dir
    const opened: string[] = []
    process.env['BROWSER'] = '/usr/bin/firefox-would-open-this'
    const done = cli.login('claude', (url) => opened.push(url), 'k2', { mode: 'code' })
    await until(() => cli.signInPrompt('k2') !== null)
    expect(cli.signInPrompt('k2')).toMatchObject({ url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=s1', needsPaste: true })
    const env = readFileSync(join(home, 'env.txt'), 'utf8').trim()
    expect(env).not.toBe('BROWSER=')
    expect(env).not.toContain('firefox-would-open-this')
    expect(opened).toEqual([])
    expect(cli.submitSignInCode('k2', 'CODE-FROM-PAGE#state')).toBe(true)
    const result = await done
    expect(result).toEqual({ ok: true, message: 'Signed in to Claude as b@example.com (Max).' })
    expect(readFileSync(join(home, 'pasted.txt'), 'utf8').trim()).toBe('CODE-FROM-PAGE#state')
    expect(cli.signInPrompt('k2')).toBeNull()
  })

  it('a code for an account with no sign-in running is refused', () => {
    expect(cli.submitSignInCode('k1', 'abc')).toBe(false)
    expect(existsSync(join(root, 'accounts'))).toBe(false)
  })
})

describe('the sign-in window is private and never the default browser', () => {
  class FakeWindow {
    static made: FakeWindow[] = []
    loaded = ''
    closed = false
    constructor(public options: { webPreferences: Record<string, unknown> }) {
      FakeWindow.made.push(this)
    }
    loadURL(url: string): Promise<void> {
      this.loaded = url
      return Promise.resolve()
    }
    on(): void {}
    once(): void {}
    isDestroyed(): boolean {
      return this.closed
    }
    close(): void {
      this.closed = true
    }
    webContents = { setWindowOpenHandler: () => undefined, on: () => undefined }
  }

  beforeEach(() => {
    FakeWindow.made = []
  })

  it('opens an in-memory partition of its own for every sign-in, with no shared cookies', async () => {
    const { createSignInWindows } = await import('../src/main/signin-window')
    const windows = createSignInWindows({ BrowserWindow: FakeWindow as never })
    windows.open('https://auth.openai.com/codex/device', 'c1')
    windows.open('https://auth.openai.com/codex/device', 'c2')
    windows.open('https://auth.openai.com/codex/device', 'c2')
    const partitions = FakeWindow.made.map((w) => String(w.options.webPreferences['partition']))
    expect(new Set(partitions).size).toBe(3)
    for (const partition of partitions) {
      expect(partition.startsWith('persist:')).toBe(false)
      expect(partition.length).toBeGreaterThan(8)
    }
    expect(FakeWindow.made[0]?.options.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
    expect(FakeWindow.made[0]?.loaded).toBe('https://auth.openai.com/codex/device')
  })

  it('opens only https addresses', async () => {
    const { createSignInWindows } = await import('../src/main/signin-window')
    const windows = createSignInWindows({ BrowserWindow: FakeWindow as never })
    expect(windows.open('http://example.com/x', 'c1')).toBe(false)
    expect(windows.open('file:///etc/passwd', 'c1')).toBe(false)
    expect(windows.open('javascript:alert(1)', 'c1')).toBe(false)
    expect(FakeWindow.made).toHaveLength(0)
  })

  it('the app wires sign-in to its own window, not to the default browser', () => {
    const runner = readFileSync(join(__dirname, '..', 'src', 'main', 'runtime', 'runner.ts'), 'utf8')
    const at = runner.indexOf('async cliLogin(')
    const body = runner.slice(at, runner.indexOf('/** One tiny real turn', at))
    expect(body).toContain('openSignInWindow')
    expect(body).not.toMatch(/this\.openUrl\(/)
  })
})
