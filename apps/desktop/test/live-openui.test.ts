/**
 * LIVE, opt-in (LIVE_PLAN=1): on the Claude plan, the main agent answers a list with an OpenUI card.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { StepBudget } from '../src/main/runtime/budget'
import { CliHost } from '../src/main/runtime/cli-host'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

const live = process.env['LIVE_PLAN'] === '1'

describe.skipIf(!live)('live: OpenUI on the Claude plan', () => {
  it('draws a card for a comparison', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-live-'))
    const db = new Store(join(dir, 'agent.db'))
    const settings = settingsView({ mode: 'subscription', cli: 'claude', cliModel: process.env['LIVE_MODEL'] ?? 'sonnet', agentName: 'Nova', userName: 'Sam', onboarded: true })
    const cli = new CliHost(join(dir, 'cli'), () => settings.get(), join(__dirname, '..'))
    const budget = new StepBudget()
    const runner = new Runner({
      store: db,
      settings,
      secrets: secretsView(null),
      tools: buildToolset({ store: db, mainBudget: budget }),
      budget,
      providerFactory: () => null,
      cli,
      isFocused: () => true,
    })
    await runner.send(process.env['LIVE_ASK'] ?? 'Compare three ways to get from Johannesburg to Durban: fly, drive, bus. Rough time and cost each. Do not use any tools, answer from what you know.')
    const deadline = Date.now() + 240_000
    while (Date.now() < deadline && runner.state().running) await new Promise((r) => setTimeout(r, 1000))
    const rows = await db.list('chat_item')
    const reply = rows.filter((row) => row.kind === 'agent').map((row) => row.text).join('\n---\n')
    console.log(reply)
    expect(reply).toContain('openui-lang')
  }, 300_000)
})
