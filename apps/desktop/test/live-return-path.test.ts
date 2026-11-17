/**
 * The return path of a Live hand-off, on the computer: a live hand-off starts a main-chat turn, the main agent replies
 * "started a helper", then the helper's result re-enters the chat and the main agent relays it. The phone's tracker (LiveAssistCore.rows)
 * reads the main chat's agent rows after the hand-off, so the relay must be an ordinary main-chat agent row (not a call row, no call flag),
 * after the first reply, and the live/session link of the hand-off must be intact. Also: the call's real words reach the agent's prompt.
 */
import { DEFAULT_SETTINGS, MAIN_CHAT, providerFor } from '@agent/core'
import { describe, expect, it } from 'vitest'

import { startFakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { VoiceService } from '../src/main/voice/service'
import { SettingsStore } from '../src/main/settings'
import { liveFromMeta } from '../src/shared/sender'
import { secretsView, settingsView } from './support'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('live hand-off: the return path on the computer', () => {
  it('a helper result relayed by the main agent is a main-chat agent row after the first reply, with the live link intact', async () => {
    let turn = 0
    const fake = await startFakeAi(() => {
      turn += 1
      return { text: turn === 1 ? 'I have started a helper to check the NSFAS upload.' : 'Done. Uploaded, status Verification.' }
    })
    const dir = mkdtempSync(join(tmpdir(), 'agent-return-'))
    const db = new Store(':memory:')
    const runner = new Runner({
      store: db,
      settings: settingsView({ ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false, agentName: 'Hina' }),
      secrets: secretsView('test-key'),
      tools: buildToolset({ store: db }),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true }),
      timeZone: 'UTC',
    })
    const voice = new VoiceService({
      secrets: { get: () => null, set: () => undefined, delete: () => undefined },
      settings: new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test' }),
      store: db,
      runner: { send: async () => undefined, state: () => ({ running: false, waiting: [] }) },
      emit: () => undefined,
      fetchImpl: (async () => new Response('{}')) as typeof fetch,
      now: () => 1_700_000_000_000,
    })
    try {
      // The call: his real words are written into the main chat as the call goes on.
      const t0 = Date.now() - 60_000
      await voice.callTurn({ session: 's1', startedAt: t0, index: 0, who: 'you', text: "Did we upload Thuli's PDF to NSFAS?", at: t0 })
      // The hand-off (the assistant's paraphrase) starts the turn; the agent says it started a helper.
      const origin = { deviceId: 'd', name: 'A35', kind: 'phone', platform: 'android', screenWidth: 400, canOpenLinks: true, canReceiveFiles: true, live: { spoken: "Did we upload Thuli's PDF to NSFAS?", session: 's1' } }
      await runner.send('Check the NSFAS upload', [], MAIN_CHAT, origin as never)
      await waitFor(() => !runner.state(MAIN_CHAT).running, 8_000)
      // Minutes later the helper's result re-enters the main chat and the main agent relays it.
      await runner.receive(MAIN_CHAT, 'Helper nsfas-check finished: the form is uploaded, status Verification.', { from: 'helper', name: 'nsfas-check', chat: '' })
      await waitFor(() => !runner.state(MAIN_CHAT).running && turn >= 2, 8_000)
      await waitFor(async () => (await db.list('chat_item')).filter((r) => r.kind === 'agent').length >= 2, 8_000)

      const rows = await db.list('chat_item')
      const hand = rows.find((r) => r.kind === 'user')!
      expect(liveFromMeta(JSON.parse(hand.meta) as Record<string, unknown>)).toEqual({ spoken: "Did we upload Thuli's PDF to NSFAS?", session: 's1' })
      const agents = rows.filter((r) => r.kind === 'agent')
      expect(agents.map((r) => r.text)).toEqual(['I have started a helper to check the NSFAS upload.', 'Done. Uploaded, status Verification.'])
      // The phone reads agent rows after the hand-off in order; neither is a call row or carries a call/live flag.
      for (const row of agents) {
        const meta = JSON.parse(row.meta) as Record<string, unknown>
        expect(meta['call']).not.toBe(true)
        expect(meta['live']).toBeUndefined()
        expect(meta['chat'] === undefined || meta['chat'] === MAIN_CHAT || meta['chat'] === '').toBe(true)
      }
      expect(rows.indexOf(agents[1]!)).toBeGreaterThan(rows.indexOf(agents[0]!))
      expect(rows.indexOf(agents[0]!)).toBeGreaterThan(rows.indexOf(hand))
      // The call's real words are in the relay turn's context (not only the paraphrase).
      const second = JSON.stringify(fake.requests[fake.requests.length - 1])
      expect(second).toContain("He said: Did we upload Thuli's PDF to NSFAS?")
    } finally {
      runner.dispose()
      await sleep(30)
      db.close()
      rmSync(dir, { recursive: true, force: true })
      await fake.close()
    }
  }, 30_000)
})
