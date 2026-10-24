/**
 * Every run owns the tabs it opened, and they close when it ends (24 Oct 2026). A helper's and a routine's at once
 * (done, stopped or failed), the main agent's after a few idle minutes; never the person's tab, the tab on screen,
 * a tab another live run drives, or the shared site tab learned apps reuse. browser_close closes one by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, providerFor, type Settings, type TriggerRow } from '@agent/core'

import { startFakeAi, type FakeAi } from '../../../packages/core/test/fake-ai'
import { waitFor } from '../../../packages/core/test/helpers'
import { Store } from '../src/main/db'
import { currentOwner } from '../src/main/browser/owner'
import { MAIN_IDLE_MS, onRunEnded, RunTabs, runEnded, type BrowserFacts } from '../src/main/browser/run-tabs'
import { unavailableBrowser, type BrowserDriver } from '../src/main/browser/types'
import { HeadlessBrowser } from '../src/headless/browser'
import { HelperManager } from '../src/main/runtime/helpers'
import { Runner } from '../src/main/runtime/runner'
import { buildToolset, buildWorkerToolset } from '../src/main/runtime/toolset'
import { browserTools } from '../src/main/tools/browser'
import { secretsView, settingsView, testContext, toolNamed } from './support'

// The run tests start a helper or a turn against a local model; on a busy machine that takes seconds.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

let fake: FakeAi | null = null
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  await fake?.close()
  fake = null
})

function facts(open: string[], extra: Partial<BrowserFacts> = {}): BrowserFacts {
  return { open, personTab: null, shown: null, driving: new Map(), ...extra }
}

describe('RunTabs: which tabs close when a run ends', () => {
  it('a helper that opened three tabs leaves none when it ends', () => {
    const tabs = new RunTabs()
    for (const id of ['t1', 't2', 't3']) tabs.opened(id, 'helper:h1')
    tabs.end('helper:h1', 0)
    const plan = tabs.sweep(0, facts(['t1', 't2', 't3'], { driving: new Map([['helper:h1', 't3']]) }))
    expect(plan.close.sort()).toEqual(['t1', 't2', 't3'])
    expect(plan.drop).toEqual(['helper:h1'])
  })

  it("keeps the person's tab, the tab he took over, the shown tab, a shared site tab and another run's tab", () => {
    const tabs = new RunTabs()
    // p0 is his own (no agent opened it); t1 he took over; t2 is on screen; t3 is the WhatsApp tab; t4 another helper drives now.
    for (const id of ['t1', 't2', 't3', 't4', 't5']) tabs.opened(id, 'helper:h1')
    tabs.shared('t3')
    tabs.end('helper:h1', 0)
    const open = ['p0', 't1', 't2', 't3', 't4', 't5']
    const plan = tabs.sweep(0, facts(open, { personTab: 't1', shown: 't2', driving: new Map([['helper:h1', 't5'], ['helper:h2', 't4']]) }))
    expect(plan.close).toEqual(['t5'])
    expect(plan.idle.sort()).toEqual(['t2', 't3'])
    // t4 now belongs to the run that drives it, and closes when that one ends.
    expect(tabs.ownerOf('t4')).toBe('helper:h2')
    expect(tabs.ownerOf('t1')).toBeUndefined()
    expect(tabs.ownerOf('p0')).toBeUndefined()

    // The shown tab closes once it is no longer on screen; his tabs never do.
    const later = tabs.sweep(1, facts(['p0', 't1', 't2', 't3', 't4'], { personTab: null, shown: 'p0', driving: new Map([['helper:h2', 't4']]) }))
    expect(later.close).toEqual(['t2'])
    tabs.end('helper:h2', 1)
    expect(tabs.sweep(2, facts(['p0', 't1', 't3', 't4'])).close).toEqual(['t4'])
    expect(tabs.pending()).toBe(false)
  })

  it("the main agent's tabs wait out the idle time, and browsing again keeps them", () => {
    const tabs = new RunTabs()
    tabs.opened('m1', 'main')
    tabs.end('main', MAIN_IDLE_MS)
    expect(tabs.sweep(MAIN_IDLE_MS - 1, facts(['m1'], { driving: new Map([['main', 'm1']]) })).close).toEqual([])
    tabs.used('main')
    expect(tabs.sweep(MAIN_IDLE_MS + 1, facts(['m1'], { driving: new Map([['main', 'm1']]) })).close).toEqual([])
    tabs.end('main', MAIN_IDLE_MS * 2)
    expect(tabs.sweep(MAIN_IDLE_MS * 2, facts(['m1'], { driving: new Map([['main', 'm1']]) })).close).toEqual(['m1'])
  })

  it('a tab a page opened belongs to the run that owned the page; one he typed into is his', () => {
    const tabs = new RunTabs()
    tabs.opened('t1', 'helper:h1')
    tabs.opened('t2', tabs.ownerOf('t1')!)
    tabs.opened('t3', 'helper:h1')
    tabs.givenToPerson('t3')
    tabs.end('helper:h1', 0)
    expect(tabs.sweep(0, facts(['t1', 't2', 't3'])).close.sort()).toEqual(['t1', 't2'])
  })
})

/** A browser with the same ownership rules as the real ones, for driving through the real tools and runs. */
class FakeBrowser implements BrowserDriver {
  readonly open_: string[] = ['his-tab']
  readonly driving = new Map<string, string>()
  readonly runTabs = new RunTabs()
  shown: string | null = null
  /** Who opened each tab, in order, and the most tabs open at once. */
  readonly openedBy: string[] = []
  peak = 0
  private seq = 0
  private readonly off = onRunEnded((owner, grace) => {
    this.runTabs.end(owner, Date.now() + grace)
    if (grace === 0) this.sweep()
  })
  dispose(): void {
    this.off()
  }
  sweep(): void {
    const plan = this.runTabs.sweep(Date.now(), { open: this.open_, personTab: null, shown: this.shown, driving: this.driving })
    for (const owner of plan.drop) this.driving.delete(owner)
    for (const id of plan.close) this.open_.splice(this.open_.indexOf(id), 1)
  }
  private make(): string {
    const owner = currentOwner() ?? 'nobody'
    const id = `tab-${++this.seq}`
    this.open_.push(id)
    this.driving.set(owner, id)
    this.runTabs.opened(id, owner)
    this.openedBy.push(owner)
    this.peak = Math.max(this.peak, this.open_.length)
    return id
  }
  async open(url: string): Promise<string> {
    const owner = currentOwner() ?? 'nobody'
    if (!this.driving.has(owner)) this.make()
    this.runTabs.used(owner)
    return `Opened ${url}`
  }
  async openNewTab(url: string): Promise<string> {
    const id = this.make()
    return `Opened ${url} in ${id}`
  }
  async closeOwnTab(id?: string, all = false): Promise<string> {
    const owner = currentOwner() ?? 'nobody'
    const mine = this.runTabs.tabsOf(owner, { open: this.open_, driving: this.driving })
    const wanted = all ? mine : [id ?? this.driving.get(owner) ?? '']
    const closed = wanted.filter((tab) => mine.includes(tab))
    for (const tab of closed) {
      this.open_.splice(this.open_.indexOf(tab), 1)
      this.runTabs.forget(tab)
      if (this.driving.get(owner) === tab) this.driving.delete(owner)
    }
    return `Closed ${closed.join(', ')}`
  }
  snapshot = unavailableBrowser.snapshot
  read = unavailableBrowser.read
  click = unavailableBrowser.click
  type = unavailableBrowser.type
  press = unavailableBrowser.press
  scroll = unavailableBrowser.scroll
  waitFor = unavailableBrowser.waitFor
  back = unavailableBrowser.back
  screenshot = unavailableBrowser.screenshot
  upload = unavailableBrowser.upload
  setAgentDriving = unavailableBrowser.setAgentDriving
  hasPage(): boolean {
    return this.driving.has(currentOwner() ?? 'nobody')
  }
}

function providerFactory(): ReturnType<typeof providerFor> {
  return fake === null ? null : providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true })
}

describe('a run ending closes its tabs, through the real runs and tools', () => {
  it('a helper that opens three tabs leaves none behind when it ends; his tab and the shown tab stay', async () => {
    let step = 0
    fake = await startFakeAi(() => {
      step += 1
      if (step === 1) return { toolCalls: [{ name: 'browser_open', input: { url: 'https://example.com/a' } }] }
      if (step === 2) return { toolCalls: [{ name: 'browser_open', input: { url: 'https://example.com/b', new_tab: true } }] }
      if (step === 3) return { toolCalls: [{ name: 'browser_open', input: { url: 'https://example.com/c', new_tab: true } }] }
      return { text: 'Read all three.' }
    })
    const store = new Store(':memory:')
    const browser = new FakeBrowser()
    // A tab of the main agent's, on screen in the panel.
    const shown = await import('../src/main/browser/owner').then(({ browserOwner }) => browserOwner.run({ owner: 'main' }, async () => {
      await browser.open('https://example.com/main')
      return browser.driving.get('main')!
    }))
    browser.shown = shown
    const manager = new HelperManager({
      store,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      providerFactory,
      workerTools: buildWorkerToolset({ store, browser }),
      deliver: () => undefined,
      platform: 'linux',
      timeZone: 'UTC',
    })
    closers.push(() => store.close(), () => browser.dispose(), () => manager.stopAll())

    await manager.delegate([{ label: 'Three pages', brief: 'Read three pages.' }])
    await waitFor(async () => (await store.list('chat_item')).some((row) => row.kind === 'helper' && row.meta.includes('"state":"done"')), 20_000)
    // It really had three tabs of its own open at once...
    expect(browser.openedBy.filter((owner) => owner.startsWith('helper:'))).toHaveLength(3)
    expect(browser.peak).toBe(5)
    // ...and none are left once it ended.
    await waitFor(() => browser.open_.length === 2, 5_000)
    expect(browser.open_.sort()).toEqual(['his-tab', shown].sort())
  })

  it('a helper that fails still closes its tabs', async () => {
    const heard: Array<[string, number]> = []
    closers.push(onRunEnded((owner, grace) => heard.push([owner, grace])))
    fake = await startFakeAi(() => ({ status: 400, text: 'That request was refused.' }))
    const store = new Store(':memory:')
    const manager = new HelperManager({
      store,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      providerFactory,
      workerTools: buildWorkerToolset({ store }),
      deliver: () => undefined,
      platform: 'linux',
      timeZone: 'UTC',
    })
    closers.push(() => store.close(), () => manager.stopAll())
    await manager.delegate([{ label: 'Slow', brief: 'Take ages.' }])
    const row = await waitFor(async () => (await store.list('chat_item')).find((item) => item.kind === 'helper'), 5_000)
    await waitFor(() => heard.some(([owner]) => owner === `helper:${row.id}`), 10_000)
    expect((await store.get('chat_item', row.id))?.meta).toContain('"state":"failed"')
    expect(heard.find(([owner]) => owner === `helper:${row.id}`)?.[1]).toBe(0)
  })

  it('the main turn ends with an idle grace; a routine and a project chat end too', async () => {
    const heard: Array<[string, number]> = []
    closers.push(onRunEnded((owner, grace) => heard.push([owner, grace])))
    fake = await startFakeAi(() => ({ text: 'Done.' }))
    const store = new Store(':memory:')
    const runner = new Runner({
      store,
      settings: settingsView({ ...DEFAULT_SETTINGS, ...READY }),
      secrets: secretsView('test-key'),
      tools: buildToolset({ store }),
      providerFactory,
      isFocused: () => false,
      timeZone: 'UTC',
    })
    closers.push(() => store.close(), () => runner.dispose())
    await runner.send('Hello')
    expect(heard).toContainEqual(['main', MAIN_IDLE_MS])
    await runner.send('Hello project', [], 'pc-test')
    expect(heard).toContainEqual(['chat:pc-test', MAIN_IDLE_MS])
    const routine: TriggerRow = { id: 'r1', name: 'R', kind: 'daily', spec: '07:30', prompt: 'Go.', enabled: true, lastRunAt: null, lastResult: '', createdAt: 0 }
    await runner.runRoutine(routine)
    expect(heard).toContainEqual(['routine', 0])
  })
})

describe('browser_close and new_tab', () => {
  it('browser_close closes your tab, one by id, or all of yours', async () => {
    const calls: Array<[string | undefined, boolean | undefined]> = []
    const browser: BrowserDriver = { ...unavailableBrowser, closeOwnTab: async (id, all) => (calls.push([id, all]), 'Closed.') }
    const tool = toolNamed(browserTools({ browser }), 'browser_close')
    expect(await tool.run({}, testContext())).toBe('Closed.')
    await tool.run({ tab: 'tab-3' }, testContext())
    await tool.run({ all: true }, testContext())
    expect(calls).toEqual([[undefined, false], ['tab-3', false], [undefined, true]])
    // On every agent: the worker toolset (helpers, the MCP tool server's list) has it too.
    expect(buildWorkerToolset({ store: new Store(':memory:'), browser }).some((t) => t.spec.name === 'browser_close')).toBe(true)
  })

  it('browser_open new_tab opens a tab of your own beside the one you have', async () => {
    const opened: string[] = []
    const browser: BrowserDriver = { ...unavailableBrowser, open: async (u) => (opened.push(`same ${u}`), 'ok'), openNewTab: async (u) => (opened.push(`new ${u}`), 'ok') }
    const tool = toolNamed(browserTools({ browser }), 'browser_open')
    await tool.run({ url: 'example.com', new_tab: true }, testContext())
    await tool.run({ url: 'example.org' }, testContext())
    expect(opened).toEqual(['new https://example.com/', 'same https://example.org/'])
  })

  it('the headless browser closes a run\'s tab when it ends, after the grace for the main agent', async () => {
    vi.useFakeTimers()
    try {
      const browser = new HeadlessBrowser({ dir: '/tmp/none', executable: '/bin/false' })
      const tabs = (browser as unknown as { tabs: Map<string, unknown> }).tabs
      const tab = (id: string): unknown => ({ id, url: '', cdp: {}, socket: { detach: () => undefined, isAttached: () => true } })
      tabs.set('helper:h9', tab('x1'))
      tabs.set('main', tab('x2'))
      runEnded('helper:h9')
      expect(tabs.has('helper:h9')).toBe(false)
      runEnded('main', MAIN_IDLE_MS)
      expect(tabs.has('main')).toBe(true)
      vi.advanceTimersByTime(MAIN_IDLE_MS + 10)
      expect(tabs.has('main')).toBe(false)
      browser.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
