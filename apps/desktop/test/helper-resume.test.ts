/**
 * Helpers that live through a steer, a restart and a lost link (25 Oct 2026).
 *
 *  - A steer never stops a plan helper. It used to: the engine told the model "the user doesn't want to take this
 *    action, STOP", and when the stop took more than 5 s the note was dropped, the run ended with its card still
 *    working, and the orphan watch ended a live helper as "its run was lost" three minutes later.
 *  - A helper sent back after a restart gets its full brief, its earlier steps and every message it was sent, not
 *    only its label (a plan session cut off mid-turn was never saved, so it came back knowing nothing).
 *  - A helper pinned to a device keeps it: another brain's lease failover does not take it over.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, schema, type DeviceRow, type Tool } from '@agent/core'

import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import type { CliTurn } from '../src/main/runtime/cli-agent'
import type { CliHost, CliTurnRequest } from '../src/main/runtime/cli-host'
import { HelperManager, type OffloadLink } from '../src/main/runtime/helpers'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { RESUME_NOTE, TurnLeases } from '../src/main/runtime/turns'
import { secretsView, settingsView, testContext } from './support'

// ---- the real plan host, with the engine itself scripted -------------------------------------------------------

const engine: { calls: CliTurn[]; hang: boolean } = { calls: [], hang: false }
vi.mock('../src/main/runtime/cli-agent', async (original) => {
  const real = await original<typeof import('../src/main/runtime/cli-agent')>()
  return {
    ...real,
    runCliTurn: async (turn: CliTurn) => {
      engine.calls.push(turn)
      const named = turn.sessionId ?? `sess-${engine.calls.length}`
      turn.onSession?.(named)
      // The app stops mid-turn: the turn never comes back.
      if (engine.hang) return new Promise(() => undefined)
      return { sessionId: named, text: 'ok' }
    },
  }
})
const { CliHost: RealCliHost } = await import('../src/main/runtime/cli-host')

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean()
  engine.calls.length = 0
  engine.hang = false
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-resume-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---- a scripted plan host for the helper manager ---------------------------------------------------------------

interface Turn {
  req: CliTurnRequest
  release: (text?: string) => void
}

/** A plan host whose turns wait until released. A stopped turn takes `slowStopMs` to end, as the real engine can. */
function fakePlan(slowStopMs = 0): { cli: CliHost; turns: Turn[] } {
  const turns: Turn[] = []
  const cli = {
    turn: (req: CliTurnRequest) =>
      new Promise<{ text: string }>((resolve) => {
        turns.push({ req, release: (text = 'done') => resolve({ text }) })
        req.signal.addEventListener('abort', () => setTimeout(() => resolve({ text: '' }), slowStopMs), { once: true })
      }),
    forget: () => undefined,
  } as unknown as CliHost
  return { cli, turns }
}

const ping: Tool = {
  spec: { name: 'ping', description: 'Answers pong.', schema: schema([], {}) },
  run: async () => 'pong',
}

function planManager(db: Store, cli: CliHost, extra: Partial<ConstructorParameters<typeof HelperManager>[0]> = {}): { manager: HelperManager; delivered: string[] } {
  const delivered: string[] = []
  const manager = new HelperManager({
    store: db,
    settings: settingsView({ ...DEFAULT_SETTINGS, mode: 'subscription', cli: 'claude', notifications: false }),
    secrets: secretsView(''),
    providerFactory: () => null,
    workerTools: [...buildWorkerToolset({ store: db }), ping],
    cli,
    deliver: (note) => {
      delivered.push(note)
    },
    platform: 'linux',
    timeZone: 'UTC',
    ...extra,
  })
  cleanups.push(() => manager.shutdown())
  return { manager, delivered }
}

function idOf(started: string): string {
  const id = /#([0-9a-f-]{36})/.exec(started)?.[1]
  if (id === undefined) throw new Error(`no helper id in: ${started}`)
  return id
}

async function metaOf(db: Store, id: string): Promise<Record<string, unknown>> {
  const row = await db.get('chat_item', id)
  return row === null ? {} : (JSON.parse(row.meta) as Record<string, unknown>)
}

function memoryStore(): Store {
  const db = new Store(':memory:')
  cleanups.push(() => db.close())
  return db
}

// ---------------------------------------------------------------------------------------------------------------

describe('a steer never stops a plan helper', () => {
  it('the note reaches it at its next step, its run goes on, and a note it never read starts its next turn', async () => {
    const db = memoryStore()
    // The real engine took 8 s to end a stopped turn: longer than the old steer waited.
    const plan = fakePlan(8_000)
    const { manager, delivered } = planManager(db, plan.cli)
    const id = idOf(await manager.delegate([{ label: 'Long job', brief: 'BRIEF-ALPHA: fix the bugs and ship it.' }]))
    await waitFor(() => plan.turns.length === 1, 5_000)
    const first = plan.turns[0]!

    expect(await manager.steer(id, 'NOTE-ONE: do the reaper first')).toContain('keeps going')
    expect(first.req.signal.aborted).toBe(false)
    // It is held for the engine, which takes it as a message of its own: a tool result never carries it.
    const mail = first.req.messages!
    expect(await first.req.tools.find((tool) => tool.spec.name === 'ping')!.run({}, testContext())).not.toContain('NOTE-ONE')
    const taken = mail.take()
    expect(taken.map((note) => note.text).join('')).toContain('NOTE-ONE: do the reaper first')
    mail.read(taken.map((note) => note.id))
    expect(await first.req.tools.find((tool) => tool.spec.name === 'ping')!.run({}, testContext())).toBe('pong')
    // Another one the engine took, but the turn ended before it read it, comes back to wait.
    await manager.steer(id, 'NOTE-TWO: save your progress')
    const second = mail.take()
    expect(second[0]?.text).toContain('NOTE-TWO: save your progress')
    expect(mail.take()).toEqual([])
    mail.read(second.map((note) => note.id))

    // A note that arrives after its last step: the turn ends, and it carries on with the note instead of ending.
    await manager.steer(id, 'NOTE-THREE: and close your tabs')
    first.release('first part done')
    await waitFor(() => plan.turns.length === 2, 5_000)
    expect(plan.turns[1]!.req.prompt).toContain('NOTE-THREE: and close your tabs')
    expect((await metaOf(db, id))['state']).toBe('working')
    expect(delivered.filter((note) => note.includes(id))).toHaveLength(0)
    // Nothing treats it as lost while it works.
    expect(await manager.reap()).toBe(0)

    plan.turns[1]!.release('all done')
    await waitFor(async () => (await metaOf(db, id))['state'] === 'done', 5_000)
    expect(delivered.filter((note) => note.includes(id))).toHaveLength(1)
  }, 30_000)
})

describe('a helper resumed after a restart keeps its brief and history', () => {
  it('a plan helper cut off mid-run comes back with its full brief, earlier steps, result and every push', async () => {
    const db = memoryStore()
    const before = fakePlan()
    const leasesBefore = new TurnLeases({ store: db, selfId: () => 'brain-pc', resumeTurn: () => undefined, resumeJob: () => undefined })
    cleanups.push(() => leasesBefore.stop())
    const { manager: first } = planManager(db, before.cli, { leases: leasesBefore })
    const brief = 'BRIEF-BETA: build 0.2.78, prove it in a test copy, then redeploy the server node. Every step matters.'
    const id = idOf(await first.delegate([{ label: 'Agent mobile app PRs', brief }]))
    await waitFor(() => before.turns.length === 1, 5_000)
    const one = before.turns[0]!
    await one.req.onCall({ id: 'c1', name: 'browser_open', input: { url: 'https://step-one.example.com' } })
    await one.req.onResult({ id: 'c1', name: 'browser_open', input: { url: 'https://step-one.example.com' } }, 'URL: https://step-one.example.com/', false)
    one.release('RESULT-ONE: the first half is done')
    await waitFor(async () => (await metaOf(db, id))['state'] === 'done', 5_000)

    expect(await first.push(id, 'PUSH-ONE: now do the second half')).toContain('back on it')
    await waitFor(() => before.turns.length === 2, 5_000)
    const two = before.turns[1]!
    await two.req.onCall({ id: 'c2', name: 'memory_search', input: { query: 'STEP-TWO-QUERY' } })
    await leasesBefore.settled()
    // The app restarts here: the run never ends, its lease stays running, its session was never handed back.
    leasesBefore.stop()

    const after = fakePlan()
    let second: HelperManager | null = null
    const leasesAfter = new TurnLeases({ store: db, selfId: () => 'brain-pc', resumeTurn: () => undefined, resumeJob: async (helper, note) => {
      await second?.push(helper, note)
    } })
    cleanups.push(() => leasesAfter.stop())
    second = planManager(db, after.cli, { leases: leasesAfter }).manager
    await second.restore()
    expect(await leasesAfter.recover()).toBe(1)
    await waitFor(() => after.turns.length === 1, 5_000)
    const resumed = after.turns[0]!.req
    expect(resumed.prompt).toContain(RESUME_NOTE)
    // With no session to continue, the model gets all of it.
    const fresh = resumed.freshPrompt ?? ''
    expect(fresh).toContain(brief)
    expect(fresh).toContain('browser open')
    expect(fresh).toContain('STEP-TWO-QUERY')
    expect(fresh).toContain('RESULT-ONE: the first half is done')
    expect(fresh).toContain('PUSH-ONE: now do the second half')
    expect(fresh).toContain(RESUME_NOTE)
    after.turns[0]!.release()
  }, 30_000)

  it('the plan host keeps a session the moment the engine names it, and uses the rebuilt brief when there is none', async () => {
    const work = tempDir()
    const request = (thread: string, extra: Partial<CliTurnRequest> = {}): CliTurnRequest => {
      const signal = new AbortController().signal
      return {
        cli: 'claude',
        thread,
        tools: [],
        system: 's',
        prompt: 'CARRY-ON',
        freshPrompt: 'FULL-BRIEF-AND-STEPS',
        context: { agentLabel: 'helper', activity: async () => 0, updateActivity: async () => undefined, ask: async () => null, approve: async () => true, notify: async () => undefined, signal },
        signal,
        onEvent: async () => undefined,
        onCall: async () => undefined,
        onResult: async () => undefined,
        ...extra,
      }
    }
    // A turn cut off by a restart: it named its session, then never came back.
    engine.hang = true
    const before = new RealCliHost(work, () => ({ ...DEFAULT_SETTINGS }), process.cwd())
    cleanups.push(() => before.close())
    void before.turn(request('helper:h1'))
    await waitFor(() => engine.calls.length === 1, 5_000)
    expect(engine.calls[0]!.sessionId).toBeNull()
    expect(engine.calls[0]!.prompt).toBe('FULL-BRIEF-AND-STEPS')

    // The next start (a new host on the same folder) continues that session with the short note.
    engine.hang = false
    const after = new RealCliHost(work, () => ({ ...DEFAULT_SETTINGS }), process.cwd())
    cleanups.push(() => after.close())
    await after.turn(request('helper:h1'))
    expect(engine.calls[1]!.sessionId).toBe('sess-1')
    expect(engine.calls[1]!.prompt).toBe('CARRY-ON')
  }, 20_000)
})

describe('a helper pinned to a device keeps it', () => {
  it('delegated with a device named, its lease is never taken over by another brain; an unpinned one is', async () => {
    const db = memoryStore()
    const plan = fakePlan()
    const leasesPc = new TurnLeases({ store: db, selfId: () => 'brain-pc', resumeTurn: () => undefined, resumeJob: () => undefined })
    cleanups.push(() => leasesPc.stop())
    const { manager } = planManager(db, plan.cli, { leases: leasesPc })
    const link: OffloadLink = {
      selfId: () => 'brain-pc',
      isSelf: (other) => other === 'brain-pc',
      up: () => true,
      place: async () => ({ device: null, name: 'PC', why: '' }),
      send: async () => undefined,
      leaseHolder: async () => ({ device: '', running: false }),
      deviceName: async (other) => (other === 'brain-pc' ? 'PC' : 'Server'),
    }
    manager.setOffload(link)
    const pinned = idOf(await manager.delegate([{ label: 'Repo work', brief: 'Work in the repo on this computer.', device: 'here' }]))
    const free = idOf(await manager.delegate([{ label: 'Research', brief: 'Read about lease failover.' }]))
    await waitFor(() => plan.turns.length === 2, 5_000)
    expect((await metaOf(db, pinned))['pinned']).toBe(true)
    expect((await metaOf(db, pinned))['runOn']).toBe('brain-pc')
    expect((await metaOf(db, free))['pinned']).toBeUndefined()

    // The PC goes away mid-run: its leases stop beating.
    await leasesPc.settled()
    leasesPc.stop()
    for (const id of [pinned, free]) await db.upsert('turn_lease', { id: `job-${id}`, heartbeatAt: 1 })

    const resumed: string[] = []
    const brains = [
      { id: 'brain-srv', roles: ['brain'], priority: 0, revoked: false },
      { id: 'brain-pc', roles: ['brain'], priority: 1, revoked: false },
    ] as unknown as DeviceRow[]
    const server = new TurnLeases({
      store: db,
      selfId: () => 'brain-srv',
      resumeTurn: () => undefined,
      resumeJob: (helper) => {
        resumed.push(helper)
      },
      health: async (row) => ({ up: row.id === 'brain-srv', ready: row.id === 'brain-srv' }),
      brains: async () => brains,
    })
    cleanups.push(() => server.stop())
    expect(await server.claimStale()).toBe(1)
    expect(resumed).toEqual([free])
    expect((await db.get('turn_lease', `job-${pinned}`))?.brainId).toBe('brain-pc')
    for (const turn of plan.turns) turn.release()
  }, 30_000)
})
