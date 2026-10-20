/**
 * LIVE, opt-in: runs the main agent and a delegated helper on the person's real Claude plan through the
 * Claude Agent SDK. Skipped unless LIVE_PLAN=1 (it needs a signed-in Claude login on this computer).
 *   LIVE_PLAN=1 npx vitest run apps/desktop/test/live-plan.test.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { StepBudget } from '../src/main/runtime/budget'
import { CliHost } from '../src/main/runtime/cli-host'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const live = process.env['LIVE_PLAN'] === '1'

describe.skipIf(!live)('live: delegation on the Claude plan', () => {
  it('main delegates, the helper runs as its own SDK session, the result comes back', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-live-'))
    const db = new Store(join(dir, 'agent.db'))
    const settings = settingsView({ mode: 'subscription', cli: 'claude', cliModel: 'haiku', agentName: 'Nova', userName: 'Sam', onboarded: true })
    const cli = new CliHost(join(dir, 'cli'), () => settings.get(), join(__dirname, '..'))
    const budget = new StepBudget()
    let runner: Runner | null = null
    const delivered: string[] = []
    const helpers = new HelperManager({
      store: db,
      settings,
      secrets: secretsView(null),
      providerFactory: () => null,
      workerTools: buildWorkerToolset({ store: db }),
      deliver: (note) => {
        delivered.push(note)
        if (runner !== null) void runner.deliver(note)
      },
      platform: process.platform,
      cli,
    })
    runner = new Runner({
      store: db,
      settings,
      secrets: secretsView(null),
      tools: buildToolset({ store: db, helpers, mainBudget: budget }),
      helpers,
      budget,
      providerFactory: () => null,
      cli,
      isFocused: () => true,
    })
    await runner.send('Use delegate to start ONE helper labelled "Capital" whose brief is: reply with the capital city of France, one word. Then end your turn.')
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline && delivered.length === 0) await new Promise((r) => setTimeout(r, 1000))
    while (Date.now() < deadline && runner.state().running) await new Promise((r) => setTimeout(r, 1000))
    const rows = await db.list('chat_item')
    console.log(rows.map((row) => `${row.kind}: ${row.text.slice(0, 160)}`).join('\n'))
    expect(rows.some((row) => row.kind === 'helper')).toBe(true)
    expect(delivered.join('\n')).toMatch(/paris/i)
    expect(rows.filter((row) => row.kind === 'agent').map((row) => row.text).join('\n')).toMatch(/paris/i)
    await cli.close()
  }, 300_000)
})
