/**
 * Nothing runs unseen (28 Oct 2026). After the 0.2.94 install the 20:30 'Cosmiprint engagement' routine was started
 * again at 20:31 (its cut-off run had left the day's slot open), the start-up repair marked its fresh card failed
 * while it drove TikTok for 20 minutes, helper_stop did not know its id, and switching the routine off did not stop
 * it; a background script kept opening tabs with no row at all. These hold every run to: a working card while it
 * runs, a stop by its id (helper_stop, Stop all, its card), its tabs named, and a slot that never runs twice.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, MAIN_CHAT, providerFor, runningScripts, scriptTools, type ChatItem, type Settings, type Tool, type ToolContext, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { ownerLabel, plainOwner, setOwnerLabeller } from '../src/main/browser/owner'
import { runEnded } from '../src/main/browser/run-tabs'
import { HelperManager } from '../src/main/runtime/helpers'
import { liveRuns } from '../src/main/runtime/live-runs'
import { Runner, routineCardId } from '../src/main/runtime/runner'
import { CATCH_UP_MS, Scheduler, isDue } from '../src/main/runtime/scheduler'
import { scriptCardId, watchBackgroundScripts } from '../src/main/runtime/script-runs'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { helperCards } from '../src/shared/helper-cards'
import { secretsView, settingsView } from './support'

const stores: Store[] = []
let fake: FakeAi | null = null
const runners: Runner[] = []
const offs: Array<() => void> = []
afterEach(async () => {
  for (const off of offs.splice(0)) off()
  liveRuns.stopAll('test end')
  for (const runner of runners.splice(0)) runner.dispose()
  for (const store of stores.splice(0)) store.close()
  await fake?.close()
  fake = null
})

function open(): Store {
  const store = new Store(':memory:')
  stores.push(store)
  return store
}

const ROUTINE: TriggerRow = { id: 'engage', name: 'Cosmiprint engagement', kind: 'daily', spec: '20:30', prompt: 'Engage on TikTok.', enabled: true, lastRunAt: null, lastResult: '', createdAt: 0 }
const meta = (row: ChatItem | null): Record<string, unknown> => (row === null ? {} : (JSON.parse(row.meta) as Record<string, unknown>))

/** A tool that holds the run until it is stopped. */
const waitTool: Tool = {
  spec: { name: 'wait_here', description: 'waits', input_schema: { type: 'object', properties: {} } },
  run: async (_input, ctx) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 20_000)
      ctx.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return 'ok'
  },
}

function runnerFor(database: Store, url: () => string): Runner {
  const ready: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true }
  const runner = new Runner({
    store: database,
    settings: settingsView({ ...DEFAULT_SETTINGS, ...ready }),
    secrets: secretsView('test-key'),
    tools: [...buildToolset({ store: database }), waitTool],
    providerFactory: (_current, apiKey) => providerFor({ provider: 'openai', key: apiKey, baseUrl: url(), allowHttp: true }),
    notifyCard: () => undefined,
    isFocused: () => false,
    timeZone: 'UTC',
  })
  runners.push(runner)
  return runner
}

function helpersFor(database: Store): HelperManager {
  return new HelperManager({
    store: database,
    settings: settingsView({ ...DEFAULT_SETTINGS, hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true }),
    secrets: secretsView('test-key'),
    providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: 'http://127.0.0.1:9', allowHttp: true }),
    workerTools: buildWorkerToolset({ store: database }),
    deliver: () => undefined,
    platform: 'linux',
    timeZone: 'UTC',
  })
}

async function startHeldRoutine(): Promise<{ database: Store; runner: Runner; done: Promise<{ text: string; stopped?: boolean }> }> {
  fake = await startFakeAi((_body, index) => (index === 0 ? { toolCalls: [{ name: 'wait_here', input: {} }] } : { text: 'late' }))
  const database = open()
  const runner = runnerFor(database, () => fake?.url ?? '')
  await database.upsert('trigger', { ...ROUTINE })
  const done = runner.runRoutine(ROUTINE)
  await waitFor(async () => (liveRuns.has(routineCardId(ROUTINE.id)) ? true : undefined))
  return { database, runner, done }
}

describe('a routine run is a live run with a stop', () => {
  it('helper_stop with its card id stops it, and its card says stopped', async () => {
    const { database, done } = await startHeldRoutine()
    const helpers = helpersFor(database)
    expect(await helpers.status()).toContain(routineCardId(ROUTINE.id))
    const started = Date.now()
    expect(await helpers.stop(routineCardId(ROUTINE.id), 'the main agent')).toBe(true)
    const result = await done
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result.stopped).toBe(true)
    expect(meta(await database.get('chat_item', routineCardId(ROUTINE.id)))['state']).toBe('stopped')
    expect(liveRuns.has(routineCardId(ROUTINE.id))).toBe(false)
  }, 20_000)

  it('Stop all stops it', async () => {
    const { database, done } = await startHeldRoutine()
    expect(await helpersFor(database).stopAll('the person')).toBeGreaterThanOrEqual(1)
    expect((await done).stopped).toBe(true)
  }, 20_000)

  it('switching the routine off stops it', async () => {
    const { database, done } = await startHeldRoutine()
    await database.upsert('trigger', { id: ROUTINE.id, enabled: false })
    expect((await done).stopped).toBe(true)
  }, 20_000)

  it('the start-up repair leaves a live routine card working, and a card marked failed under it is put right', async () => {
    const { database, done } = await startHeldRoutine()
    await helpersFor(database).restore()
    expect(meta(await database.get('chat_item', routineCardId(ROUTINE.id)))['state']).toBe('working')
    // Something else ends the card while it runs: its next step puts it back to working.
    const row = (await database.get('chat_item', routineCardId(ROUTINE.id)))!
    await database.upsert('chat_item', { id: row.id, kind: 'helper', text: row.text, meta: JSON.stringify({ ...meta(row), state: 'failed', summary: 'Failed: the app restarted' }) })
    ;(runners[0] as unknown as { routineStep(text: string): void }).routineStep('Using browser open')
    await waitFor(async () => (meta(await database.get('chat_item', routineCardId(ROUTINE.id)))['state'] === 'working' ? true : undefined), 5000)
    const card = helperCards(await database.list('chat_item'), []).find((each) => each.id === routineCardId(ROUTINE.id))
    expect(card?.state).toBe('working')
    liveRuns.stop(routineCardId(ROUTINE.id))
    await done
  }, 20_000)
})

describe('a slot runs once, and a late one is skipped', () => {
  const day = (h: number, m: number): number => new Date(2026, 9, 28, h, m).getTime()

  it('a run records its slot as it starts, so a run cut off is not run again', async () => {
    const database = open()
    await database.upsert('trigger', { ...ROUTINE })
    let calls = 0
    // The first process starts the run and dies in it (an update, a kill): its run never finishes.
    const first = new Scheduler({ store: database, now: () => day(20, 30), runner: { runRoutine: () => ((calls += 1), new Promise(() => undefined)) } })
    void first.tick()
    await waitFor(async () => (calls === 1 ? true : undefined))
    first.stop()
    // The app starts again a minute later: the slot was taken, so it is not run again.
    const second = new Scheduler({ store: database, now: () => day(20, 31), runner: { runRoutine: async () => ((calls += 1), { text: 'again', waiting: false }) } })
    await second.tick()
    expect(calls).toBe(1)
  })

  it('a daily run missed by more than 15 minutes is skipped unless it says catch up; an off routine never runs', () => {
    const missed: TriggerRow = { ...ROUTINE, lastRunAt: day(20, 30) - 24 * 3600_000 }
    expect(isDue(missed, day(20, 30) + CATCH_UP_MS - 1000)).toBe(true)
    expect(isDue(missed, day(20, 30) + CATCH_UP_MS + 1000)).toBe(false)
    expect(isDue({ ...missed, catchUp: true }, day(23, 0))).toBe(true)
  })

  it('a routine switched off while queued does not run', async () => {
    const database = open()
    await database.upsert('trigger', { ...ROUTINE, enabled: false })
    let calls = 0
    const scheduler = new Scheduler({ store: database, now: () => day(20, 31), runner: { runRoutine: async () => ((calls += 1), { text: 'x', waiting: false }) } })
    await scheduler.tick()
    expect(calls).toBe(0)
  })
})

describe('background scripts are visible, stoppable and end with their run', () => {
  const ctxFor = (owner: string, signal?: AbortSignal): ToolContext =>
    ({ agentLabel: owner, owner, chat: MAIN_CHAT, activity: async () => 0, updateActivity: async () => undefined, ask: async () => null, approve: async () => false, notify: async () => undefined, ...(signal === undefined ? {} : { signal }) }) as ToolContext

  it('gets a working card and a live run; its stop ends it and the card says stopped', async () => {
    const database = open()
    offs.push(watchBackgroundScripts(database, () => undefined))
    const [run] = scriptTools({ tools: () => [] })
    const said = await run!.run({ code: 'while (true) { await sleep(50) }', background: true, timeout_seconds: 30 }, ctxFor('main'))
    const id = /as (scr_\w+)/.exec(String(said))?.[1] ?? ''
    expect(id).not.toBe('')
    const card = await waitFor(async () => {
      const row = await database.get('chat_item', scriptCardId(id))
      return row !== null && meta(row)['state'] === 'working' ? row : undefined
    })
    expect(card.kind).toBe('helper')
    expect(helperCards(await database.list('chat_item'), []).some((each) => each.id === scriptCardId(id) && each.state === 'working')).toBe(true)
    expect(liveRuns.stop(scriptCardId(id), 'the person')).toBe(true)
    await waitFor(async () => (meta(await database.get('chat_item', scriptCardId(id)))['state'] === 'stopped' ? true : undefined), 5000)
    expect(liveRuns.has(scriptCardId(id))).toBe(false)
  }, 15_000)

  it("a routine's script ends when the routine's run ends, and when its run is stopped", async () => {
    const database = open()
    offs.push(watchBackgroundScripts(database, () => undefined))
    const [run] = scriptTools({ tools: () => [] })
    await run!.run({ code: 'while (true) { await sleep(50) }', background: true, timeout_seconds: 30 }, ctxFor('routine'))
    expect(runningScripts().some((script) => script.owner === 'routine')).toBe(true)
    runEnded('routine')
    await waitFor(async () => (runningScripts().some((script) => script.owner === 'routine') ? undefined : true), 5000)
    const parent = new AbortController()
    await run!.run({ code: 'while (true) { await sleep(50) }', background: true, timeout_seconds: 30 }, ctxFor('helper:h1', parent.signal))
    parent.abort()
    await waitFor(async () => (runningScripts().some((script) => script.owner === 'helper:h1') ? undefined : true), 5000)
  }, 15_000)
})

describe('the browser names who owns a tab, and an unseen run may not drive it', () => {
  it('owner labels', () => {
    expect(plainOwner('main')).toBe('main agent')
    setOwnerLabeller((owner) => (owner === 'routine' ? 'routine: Cosmiprint engagement' : ''))
    expect(ownerLabel('routine')).toBe('routine: Cosmiprint engagement')
    expect(ownerLabel('helper:abc')).toBe('helper abc')
    setOwnerLabeller(() => '')
  })

  it('a routine with no live run cannot use browser tools', async () => {
    const database = open()
    const tool = buildToolset({ store: database }).find((each) => each.spec.name.startsWith('browser_'))
    expect(tool).toBeDefined()
    const said = await tool!.run({ url: 'https://www.tiktok.com' }, { agentLabel: 'routine', owner: 'routine', chat: MAIN_CHAT } as ToolContext)
    expect(String(said)).toContain('not on screen')
  })
})
