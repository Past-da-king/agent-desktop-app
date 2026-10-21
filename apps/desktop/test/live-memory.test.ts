/**
 * LIVE, opt-in: files a seeded chat into memory with a real model on the person's Claude plan (the same one-shot call
 * New Chat makes), then runs the end-of-day pass. Skipped unless LIVE_PLAN=1.
 *   LIVE_PLAN=1 npx vitest run apps/desktop/test/live-memory.test.ts
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { Store } from '../src/main/db'
import { ChatIndex } from '../src/main/memory/chat-index'
import { memoryNote } from '../src/main/memory/chats'
import { MemoryService } from '../src/main/memory/service'
import { UpkeepFile } from '../src/main/memory/upkeep-log'
import { CliHost } from '../src/main/runtime/cli-host'
import { Runner } from '../src/main/runtime/runner'
import { secretsView, settingsView } from './support'

const live = process.env['LIVE_PLAN'] === '1'

describe.skipIf(!live)('live: filing a chat into memory on the Claude plan', () => {
  it('turns a real chat into organised entries, updating the page that exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-live-memory-'))
    const store = new Store(join(dir, 'agent.db'))
    const settings = settingsView({ mode: 'subscription', cli: 'claude', cliModel: process.env['LIVE_MODEL'] ?? 'sonnet', userName: 'Sam' })
    const cli = new CliHost(join(dir, 'cli'), () => settings.get(), join(__dirname, '..'))
    const runner = new Runner({ store, settings, secrets: secretsView(null), tools: [], providerFactory: () => null, cli })
    const memory = new MemoryService({
      store,
      index: new ChatIndex(join(dir, 'chat-search.db')),
      upkeep: new UpkeepFile(join(dir, 'memory-upkeep.json')),
      complete: (system, prompt, signal) => runner.oneShot(system, prompt, signal),
    })

    await store.upsert('memory', { title: 'Lerato Dlamini', body: "Sam's sister. Lives in Durban.", kind: 'person', topics: 'family', pinned: false, source: 'user' })
    const chat: Array<[string, string]> = [
      ['user', 'Morning! How are you?'],
      ['agent', 'Morning Sam. All good, what are we doing today?'],
      ['user', 'My sister Lerato just started as the finance manager at Kestrel Logistics in Umhlanga. She starts on 3 November. Her work email is lerato@kestrel.example.'],
      ['agent', 'Congratulations to her. Noted: Lerato Dlamini, finance manager at Kestrel Logistics (Umhlanga), starting 3 November 2026.'],
      ['user', 'Also, for the Acme invoices: from now on they go out on the 26th, not the 25th, because the bank batch moved. Export from the billing page as PDF, copy me, send from accounts@acme.example. The portal password is Blue-Heron-77 by the way.'],
      ['agent', 'Got it. I will not store the password. New process: on the 26th, export the invoices as PDF from the Acme billing page and send them from accounts@acme.example with you in copy.'],
      ['user', 'And we decided to drop Xero and stay on Sage until March because the migration would clash with year end.'],
      ['agent', 'Noted the decision: stay on Sage until March 2027, Xero migration postponed so it does not clash with year end.'],
      ['user', 'Cool, I am checking the flights now, give me a sec.'],
    ]
    for (const [kind, text] of chat) await store.upsert('chat_item', { kind, text, meta: '{}' })

    const started = Date.now()
    await memory.newChat()
    await memory.idle()
    const divider = (await store.list('chat_item')).find((row) => row.kind === 'notice')
    const note = divider === undefined ? null : memoryNote(divider)
    const memories = await store.list('memory')
    console.log(`LIVE FILED in ${Date.now() - started}ms: ${JSON.stringify(note)}`)
    console.log(`LIVE SUMMARY ${divider === undefined ? '' : JSON.stringify(JSON.parse(divider.meta)['summary'])}`)
    for (const row of memories) console.log(`--- [${row.kind}] ${row.title} (#${row.id})\n${row.body}\n(topics: ${row.topics})`)

    expect(note?.status).toBe('done')
    expect(JSON.stringify(memories)).not.toContain('Blue-Heron-77')
    expect(memories.filter((row) => /lerato/i.test(row.title))).toHaveLength(1)

    const report = await memory.runNow()
    console.log(`LIVE DAILY ${JSON.stringify({ ok: report.ok, message: report.message, actions: report.changes.map((c) => `${c.action}: ${c.title}`) })}`)
    console.log(`LIVE WHERE\n${(await store.get('memory', 'where-we-are'))?.body ?? '(none)'}`)
    expect(report.ok).toBe(true)
    runner.dispose()
    await cli.close()
    store.close()
  }, 600_000)
})
