/** LIVE, opt-in (LIVE_PLAN=1): the plan's own model list, with no message sent. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@agent/core'

import { CliHost } from '../src/main/runtime/cli-host'

describe.skipIf(process.env['LIVE_PLAN'] !== '1')('live: plan models', () => {
  it('Claude Code and Codex report their own models', async () => {
    const cli = new CliHost(mkdtempSync(join(tmpdir(), 'agent-models-')), () => DEFAULT_SETTINGS, join(__dirname, '..'))
    const claude = await cli.models('claude')
    const codex = await cli.models('codex')
    console.log('claude:', claude.map((m) => `${m.id}=${m.label}`).join(' | '))
    console.log('codex:', codex.map((m) => `${m.id}=${m.label}`).join(' | '))
    expect(claude.length).toBeGreaterThan(0)
    expect(codex.length).toBeGreaterThan(0)
  }, 60_000)
})
