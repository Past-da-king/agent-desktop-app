import { describe, expect, it } from 'vitest'
import type { ChatItem, HelperCardInfo, ProjectRow } from '@agent/core'

import { callHandoff, callTargets, type CallHandoffDeps } from '../src/main/voice/handoff'

/**
 * 22 Oct 2026: a linked phone's call must hand work to the agent he names ("tell the Agent Desktop App project...",
 * "ask the dictation helper..."), not always the main chat, and ask when two names are close.
 */
function project(id: string, name: string, chats: string[], aliases: string[] = []): ProjectRow {
  return { id, name, description: '', aliases, icon: { glyph: 'code', color: 'iris' }, path: '', profile: '', hidden: false, chats, createdAt: 1, updatedAt: 1 } as ProjectRow
}

function row(id: string, chat: string, kind: string, text: string, at: number): ChatItem {
  return { id, kind, text, meta: JSON.stringify({ chat }), createdAt: at, updatedAt: at } as ChatItem
}

function card(id: string, label: string, state: HelperCardInfo['state'], line: string): HelperCardInfo {
  return { id, row: `r-${id}`, chat: 'main', label, state, queued: false, line, done: '', depth: 0, projectChat: '', owner: 'main', model: '', startedAt: 1, endedAt: null, brief: '', result: '', steps: [] } as unknown as HelperCardInfo
}

function setup() {
  const projects = [
    project('p-ada', 'Agent Desktop App', ['pc111111', 'pc222222'], ['agent app']),
    project('p-web', 'Strat Edge Website', ['pc333333']),
    project('p-sol', 'Strat Edge Solutions', []),
  ]
  const rows = [
    row('1', 'pc111111', 'user', 'Fix the dictation timeout', 10),
    row('2', 'pc222222', 'user', 'Phone call routing', 20),
    row('3', 'pc222222', 'agent', 'Wiring the hand-off RPC', 21),
  ]
  const sent: Array<{ text: string; chat: string; origin: unknown }> = []
  const steered: Array<{ id: string; message: string }> = []
  const shown: string[] = []
  const running = new Set(['pc222222'])
  const deps: CallHandoffDeps = {
    store: {
      list: (async (entity: string) => (entity === 'project' ? projects : rows)) as CallHandoffDeps['store']['list'],
      upsert: async (_entity, patch) => {
        const at = projects.findIndex((p) => p.id === patch.id)
        projects[at] = { ...projects[at]!, ...patch } as ProjectRow
        return projects[at]
      },
    },
    send: async (text, chat, origin) => {
      sent.push({ text, chat, origin })
    },
    steer: async (id, message) => {
      steered.push({ id, message })
      return 'Sent to the helper.'
    },
    cards: async () => ({ seq: 1, at: 1, cards: [{ ...card('h0', 'Desktop dictation fix', 'failed', ''), endedAt: Date.now() - 1000 }, card('h1', 'Desktop dictation fix', 'working', 'Building the installer'), card('pa-pc222222', 'Agent Desktop App', 'working', '')] }),
    state: (chat) => ({ running: running.has(chat), waiting: [] }),
    agentName: () => 'Hina',
    delegated: async (chat, project) => {
      shown.push(`${project.name}:${chat}`)
    },
  }
  return { deps, sent, steered, projects, shown }
}

describe('a call hands work to the agent it names', () => {
  it('lists the main agent, each project with its chats and what they do, and the helpers at work', async () => {
    const { deps } = setup()
    const targets = await callTargets(deps)
    expect(targets.map((t) => `${t.kind}:${t.name}`)).toEqual(['main:Hina', 'project:Agent Desktop App', 'project:Strat Edge Website', 'project:Strat Edge Solutions', 'helper:Desktop dictation fix', 'helper:Desktop dictation fix'])
    const ada = targets[1]!
    expect(ada.running).toBe(true)
    expect(ada.doing).toBe('Wiring the hand-off RPC')
    expect(ada.chats.map((c) => c.title)).toEqual(['Fix the dictation timeout', 'Phone call routing'])
    expect(targets[4]!).toMatchObject({ id: 'h1', running: true, doing: 'Building the installer' })
  })

  it('answers at once, without waiting for the turn it started (it may wait minutes on an approval)', async () => {
    const { deps } = setup()
    const never = { ...deps, send: () => new Promise<void>(() => undefined) }
    const result = await Promise.race([callHandoff(never, { target: 'main', message: 'Email Ben' }), new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))])
    expect(result).toMatchObject({ ok: true, kind: 'main' })
    const project = await Promise.race([callHandoff(never, { target: 'Kitchen', message: 'x' }).catch(() => 'none'), new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))])
    expect(project).not.toBe('blocked')
  })

  it('sends anything unnamed to the main agent', async () => {
    const { deps, sent } = setup()
    const result = await callHandoff(deps, { target: 'main', message: 'Email Ben the report' }, { device: 'phone' })
    expect(result).toMatchObject({ ok: true, kind: 'main', said: "I'm on it." })
    expect(sent).toEqual([{ text: 'Email Ben the report', chat: 'main', origin: { device: 'phone' } }])
    expect(await callHandoff(deps, { target: '', message: 'x' })).toMatchObject({ ok: true, kind: 'main' })
  })

  it('sends to a project by a forgiving name, into its working chat', async () => {
    const { deps, sent, shown } = setup()
    const result = await callHandoff(deps, { target: 'the agent desktop app project', message: 'Ship 0.2.51' })
    // It shows in the main chat as that project's agent, like work the main agent hands over.
    expect(shown).toEqual(['Agent Desktop App:pc222222'])
    expect(result).toMatchObject({ ok: true, kind: 'project', name: 'Agent Desktop App', chat: 'pc222222', said: "I'm on it in the Agent Desktop App project." })
    expect(sent.at(-1)).toMatchObject({ chat: 'pc222222', text: 'Ship 0.2.51' })
    expect(await callHandoff(deps, { target: 'strategic website', message: 'hi' })).toMatchObject({ ok: true, name: 'Strat Edge Website', chat: 'pc333333' })
  })

  it('starts a new chat in a project when asked, or when it has none', async () => {
    const { deps, sent, projects } = setup()
    const fresh = await callHandoff(deps, { target: 'Agent Desktop App', message: 'New idea', newChat: true })
    expect(fresh).toMatchObject({ ok: true, said: "I've started a new chat on it in the Agent Desktop App project." })
    const chat = fresh.ok ? fresh.chat : ''
    expect(chat).toMatch(/^pc[a-z0-9]+$/)
    expect(projects[0]!.chats).toContain(chat)
    expect(sent.at(-1)?.chat).toBe(chat)
    const empty = await callHandoff(deps, { target: 'Strat Edge Solutions', message: 'Hello' })
    expect(empty).toMatchObject({ ok: true, said: "I've started a new chat on it in the Strat Edge Solutions project." })
  })

  it('steers a helper by its label, the one at work when two share it', async () => {
    const { deps, steered, sent } = setup()
    const result = await callHandoff(deps, { target: 'the dictation helper', message: 'Use the 30 second limit' })
    expect(result).toMatchObject({ ok: true, kind: 'helper', id: 'h1', said: 'I\'ve passed it to my helper "Desktop dictation fix".' })
    expect(steered).toEqual([{ id: 'h1', message: 'From the person, on a voice call: Use the 30 second limit' }])
    expect(sent).toEqual([])
  })

  it('asks which one when two are close, and says so when none matches', async () => {
    const { deps, sent } = setup()
    const two = await callHandoff(deps, { target: 'Strat Edge', message: 'hi' })
    expect(two.ok).toBe(false)
    if (!two.ok) expect(two.ambiguous.map((a) => a.name).sort()).toEqual(['Strat Edge Solutions', 'Strat Edge Website'])
    const none = await callHandoff(deps, { target: 'Lender Selector', message: 'hi' })
    expect(none).toMatchObject({ ok: false, ambiguous: [] })
    expect(sent).toEqual([])
  })
})
