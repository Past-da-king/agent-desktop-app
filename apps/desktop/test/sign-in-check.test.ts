/**
 * A brain whose plan login is dead must not say it is ready (12 Nov 2026). The server node kept a Claude login file
 * whose session had expired for good, said ready on /v1/health, and the phone sent its message there.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canRunTurns } from '../src/headless/devices'
import { CliHost } from '../src/main/runtime/cli-host'
import { isSignInFailure, loginFileDead, signInVerdict } from '../src/main/runtime/sign-in-check'

const saved = { config: process.env['CLAUDE_CONFIG_DIR'], engine: process.env['AGENT_CLAUDE_PATH'] }
let dir = ''

function login(expiresAt: number, refresh: boolean): string {
  const file = join(dir, 'claude', '.credentials.json')
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'a', ...(refresh ? { refreshToken: 'r' } : {}), expiresAt } }))
  return file
}

/** A pretend engine: `auth status` prints what the test wants. */
function engine(loggedIn: boolean): void {
  const file = join(dir, 'claude-engine')
  writeFileSync(file, `#!/bin/sh\necho '{"loggedIn": ${loggedIn}, "authMethod": "${loggedIn ? 'oauth' : 'none'}"}'\n`)
  chmodSync(file, 0o755)
  process.env['AGENT_CLAUDE_PATH'] = file
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signin-'))
  mkdirSync(join(dir, 'claude'), { recursive: true })
  process.env['CLAUDE_CONFIG_DIR'] = join(dir, 'claude')
})
afterEach(() => {
  for (const [key, value] of [['CLAUDE_CONFIG_DIR', saved.config], ['AGENT_CLAUDE_PATH', saved.engine]] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('sign-in check', () => {
  it('reads what the engine said', () => {
    expect(signInVerdict('claude', 0, '{"loggedIn": false, "authMethod": "none"}')).toBe(false)
    expect(signInVerdict('claude', 0, '{"loggedIn": true}')).toBe(true)
    expect(signInVerdict('claude', 1, 'boom')).toBeNull()
    expect(signInVerdict('codex', 0, 'Logged in using ChatGPT')).toBe(true)
    expect(signInVerdict('codex', 1, 'Not logged in')).toBe(false)
    expect(isSignInFailure('Claude is not signed in on this computer. Install Claude Code, run claude once')).toBe(true)
    expect(isSignInFailure('Your Claude plan has reached its limit for now.')).toBe(false)
  })

  it('a login file that ran out with nothing to renew it is dead', () => {
    expect(loginFileDead(login(Date.now() - 1000, false), Date.now())).toBe(true)
    expect(loginFileDead(login(Date.now() - 1000, true), Date.now())).toBe(false)
    expect(loginFileDead(login(Date.now() + 100000, false), Date.now())).toBe(false)
  })

  it('a login file the engine says is dead is not signed in, until the file changes', async () => {
    const file = login(Date.now() + 3_600_000, true)
    const host = new CliHost(join(dir, 'work'), () => ({}) as never, dir)
    const told: boolean[] = []
    host.onSignInChange = (_cli, usable) => told.push(usable)
    expect(host.signedIn('claude')).toBe(true)
    engine(false)
    expect(await host.checkSignIn('claude')).toBe(false)
    expect(host.signedIn('claude')).toBe(false)
    expect(told).toEqual([false])
    // Still dead on the next look: nothing changed.
    expect(host.signedIn('claude')).toBe(false)
    // A new sign-in rewrites the file.
    const later = new Date(Date.now() + 5000)
    utimesSync(file, later, later)
    expect(host.signedIn('claude')).toBe(true)
    expect(told).toEqual([false, true])
  })

  it('a check that finds the login working puts it back', async () => {
    login(Date.now() + 3_600_000, true)
    const host = new CliHost(join(dir, 'work'), () => ({}) as never, dir)
    engine(false)
    await host.checkSignIn('claude')
    expect(host.signedIn('claude')).toBe(false)
    engine(true)
    expect(await host.checkSignIn('claude')).toBe(true)
    expect(host.signedIn('claude')).toBe(true)
  })

  it('a node with only a dead plan is not ready; with a working one, or an API key, it is', async () => {
    login(Date.now() + 3_600_000, true)
    const host = new CliHost(join(dir, 'work'), () => ({}) as never, dir)
    engine(false)
    await host.checkSignIn('claude')
    const node = (accounts: Array<{ kind: 'claude' | 'api'; hasKey: boolean }>) =>
      ({ cli: host, accounts: { all: () => accounts }, settings: { get: () => ({ hasKey: false }) } }) as never
    expect(canRunTurns(node([{ kind: 'claude', hasKey: false }]))).toBe(false)
    expect(canRunTurns(node([{ kind: 'claude', hasKey: false }, { kind: 'api', hasKey: true }]))).toBe(true)
    engine(true)
    await host.checkSignIn('claude')
    expect(canRunTurns(node([{ kind: 'claude', hasKey: false }]))).toBe(true)
  })
})
