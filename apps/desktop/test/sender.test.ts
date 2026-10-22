/**
 * Who sent a message (22 Oct 2026, Ayanda on a phone call): the call's hand-off showed in the chat as if he typed it,
 * and the call voice spoke of "the agent" as someone else. Every row that is not his carries meta.via, every window
 * draws it as not his, and the voice speaks as the agent itself.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, MAIN_CHAT, providerFor, type ChatItem, type Settings } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { voiceTools } from '../src/main/tools/voice'
import { callHandoff, type CallHandoffDeps } from '../src/main/voice/handoff'
import { callIdentity } from '../src/main/voice/service'
import { viaOf } from '../src/renderer/lib/projects'
import { callVia, senderLine, viaFromMeta } from '../src/shared/sender'
import { secretsView, settingsView } from './support'

/** Third-person talk about the agent, as if it were someone else. */
const THIRD_PERSON = /\b(the|your|main|my|user's|person's) (main )?agent\b|\bmain agent\b|\bhand(ed)? (it )?(over )?to\b/i

let store: Store | null = null
let fake: FakeAi | null = null
const runners: Runner[] = []

afterEach(async () => {
  for (const runner of runners.splice(0)) runner.dispose()
  await sleep(30)
  store?.close()
  store = null
  await fake?.close()
  fake = null
})

function row(meta: Record<string, unknown>, text = 'hi'): ChatItem {
  return { id: 'r1', kind: 'user', text, meta: JSON.stringify(meta), createdAt: 1, updatedAt: 1 } as ChatItem
}

describe('the call voice speaks as the agent itself', () => {
  it('names itself and talks in the first person, never of "the agent" as someone else', () => {
    const identity = callIdentity('Hina', 'Ayanda')
    expect(identity).toContain('You are Hina')
    expect(identity).toContain("I'm on it")
    expect(identity).not.toMatch(THIRD_PERSON)
    expect(callIdentity('Your agent', 'Ayanda')).toContain("You are Ayanda's agent")
  })

  it("its tools are its own: no tool name or description hands work to someone else", () => {
    const tools = voiceTools({ store: {} as never, handToAgent: async () => ({ queued: false }), show: async () => undefined })
    const start = tools.find((tool) => tool.spec.name === 'start_work')
    expect(start).toBeDefined()
    for (const tool of tools) {
      expect(tool.spec.name).not.toMatch(/agent/i)
      if (tool.spec.name === 'start_work' || tool.spec.name === 'show_on_screen') expect(tool.spec.description).not.toMatch(THIRD_PERSON)
    }
  })

  it('what a hand-off tells the voice to say is first person', async () => {
    const sent: Array<{ via: unknown }> = []
    const deps: CallHandoffDeps = {
      store: { list: (async () => []) as CallHandoffDeps['store']['list'], upsert: async () => ({}) },
      send: async (_text, _chat, _origin, via) => {
        sent.push({ via })
      },
      steer: async () => 'ok',
      cards: async () => ({ seq: 1, at: 1, cards: [] }),
      state: () => ({ running: false, waiting: [] }),
      agentName: () => 'Hina',
    }
    const result = await callHandoff(deps, { target: 'main', message: 'Email Ben' }, { deviceId: 'd1', name: 'Pixel' })
    expect(result.ok && result.said).toBe("I'm on it.")
    expect(result.ok ? result.said : '').not.toMatch(THIRD_PERSON)
    const missing = await callHandoff(deps, { target: 'Kitchen', message: 'x' })
    expect(missing.ok ? '' : missing.error).not.toMatch(THIRD_PERSON)
  })
})

describe('every message says who really sent it', () => {
  it('a call hand-off is from the call, with the device it came from', async () => {
    const sent: Array<{ via: unknown }> = []
    const deps: CallHandoffDeps = {
      store: { list: (async () => []) as CallHandoffDeps['store']['list'], upsert: async () => ({}) },
      send: async (_text, _chat, _origin, via) => {
        sent.push({ via })
      },
      steer: async () => 'ok',
      cards: async () => ({ seq: 1, at: 1, cards: [] }),
      state: () => ({ running: false, waiting: [] }),
      agentName: () => 'Hina',
    }
    await callHandoff(deps, { target: 'main', message: 'Task from our voice call: email Ben' }, { deviceId: 'd1', name: "Ayanda's phone" })
    await sleep(5)
    expect(sent[0]?.via).toEqual({ from: 'call', name: "Ayanda's phone", chat: '' })
  })

  it('the runner stores the sender on the row, so it is never drawn as his', async () => {
    fake = await startFakeAi(() => ({ text: 'On it.' }))
    store = new Store(':memory:')
    const db = store
    const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false, agentName: 'Hina' }
    const runner = new Runner({
      store: db,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
      secrets: secretsView('test-key'),
      tools: buildToolset({ store: db }),
      providerFactory: () => (fake === null ? null : providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true })),
      timeZone: 'UTC',
    })
    runners.push(runner)
    await runner.send('Task from our voice call: email Ben', [], MAIN_CHAT, undefined, callVia('Pixel'))
    await runner.send('my own words')
    await waitFor(() => !runner.state(MAIN_CHAT).running, 8_000)
    const users = (await db.list('chat_item')).filter((item) => item.kind === 'user')
    const fromCall = users.find((item) => item.text.startsWith('Task from our voice call'))
    const mine = users.find((item) => item.text === 'my own words')
    expect(viaOf(fromCall!)?.line).toBe('From your call on Pixel')
    expect(viaOf(mine!)).toBeNull()
  }, 15_000)

  it('the window draws each sender: him, the call, a project (message_main), the main agent, a helper, a routine', () => {
    expect(viaOf(row({}))).toBeNull()
    expect(viaOf(row({ via: { from: 'call', name: '', chat: '' } }))?.line).toBe('From your call')
    expect(viaOf(row({ via: { from: 'project', name: 'Acme finance', chat: 'pc1' } }))?.line).toBe('From Acme finance')
    expect(viaOf(row({ via: { from: 'main', name: 'Hina', chat: 'main' } }))?.line).toBe('From Hina, the main agent')
    expect(senderLine({ from: 'helper', name: 'Dictation fix', chat: '' })).toBe('From the helper Dictation fix')
    expect(senderLine({ from: 'routine', name: 'Morning brief', chat: '' })).toBe('From the routine Morning brief')
    // Junk is the person's, as before: never a crash, never a made-up sender.
    expect(viaFromMeta({ via: { from: 'alien', name: 'x' } })).toBeNull()
    expect(viaFromMeta({ via: 'call' })).toBeNull()
  })
})
