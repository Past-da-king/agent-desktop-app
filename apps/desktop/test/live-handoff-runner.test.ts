import { DEFAULT_SETTINGS, MAIN_CHAT, providerFor } from '@agent/core'
import { describe, expect, it } from 'vitest'

import { startFakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { liveFromMeta, viaFromMeta } from '../src/shared/sender'
import { secretsView, settingsView } from './support'

describe('live voice hand-off: the runner', () => {
  it('stores it as a call hand-off with meta.live and tells the agent what it is', async () => {
    const fake = await startFakeAi(() => ({ text: 'Done.' }))
    const db = new Store(':memory:')
    const runner = new Runner({
      store: db,
      settings: settingsView({ ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false, agentName: 'Hina' }),
      secrets: secretsView('test-key'),
      tools: buildToolset({ store: db }),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true }),
      timeZone: 'UTC',
    })
    try {
      const origin = { deviceId: 'd', name: 'A35', kind: 'phone', platform: 'android', screenWidth: 400, canOpenLinks: true, canReceiveFiles: true, live: { spoken: 'sort out the end of day report', session: 's1' } }
      await runner.send('Update the EOD report', [], MAIN_CHAT, origin as never)
      await waitFor(() => !runner.state(MAIN_CHAT).running, 8_000)
      const mine = (await db.list('chat_item')).find((item) => item.kind === 'user')!
      expect(mine.text).toBe('Update the EOD report')
      const meta = JSON.parse(mine.meta) as Record<string, unknown>
      expect(viaFromMeta(meta)?.from).toBe('call')
      expect(liveFromMeta(meta)).toEqual({ spoken: 'sort out the end of day report', session: 's1' })
      const prompt = JSON.stringify(fake.requests)
      expect(prompt).toContain('paraphrase')
      expect(prompt).toContain('sort out the end of day report')
      expect(prompt).toContain('Update the EOD report')
    } finally {
      runner.dispose()
      await sleep(30)
      db.close()
      await fake.close()
    }
  }, 15_000)
})
