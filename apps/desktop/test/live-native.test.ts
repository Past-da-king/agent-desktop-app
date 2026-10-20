/** LIVE, opt-in (LIVE_PLAN=1): Claude Code native tools on the person's plan go through the app's approvals and Shell setting. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CliHost } from '../src/main/runtime/cli-host'
import { settingsView, testContext } from './support'
it.skipIf(process.env['LIVE_PLAN'] !== '1')('native Bash goes through the app approval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'native-'))
  const asked: string[] = []
  const settings = settingsView({ mode: 'subscription', cli: 'claude', cliModel: 'haiku', shell: 'ask' })
  const cli = new CliHost(join(dir, 'cli'), () => settings.get(), join(__dirname, '..'))
  const said: string[] = []
  const r = await cli.turn({ cli: 'claude', thread: 'routine', tools: [], system: 'You are a test agent. Use your Bash tool.', prompt: 'Run the shell command: echo agent-native-ok   and tell me exactly what it printed.',
    context: testContext({ approve: async (s, d) => { asked.push(`${s}: ${d}`); return true } }), signal: new AbortController().signal,
    onEvent: async (e) => { if (e.type === 'said') said.push(e.text) }, onCall: async () => undefined, onResult: async () => undefined })
  console.log('ASKED', asked, 'RESULT', r)
  expect(asked.some((a) => a.includes('echo agent-native-ok'))).toBe(true)
  expect(r.text).toMatch(/agent-native-ok/)
  await cli.close()
}, 200_000)
it.skipIf(process.env['LIVE_PLAN'] !== '1')('declined and Never commands do not run', async () => {
  const { writeFileSync, existsSync } = await import('node:fs')
  for (const mode of ['decline', 'never'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'native-'))
    const marker = join(dir, 'ran.txt')
    const asked: string[] = []
    const settings = settingsView({ mode: 'subscription', cli: 'claude', cliModel: 'haiku', shell: mode === 'never' ? 'never' : 'ask' })
    const cli = new CliHost(join(dir, 'cli'), () => settings.get(), join(__dirname, '..'))
    const r = await cli.turn({ cli: 'claude', thread: 'routine', tools: [], system: 'You are a test agent.', prompt: `Run this exact shell command with your Bash tool: touch "${marker}"   If you cannot, say CANNOT.`,
      context: testContext({ approve: async (s, d) => { asked.push(`${s}: ${d}`); return false } }), signal: new AbortController().signal,
      onEvent: async () => undefined, onCall: async () => undefined, onResult: async () => undefined })
    console.log(mode, 'ASKED', asked.length, 'RAN', existsSync(marker), r.text.slice(0, 100))
    expect(existsSync(marker)).toBe(false)
    if (mode === 'never') expect(asked.length).toBe(0)
    else expect(asked.length).toBeGreaterThan(0)
    void writeFileSync
    await cli.close()
  }
}, 300_000)
