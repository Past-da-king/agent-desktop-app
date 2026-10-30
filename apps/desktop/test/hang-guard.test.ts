/**
 * The 30 Oct 2026 hangs: Windows marked the app "Not responding" and killed it while 6 to 11 helpers ran. Live
 * profiles showed single SQLite writes taking 0.2 to 1.4 s on the main thread (a sync per commit, checkpoints inside
 * ordinary writes, a pulled page written as hundreds of commits) on a computer short of memory and disk.
 * These tests pin the fixes: cheap commits, checkpoints off the main thread, a pulled page in one transaction, the
 * helper reap reading only working cards, new helpers held while memory or disk is short, busy work placed on a
 * server, a watchdog that logs where the main thread was stuck, and test copies kept off the person's data.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type ChatItem, type JsonObject, type Settings, type Tool } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { startCheckpointWorker } from '../src/main/db-checkpoint'
import { copyVerdict, isInstalledCopy } from '../src/main/install-guard'
import { HelperManager, type HelperResources } from '../src/main/runtime/helpers'
import { choosePlacement, type PlaceCandidate } from '../src/main/runtime/offload'
import { autoHelperCap, busyReason, shortOf, type ResourceSample } from '../src/main/runtime/resources'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { startWatchdog, type BlockedReport } from '../src/main/watchdog'
import { SettingsStore } from '../src/main/settings'
import { secretsView, settingsView } from './support'

const dirs: string[] = []
const stores: Store[] = []
const managers: HelperManager[] = []
let fake: FakeAi | null = null

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stopAll()
  for (const store of stores.splice(0)) store.close()
  await fake?.close()
  fake = null
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fileStore(): { store: Store; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hang-guard-'))
  dirs.push(dir)
  const file = join(dir, 'agent.db')
  const store = new Store(file)
  stores.push(store)
  return { store, file }
}

describe('the store on the main thread', () => {
  it('commits without a sync per write (synchronous NORMAL) and keeps a larger page cache', () => {
    const { store } = fileStore()
    const p = store.pragmas()
    expect(p.synchronous).toBe(1)
    expect(p.cacheSize).toBeLessThanOrEqual(-32768)
  })

  it('moves checkpoints to a worker thread: the main connection stops checkpointing inside its writes', async () => {
    const { store, file } = fileStore()
    expect(store.pragmas().autocheckpoint).toBe(1000)
    expect(store.startCheckpointer({ everyMs: 100 })).toBe(true)
    expect(store.pragmas().autocheckpoint).toBe(0)
    for (let i = 0; i < 300; i++) await store.upsert('task', { title: `t${i}`.repeat(200), status: 'todo' } as never)
    await sleep(600)
    // Another connection sees nothing left to copy: the worker did it.
    const probe = new DatabaseSync(file)
    const r = probe.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { log: number; checkpointed: number }
    probe.close()
    expect(r.log).toBeGreaterThan(0)
    expect(r.checkpointed).toBe(r.log)
  })

  it('a checkpoint worker that cannot run reports it, so the store checkpoints inline again', async () => {
    let why = ''
    startCheckpointWorker(join(tmpdir(), 'no-such-dir-hang-guard', 'x', 'agent.db'), { everyMs: 50, onFail: (w) => (why = w) })
    await waitFor(() => why !== '', 5_000)
    expect(why).not.toBe('')
  })

  it('keeps whole lists of the small tables in memory, always as they are after every write and rollback', async () => {
    const { store } = fileStore()
    await store.upsert('task', { id: 't1', title: 'one', status: 'todo' } as never)
    expect((await store.list('task')).map((t) => t.title)).toEqual(['one'])
    await store.upsert('task', { id: 't1', title: 'one changed', status: 'todo' } as never)
    expect((await store.list('task')).map((t) => t.title)).toEqual(['one changed'])
    // A row handed out is a copy: changing it changes nothing held.
    ;(await store.list('task'))[0]!.title = 'scribbled'
    expect((await store.list('task'))[0]!.title).toBe('one changed')
    await store.applyRemote([{ entity: 'task', id: 't2', deleted: false, stamp: `${Date.now() + 60_000}-0-other-device`, payload: { title: 'two', status: 'todo' } as JsonObject }, { entity: 'task', id: 't3', deleted: false, stamp: `${Date.now() + 60_000}-1-other-device`, payload: { title: 'three', status: 'todo' } as JsonObject }] as never)
    expect((await store.list('task')).length).toBe(3)
    await expect(
      store.batch(async () => {
        await store.upsert('task', { id: 't4', title: 'rolled back', status: 'todo' } as never)
        expect((await store.list('task')).length).toBe(4)
        throw new Error('undo')
      }),
    ).rejects.toThrow('undo')
    expect((await store.list('task')).map((t) => t.id).sort()).toEqual(['t1', 't2', 't3'])
    await store.remove('task', 't1')
    expect((await store.list('task')).map((t) => t.id).sort()).toEqual(['t2', 't3'])
  })

  it('a long chain of store calls gives the event loop a turn (the window and timers are never held for long)', async () => {
    const { store } = fileStore()
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    let longest = 0
    let last = performance.now()
    const beat = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 1)
    const started = performance.now()
    for (let i = 0; performance.now() - started < 600; i++) await store.upsert('chat_item', { kind: 'activity', text: `step ${i}`, meta: JSON.stringify({ helper: 'h', status: 'done' }) } as never)
    clearInterval(timer)
    clearInterval(beat)
    // Before, a 1 ms timer got no turn at all for the whole 600 ms; under a loaded test run the slices are slower.
    expect(ticks).toBeGreaterThan(0)
    expect(longest).toBeLessThan(300)
  })

  it('applies a pulled page as one transaction (all or nothing), not two commits per change', async () => {
    const { store } = fileStore()
    const page = [0, 1, 2].map((n) => ({ entity: 'task', id: `remote-${n}`, deleted: false, stamp: `${1_700_000_000_000 + n}-0-other-device`, payload: { title: `r${n}`, status: 'todo' } as JsonObject }))
    // The third change cannot be written: with one transaction the first two roll back with it.
    ;(page[2]!.payload as Record<string, unknown>)['bad'] = 10n
    await expect(store.applyRemote(page as never)).rejects.toThrow()
    expect(await store.get('task', 'remote-0')).toBeNull()
    expect(await store.get('task', 'remote-1')).toBeNull()
  })
})

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }
const hasToolResult = (body: JsonObject): boolean => JSON.stringify(body).includes('"role":"tool"')

function resources(state: { short: string; busy?: string; comfortable?: number }): HelperResources & { fire(): void } {
  const listeners = new Set<() => void>()
  return {
    short: () => state.short,
    busy: () => state.busy ?? state.short,
    comfortable: () => state.comfortable ?? 100,
    onSample: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    fire: () => {
      for (const listener of listeners) listener()
    },
  }
}

function manager(res: HelperResources | undefined, tools: Tool[]): { manager: HelperManager; delivered: string[]; store: Store } {
  const store = new Store(':memory:')
  stores.push(store)
  const delivered: string[] = []
  const m = new HelperManager({
    store,
    settings: settingsView(READY),
    secrets: secretsView('test-key'),
    providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake!.url, allowHttp: true }),
    workerTools: [...buildWorkerToolset({ store }), ...tools],
    deliver: (note) => {
      delivered.push(note)
    },
    platform: 'linux',
    timeZone: 'UTC',
    ...(res === undefined ? {} : { resources: res }),
  })
  managers.push(m)
  return { manager: m, delivered, store }
}

function meta(row: ChatItem | null): Record<string, unknown> {
  return JSON.parse(row?.meta ?? '{}') as Record<string, unknown>
}

describe('helpers when this computer is short of memory or disk', () => {
  it('holds new helpers (one still runs), says why on their cards, and starts them when there is room again', async () => {
    let current = 0
    let peak = 0
    let gate = false
    const slowTool: Tool = {
      spec: { name: 'slow_tool', description: 'Takes a while.', schema: { type: 'object', properties: {} } },
      run: async () => {
        current++
        peak = Math.max(peak, current)
        await waitFor(() => gate, 10_000)
        current--
        return 'done'
      },
    }
    fake = await startFakeAi((body) => (hasToolResult(body) ? { text: 'Finished.' } : { toolCalls: [{ name: 'slow_tool', input: {} }] }))
    const state = { short: 'low on memory (0.8 GB free)' }
    const res = resources(state)
    const { manager: m, delivered, store } = manager(res, [slowTool])

    await m.delegate(Array.from({ length: 4 }, (_, i) => ({ label: `Job ${i + 1}`, brief: `Do job ${i + 1}.` })))
    await waitFor(() => current === 1, 5_000)
    await sleep(200)
    expect(current).toBe(1)
    const cards = (await store.list('chat_item')).filter((row) => row.kind === 'helper')
    const waiting = cards.filter((row) => meta(row)['queued'] === true)
    expect(waiting).toHaveLength(3)
    await waitFor(async () => (await store.list('chat_item')).filter((row) => row.kind === 'helper' && String(meta(row)['summary']).startsWith('Paused: low on memory (0.8 GB free)')).length === 3, 3_000)
    // helpers_status: a held helper is paused, with no working state, no Now and no steps of its own.
    const told = await m.status()
    expect(told.match(/\[paused, \d+m\]/g)).toHaveLength(3)
    expect(told.match(/\[working, /g)).toHaveLength(1)
    expect(told.match(/Paused: low on memory \(0\.8 GB free\)/g)).toHaveLength(3)
    expect(told.match(/\nNow: /g)).toHaveLength(1)

    state.short = ''
    res.fire()
    await waitFor(() => current === 4, 5_000)
    gate = true
    await waitFor(() => delivered.length === 4, 8_000)
    expect(peak).toBe(4)
  })

  it('with no resource view (tests, headless) every helper still runs at once: no ceiling of our own', async () => {
    let current = 0
    let peak = 0
    const slowTool: Tool = {
      spec: { name: 'slow_tool', description: 'Takes a while.', schema: { type: 'object', properties: {} } },
      run: async () => {
        current++
        peak = Math.max(peak, current)
        await sleep(300)
        current--
        return 'done'
      },
    }
    fake = await startFakeAi((body) => (hasToolResult(body) ? { text: 'Finished.' } : { toolCalls: [{ name: 'slow_tool', input: {} }] }))
    const { manager: m, delivered } = manager(undefined, [slowTool])
    await m.delegate(Array.from({ length: 6 }, (_, i) => ({ label: `Job ${i + 1}`, brief: `Do job ${i + 1}.` })))
    await waitFor(() => delivered.length === 6, 8_000)
    expect(peak).toBe(6)
  })

  it('finds a finished step by the row its start wrote, without reading the steps', async () => {
    const quick: Tool = { spec: { name: 'quick_tool', description: 'Answers at once.', schema: { type: 'object', properties: {} } }, run: async () => 'done' }
    fake = await startFakeAi((body) => {
      const results = (JSON.stringify(body).match(/"role":"tool"/g) ?? []).length
      return results < 3 ? { toolCalls: [{ name: 'quick_tool', input: {} }] } : { text: 'Finished.' }
    })
    const { manager: m, delivered, store } = manager(undefined, [quick])
    const kinds: string[] = []
    const original = store.listWhere.bind(store)
    store.listWhere = (async (entity: never, where: { kind?: string }) => {
      kinds.push(String(where.kind ?? ''))
      return original(entity, where as never)
    }) as typeof store.listWhere
    await m.delegate([{ label: 'Steps', brief: 'Take three steps.' }])
    await waitFor(() => delivered.length === 1, 8_000)
    expect(kinds.filter((k) => k === 'activity')).toEqual([])
    const steps = (await store.list('chat_item')).filter((row) => row.kind === 'activity')
    expect(steps).toHaveLength(3)
    expect(steps.every((row) => meta(row)['status'] !== 'running')).toBe(true)
  })

  it('helpers_status shows a working helper and its last steps without reading old steps', async () => {
    let calls = 0
    let gate = false
    const stepTool: Tool = {
      spec: { name: 'step_tool', description: 'One step.', schema: { type: 'object', properties: {} } },
      run: async () => {
        calls++
        if (calls >= 3) await waitFor(() => gate, 10_000)
        return 'done'
      },
    }
    fake = await startFakeAi((body) => ((JSON.stringify(body).match(/"role":"tool"/g) ?? []).length < 3 ? { toolCalls: [{ name: 'step_tool', input: {} }] } : { text: 'Finished.' }))
    const { manager: m, delivered, store } = manager(undefined, [stepTool])
    for (let i = 0; i < 12; i++) await store.upsert('chat_item', { kind: 'helper', text: `old ${i}`, createdAt: 1_000 + i, meta: JSON.stringify({ state: 'done', label: `Old ${i}`, result: 'r' }) } as never)
    for (let i = 0; i < 50; i++) await store.upsert('chat_item', { kind: 'activity', text: `old step ${i}`, createdAt: 2_000 + i, meta: JSON.stringify({ helper: 'x', status: 'done' }) } as never)
    await m.delegate([{ label: 'Busy one', brief: 'Take steps.' }])
    await waitFor(() => calls >= 3, 8_000)
    const reads: Array<{ kind?: string; since?: number }> = []
    const original = store.listWhere.bind(store)
    store.listWhere = (async (entity: never, where: { kind?: string; since?: number }) => {
      reads.push(where)
      return original(entity, where as never)
    }) as typeof store.listWhere
    const text = await m.status()
    gate = true
    await waitFor(() => delivered.length === 1, 8_000)
    expect(text).toContain('Busy one [working')
    expect(text).toMatch(/Recent steps: .*step/i)
    expect(text.split('\n').filter((line) => line.startsWith('#') && line.includes('[done')).length).toBeLessThanOrEqual(9)
    expect(reads.filter((r) => r.kind === 'activity')).toEqual([])
  })

  it('reads only the cards still working when it reaps (not every helper card ever)', async () => {
    fake = await startFakeAi(() => ({ text: 'ok' }))
    const { manager: m, store } = manager(undefined, [])
    for (let i = 0; i < 5; i++) await store.upsert('chat_item', { kind: 'helper', text: 'old', meta: JSON.stringify({ state: 'done', summary: 'Done' }) } as never)
    await store.upsert('chat_item', { kind: 'helper', text: 'live', meta: JSON.stringify({ state: 'working', summary: 'x' }) } as never)
    const seen: unknown[] = []
    const original = store.listWhere.bind(store)
    store.listWhere = (async (entity: never, where: never) => {
      const rows = await original(entity, where)
      seen.push({ where, rows: rows.length })
      return rows
    }) as typeof store.listWhere
    await m.reap()
    const helperRead = seen.find((each) => (each as { where: { kind?: string } }).where.kind === 'helper') as { rows: number } | undefined
    expect(helperRead?.rows).toBe(1)
  })
})

describe('what this computer has to spare', () => {
  const sample = (over: Partial<ResourceSample>): ResourceSample => ({ freeRamGb: 8, totalRamGb: 16, freeDiskGb: 50, cpuPercent: 10, at: 0, ...over })
  const limits = { minFreeRamGb: 1.5, minFreeDiskGb: 5, busyCpuPercent: 90 }

  it('says why when memory or disk is short, and nothing when there is room or no check', () => {
    expect(shortOf(sample({ freeRamGb: 0.5 }), limits)).toMatch(/low on memory \(0\.5 GB free\)/)
    expect(shortOf(sample({ freeDiskGb: 2.2 }), limits)).toMatch(/low on disk space \(2\.2 GB free\)/)
    expect(shortOf(sample({}), limits)).toBe('')
    expect(shortOf(sample({ freeRamGb: 0.5 }), { ...limits, minFreeRamGb: 0 })).toBe('')
    expect(busyReason(sample({ cpuPercent: 97 }), limits)).toMatch(/busy \(CPU 97%\)/)
  })

  it('works out a comfortable number of helpers from the cores and memory', () => {
    expect(autoHelperCap(8, 16)).toBe(4)
    expect(autoHelperCap(2, 4)).toBe(2)
    expect(autoHelperCap(64, 256)).toBe(8)
  })

  it('takes the thresholds as settings (decimals, 0 = off), with defaults', () => {
    expect(DEFAULT_SETTINGS.helperMinFreeRamGb).toBe(1.5)
    expect(DEFAULT_SETTINGS.helperMinFreeDiskGb).toBe(5)
    expect(DEFAULT_SETTINGS.watchdogMs).toBe(1000)
    const dir = mkdtempSync(join(tmpdir(), 'hang-guard-settings-'))
    dirs.push(dir)
    const settings = new SettingsStore(join(dir, 'settings.json'))
    expect(settings.save({ helperMinFreeRamGb: '2.5' as never, helperMinFreeDiskGb: '' as never }).helperMinFreeRamGb).toBe(2.5)
    expect(settings.get().helperMinFreeDiskGb).toBe(0)
  })
})

describe('placing work while this computer is busy', () => {
  const server: PlaceCandidate = { id: 'srv', name: 'impetix', kind: 'server', up: true, capacity: { name: 'impetix', kind: 'server', accounts: ['acc'], cap: 1_000_000, active: 2, browser: true } }

  it('a job asked to run "here" that does not need this computer goes to a free server while this one is busy', () => {
    const r = choosePlacement({ text: 'Research the best CRM\nCompare prices', account: 'acc', device: 'here', busy: 'this computer is low on memory (0.9 GB free)' }, [server], 'desktop', 'best')
    expect(r.device).toBe('srv')
    expect(r.why).toMatch(/low on memory/)
  })

  it('stays here when it needs this computer, when it is not busy, or when the person set "here" for all helpers', () => {
    expect(choosePlacement({ text: 'Build it in C:\\temp\\x', account: 'acc', device: 'here', busy: 'busy' }, [server], 'desktop', 'best').device).toBeNull()
    expect(choosePlacement({ text: 'Research', account: 'acc', device: 'here', busy: '' }, [server], 'desktop', 'best').device).toBeNull()
    expect(choosePlacement({ text: 'Research', account: 'acc', busy: 'busy' }, [server], 'desktop', 'here').device).toBeNull()
  })
})

describe('the main-thread watchdog', () => {
  it('logs a blocked main thread with the stack that blocked it', async () => {
    const reports: BlockedReport[] = []
    const errors: string[] = []
    const dog = startWatchdog({ blockedMs: 500, windowMs: 1_500, onBlocked: (r) => reports.push(r), onError: (e) => errors.push(e) })
    try {
      await sleep(300)
      const hogTheMainThread = (ms: number): number => {
        const end = Date.now() + ms
        let x = 0
        while (Date.now() < end) x += Math.sqrt(x + 1)
        return x
      }
      hogTheMainThread(1_100)
      await waitFor(() => reports.length > 0, 6_000)
    } finally {
      dog.stop()
    }
    expect(errors).toEqual([])
    expect(reports[0]!.ms).toBeGreaterThanOrEqual(900)
    expect(reports[0]!.stacks.join('\n')).toContain('hogTheMainThread')
  })
})

describe('a test copy never opens the person data', () => {
  const base = {
    platform: 'win32',
    packaged: true,
    exe: 'C:\\temp\\desksheet\\app\\Agent.exe',
    productName: 'Agent',
    userDataOverride: '',
    userDataSwitch: false,
    allowDefault: false,
    installedExe: 'C:\\Users\\me\\AppData\\Local\\Programs\\Agent\\Agent.exe',
  }
  const installed = new Set(['C:\\Users\\me\\AppData\\Local\\Programs\\Agent\\Agent.exe'])
  const exists = (p: string): boolean => installed.has(p) || /Programs[\\/]Agent[\\/]Uninstall Agent\.exe$/.test(p)

  it('an unpacked copy with no data folder of its own refuses and hands over to the installed app', () => {
    const v = copyVerdict({ ...base, exists })
    expect(v.ok).toBe(false)
    expect(v.handTo).toBe(base.installedExe)
    expect(isInstalledCopy({ ...base, exists })).toBe(false)
  })

  it('the installed app, a copy with its own data folder, or development start normally', () => {
    expect(copyVerdict({ ...base, exe: base.installedExe, exists }).ok).toBe(true)
    expect(copyVerdict({ ...base, userDataOverride: 'C:\\temp\\ud', exists }).ok).toBe(true)
    expect(copyVerdict({ ...base, userDataSwitch: true, exists }).ok).toBe(true)
    expect(copyVerdict({ ...base, packaged: false, exists }).ok).toBe(true)
    expect(copyVerdict({ ...base, platform: 'linux', exists }).ok).toBe(true)
  })

  it('with no installed app to hand over to, it explains instead', () => {
    const v = copyVerdict({ ...base, exists: () => false })
    expect(v.ok).toBe(false)
    expect(v.handTo).toBe('')
    expect(v.why).toMatch(/not the installed app/)
  })
})
