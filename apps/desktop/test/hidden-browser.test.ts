/**
 * Agent browser tabs work with the panel hidden (25 Oct 2026). A helper sat for minutes in browser_wait_for on a page
 * that had stopped answering (the window minimised, the panel hidden), and screenshots said "Is a page open?" while
 * one was. Checked here:
 *   - every browser tool ends by its own limit, whatever the page does (a driver that never answers);
 *   - browser_wait_for's answer says what the page showed; a screenshot failure says truthfully why;
 *   - the app keeps background pages awake (switches before ready, the host window never throttled);
 *   - the quiet heads-up names the tool the helper is stuck in, the site, and for how long.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { providerFor, schema, type JsonObject, type Settings, type Tool } from '@agent/core'

import { startFakeAi, type FakeReply } from '../../../packages/core/test/fake-ai'
import { sleep, waitFor } from '../../../packages/core/test/helpers'
import { PageTimeout, toolLimitMs, waitAnswer, withDeadline } from '../src/main/browser/deadline'
import { KEEP_AWAKE_DISABLED_FEATURES, KEEP_AWAKE_SWITCHES, keepPagesAwake } from '../src/main/browser/keep-awake'
import type { BrowserDriver, BrowserProDriver } from '../src/main/browser/types'
import { Store } from '../src/main/db'
import { HelperManager } from '../src/main/runtime/helpers'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { browserTools } from '../src/main/tools/browser'
import { browserProTools } from '../src/main/tools/browser-pro'
import { secretsView, settingsView, testContext, toolNamed } from './support'

const never = <T>(): Promise<T> => new Promise<T>(() => undefined)

/** A browser whose page never answers anything: the hidden, starved page of the bug. */
class SilentBrowser implements BrowserDriver, BrowserProDriver {
  problem = ''
  open = (): Promise<string> => never()
  snapshot = (): Promise<string> => never()
  read = (): Promise<string> => never()
  click = (): Promise<string> => never()
  type = (): Promise<string> => never()
  press = (): Promise<string> => never()
  scroll = (): Promise<string> => never()
  waitFor = (): Promise<string> => never()
  back = (): Promise<string> => never()
  screenshot = (): Promise<string | null> => never()
  upload = (): Promise<string> => never()
  setAgentDriving(): void {}
  hasPage(): boolean {
    return true
  }
  view = (): Promise<string> => never()
  fix = (): Promise<string> => never()
  snapshotPro = (): Promise<string> => never()
  act = (): Promise<string> => never()
  evaluate = (): Promise<string> => never()
}

afterEach(() => {
  vi.useRealTimers()
})

/** Runs a tool against fake time and returns what it answered, or 'STILL WAITING' if it never did. */
async function runFor(tool: Tool, input: JsonObject, ms: number): Promise<string> {
  let answer: string | null = null
  void tool.run(input, testContext()).then((value) => {
    answer = value
  })
  await vi.advanceTimersByTimeAsync(ms)
  return answer ?? 'STILL WAITING'
}

describe('every browser tool ends, whatever the page does', () => {
  it('browser_wait_for ends at its own limit on a page that never answers (default 15 s, at most 30 s)', async () => {
    vi.useFakeTimers()
    const wait = toolNamed(browserTools({ browser: new SilentBrowser() }), 'browser_wait_for')
    const answer = await runFor(wait, { text: 'Subscribe' }, 36_000)
    expect(answer).toContain('browser_wait_for stopped after')
    expect(answer).toContain('did not answer in time')
    // Asking for more than 30 s still ends by 30 s plus the grace.
    expect(await runFor(wait, { text: 'Subscribe', seconds: 900 }, 51_000)).toContain('stopped after 50 s')
  })

  it('every other browser tool also ends by a hard limit', async () => {
    vi.useFakeTimers()
    const silent = new SilentBrowser()
    const tools = [...browserTools({ browser: silent }), ...browserProTools({ browser: silent })]
    const inputs: Record<string, JsonObject> = {
      browser_open: { url: 'https://example.com' },
      browser_click: { index: 1 },
      browser_type: { index: 1, text: 'x' },
      browser_press_key: { key: 'Enter' },
      browser_act: { action: 'click', name: 'Go' },
      browser_eval: { js: 'return 1', seconds: 5 },
      browser_view: { mode: 'desktop' },
      browser_fix: { action: 'list' },
    }
    const names = ['browser_open', 'browser_look', 'browser_read', 'browser_click', 'browser_type', 'browser_press_key', 'browser_scroll', 'browser_back', 'browser_show_user', 'browser_snapshot', 'browser_act', 'browser_eval', 'browser_view', 'browser_fix']
    for (const name of names) {
      const tool = toolNamed(tools, name)
      const input = inputs[name] ?? {}
      const answer = await runFor(tool, input, toolLimitMs(name, input) + 1_000)
      expect(answer, name).not.toBe('STILL WAITING')
      expect(answer, name).toContain('did not answer in time')
    }
  })

  it('withDeadline rejects with PageTimeout, and passes a real answer straight through', async () => {
    vi.useFakeTimers()
    const late = withDeadline(never<string>(), 3_000)
    const caught = late.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(3_001)
    expect(await caught).toBeInstanceOf(PageTimeout)
    expect(await withDeadline(Promise.resolve('ok'), 3_000)).toBe('ok')
  })
})

describe('answers say what happened', () => {
  it("browser_wait_for's answer says what the page showed when the text never came", () => {
    const seen = { url: 'https://www.youtube.com/', title: 'YouTube', text: 'Home Shorts Subscriptions' }
    const missed = waitAnswer({ found: false }, { text: 'Create channel', selector: '' }, 15, seen)
    expect(missed).toContain('"Create channel" was not on the page after 15 s')
    expect(missed).toContain('URL: https://www.youtube.com/')
    expect(missed).toContain('Title: YouTube')
    expect(missed).toContain('Text: Home Shorts Subscriptions')
    const silent = waitAnswer({ found: false, timedOut: true }, { text: 'Create channel', selector: '' }, 15, null)
    expect(silent).toContain('did not answer within 15 s')
    expect(silent).toContain('The page did not answer when read')
    expect(waitAnswer({ found: true }, { text: '', selector: '#done' }, 15, seen)).toContain("It's there: #done found.")
  })

  it('a screenshot that fails says why, not "Is a page open?" while one is', async () => {
    const shy = new SilentBrowser()
    shy.screenshot = async () => null
    ;(shy as unknown as { screenshotProblem: () => string }).screenshotProblem = () => 'The page https://www.youtube.com/ is open but could not be drawn (the page capture did not answer in 6 s).'
    const tools = browserTools({ browser: shy })
    for (const name of ['browser_look', 'browser_show_user']) {
      const answer = await toolNamed(tools, name).run({}, testContext())
      expect(answer).not.toContain('Is a page open?')
      expect(answer).toContain('is open but could not be drawn')
    }
    // A driver with no reason of its own still tells an open page from no page.
    const plain = new SilentBrowser()
    plain.screenshot = async () => null
    expect(await toolNamed(browserTools({ browser: plain }), 'browser_look').run({}, testContext())).toContain('the page is open but could not be drawn')
  })
})

describe('background pages stay awake', () => {
  it('keepPagesAwake adds the switches and keeps features already disabled', () => {
    const switches = new Map<string, string>([['disable-features', 'SomethingElse']])
    keepPagesAwake({
      appendSwitch: (name, value) => switches.set(name, value ?? ''),
      hasSwitch: (name) => switches.has(name),
      getSwitchValue: (name) => switches.get(name) ?? '',
    })
    for (const name of KEEP_AWAKE_SWITCHES) expect(switches.has(name)).toBe(true)
    const disabled = (switches.get('disable-features') ?? '').split(',')
    expect(disabled).toContain('SomethingElse')
    for (const feature of KEEP_AWAKE_DISABLED_FEATURES) expect(disabled).toContain(feature)
    expect(KEEP_AWAKE_SWITCHES).toContain('disable-renderer-backgrounding')
    expect(KEEP_AWAKE_DISABLED_FEATURES).toContain('CalculateNativeWinOcclusion')
  })

  it('the app applies them before it is ready, and the window hosting the pages is never throttled', () => {
    const source = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    const applied = source.indexOf('keepPagesAwake(app.commandLine)')
    expect(applied).toBeGreaterThan(-1)
    expect(applied).toBeLessThan(source.indexOf('app.whenReady()'))
    const create = source.slice(source.indexOf('function createWindow('), source.indexOf('mainWindow = win'))
    expect(create).toContain('...HOST_WINDOW_PREFS')
    // The agent's pages themselves: embedded and offscreen both run unthrottled.
    expect(readFileSync(join(__dirname, '../src/main/browser/embed.ts'), 'utf8')).toContain('prefs.backgroundThrottling = false')
    const browser = readFileSync(join(__dirname, '../src/main/browser/browser.ts'), 'utf8')
    // A kept tab an agent picks up again runs at full speed again, embedded ones too.
    expect(browser).toMatch(/private wakeTab\(tab: Tab\): void \{\n\s+if \(!this\.idled\.delete\(tab\.id\)\) return\n/)
  })
})

// ---- the quiet heads-up names the stuck tool ----------------------------------------------------------------------

const READY: Partial<Settings> = { hasKey: true, mode: 'api_key', provider: 'openai', model: 'fake-model', allowHttp: true, notifications: false }

describe('the quiet heads-up names the tool a helper is stuck in', () => {
  it('"stuck in browser_wait_for on youtube.com for 11 min"', async () => {
    let clock = 7_000_000
    const waiting: Array<() => void> = []
    let started = 0
    const tools: Tool[] = [
      {
        spec: { name: 'browser_open', description: 'Open a page.', schema: schema(['url'], { url: { type: 'string' } }) },
        run: async () => 'URL: https://www.youtube.com/\nTitle: YouTube\n\nElements:',
      },
      {
        spec: { name: 'browser_wait_for', description: 'Wait for text.', schema: schema([], { text: { type: 'string' } }) },
        run: (_input, ctx) =>
          new Promise<string>((resolve) => {
            started += 1
            waiting.push(() => resolve('done'))
            ctx.signal.addEventListener('abort', () => resolve('cut off'), { once: true })
          }),
      },
    ]
    let turn = 0
    const fake = await startFakeAi((body): FakeReply => {
      if (!JSON.stringify(body).includes('You are a HELPER')) return { text: 'ok' }
      turn += 1
      return turn === 1 ? { toolCalls: [{ name: 'browser_open', input: { url: 'https://www.youtube.com' } }] } : { toolCalls: [{ name: 'browser_wait_for', input: { text: 'Create channel' } }] }
    })
    const db = new Store(':memory:')
    const delivered: string[] = []
    const manager = new HelperManager({
      store: db,
      settings: settingsView(READY),
      secrets: secretsView('test-key'),
      providerFactory: () => providerFor({ provider: 'openai', key: 'test-key', baseUrl: fake.url, allowHttp: true }),
      workerTools: [...buildWorkerToolset({ store: db }), ...tools],
      deliver: (note) => {
        delivered.push(note)
      },
      platform: 'linux',
      timeZone: 'UTC',
      now: () => clock,
      quietMinutes: 10,
    })
    try {
      await manager.delegate([{ label: 'Social accounts', brief: 'Open YouTube and wait for the channel button.' }])
      await waitFor(() => started > 0, 8_000)
      clock += 11 * 60_000
      expect(await manager.checkQuiet()).toBe(1)
      expect(delivered).toHaveLength(1)
      expect(delivered[0]).toContain('"Social accounts" has taken no new step for 11 min, stuck in browser_wait_for on youtube.com for 11 min.')
    } finally {
      for (const go of waiting.splice(0)) go()
      await manager.stopAll()
      await sleep(20)
      manager.shutdown()
      await fake.close()
      db.close()
    }
  })
})
