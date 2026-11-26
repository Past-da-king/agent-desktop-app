import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type ChatItem, type Settings } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset } from '../src/main/runtime/toolset'
import { secretsView, settingsView } from './support'

// 26 Nov 2026: the PC dropped, the server's main agent answered, and it knew nothing of what the PC had said or done.
// Each brain's plan session is its own, so the rows that replicate must reach it as a note on its next turn.
const PLAN: Partial<Settings> = { mode: 'subscription', cli: 'claude', notifications: false, onboarded: true }

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

interface Brain {
  name: string
  store: Store
  runner: Runner
  prompts: string[]
  say(text: string): Promise<void>
}

function brain(name: string, reply: (prompt: string) => string, steps: Array<{ tool: string; text: string }> = []): Brain {
  const store = new Store(':memory:')
  const prompts: string[] = []
  const cli = {
    turn: async (request: CliTurnRequest) => {
      prompts.push(request.prompt)
      for (const step of steps) {
        await request.onCall({ id: `c-${prompts.length}`, name: step.tool, input: {} })
        await request.onResult({ id: `c-${prompts.length}`, name: step.tool, input: {} }, step.text, false)
      }
      const text = reply(request.prompt)
      await request.onEvent({ type: 'said', text })
      return { text }
    },
  } as unknown as CliHost
  const runner = new Runner({
    store,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...PLAN }),
    secrets: secretsView('k'),
    tools: buildToolset({ store }),
    providerFactory: () => null,
    timeZone: 'UTC',
    classifier: null,
    cli,
  })
  cleanups.push(() => runner.dispose())
  return {
    name,
    store,
    runner,
    prompts,
    say: async (text) => {
      const before = prompts.length
      await runner.send(text)
      await waitFor(() => prompts.length > before && !runner.state().running)
    },
  }
}

/** What replication does: every chat row of one node appears, unchanged, on the other. */
async function replicate(from: Brain, to: Brain): Promise<void> {
  for (const row of await from.store.list('chat_item')) {
    if ((await to.store.get('chat_item', row.id)) !== null) continue
    await to.store.upsert('chat_item', row as ChatItem)
  }
}

describe('one conversation across brains', () => {
  it('the brain that takes over reads what the other said and did', async () => {
    const pc = brain('pc', () => 'Ordered 3 reams of A4, reference 4471.', [{ tool: 'order_paper', text: 'order 4471 placed' }])
    const server = brain('server', () => 'It was 4471.')
    await pc.say('Order more printer paper')
    await replicate(pc, server)

    await server.say('What was the order reference?')

    const prompt = server.prompts[0] ?? ''
    expect(prompt).toContain('Order more printer paper')
    expect(prompt).toContain('reference 4471')
    expect(prompt).toContain('order_paper')
    expect(prompt).toContain('order 4471 placed')
    expect(prompt.endsWith('What was the order reference?')).toBe(true)
  })

  it('hands back both ways, each brain told only what it missed', async () => {
    const pc = brain('pc', () => 'PC answer one.')
    const server = brain('server', () => 'Server answer two.')
    await pc.say('First question')
    await replicate(pc, server)
    await server.say('Second question')
    await replicate(server, pc)
    await pc.say('Third question')

    const third = pc.prompts[1] ?? ''
    expect(third).toContain('Second question')
    expect(third).toContain('Server answer two.')
    // What the PC itself said is already in its own session.
    expect(third).not.toContain('PC answer one.')
    expect(third).not.toContain('First question')
  })

  it('a brain that answered everything itself gets no note', async () => {
    const pc = brain('pc', () => 'Fine.')
    await pc.say('One')
    await pc.say('Two')
    expect(pc.prompts[1]).not.toContain('carried on elsewhere')
    expect(pc.prompts[1]).toBe('Two')
  })

  it('a first turn on a new computer carries the recent conversation', async () => {
    const pc = brain('pc', () => 'Noted, the code is 9981.')
    await pc.say('Remember the code 9981')
    const server = brain('server', () => 'ok')
    await replicate(pc, server)
    await server.say('What code?')
    expect(server.prompts[0]).toContain('9981')
  })
})
