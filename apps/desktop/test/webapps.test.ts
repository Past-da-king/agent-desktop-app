import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runScript, syntaxError } from '../src/main/apps/page-js'
import { LearnedStore } from '../src/main/apps/store'
import { unavailableBrowser, type BrowserDriver } from '../src/main/browser/types'
import { browserRunner, webAppTools } from '../src/main/tools/webapps'
import { testContext, toolNamed } from './support'

/**
 * A fake of the agent's browser: it "opens" pages by remembering the address, and evaluates the
 * script text in a Node vm with a small page-like global, so tool bodies really run.
 */
function fakeBrowser(page: Record<string, unknown> = {}) {
  const opened: string[] = []
  let url = ''
  const browser: BrowserDriver = {
    ...unavailableBrowser,
    async open(next) {
      opened.push(next)
      url = next
      return `Opened ${next}`
    },
    currentUrl: () => url,
    hasPage: () => url !== '',
    async evaluate(code) {
      return runInNewContext(code, { location: { href: url }, ...page })
    },
  }
  return { browser, opened, setUrl: (next: string) => (url = next) }
}

const readTool = {
  name: 'front_page',
  description: 'The titles on the front page',
  params: { limit: { type: 'integer', description: 'How many' } },
  required: [],
  js: 'return titles.slice(0, args.limit || 2)',
  read_only: true,
}

const writeTool = {
  name: 'post_comment',
  description: 'Post a comment',
  params: { text: { type: 'string' } },
  required: ['text'],
  js: 'posted.push(args.text); return "posted"',
  read_only: false,
}

let dir = ''
let store: LearnedStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-webapps-'))
  store = new LearnedStore(join(dir, 'learned-apps.json'), () => 1234)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tools(page: Record<string, unknown> = {}) {
  const fake = fakeBrowser(page)
  return { fake, list: webAppTools(store, browserRunner(fake.browser)) }
}

async function saveExample(list: ReturnType<typeof tools>['list'], toolDefs: unknown[] = [readTool]): Promise<string> {
  return toolNamed(list, 'webapp_save').run(
    { name: 'News Site', start_url: 'news.example.com', about: 'Public front page', tools: toolDefs as never },
    testContext({ approve: async () => true }),
  )
}

describe('page scripts', () => {
  it('a run resolves with ok and the value, or ok false and the message', async () => {
    expect(await runInNewContext(runScript('return args.a + 1', { a: 1 }), {})).toEqual({ ok: true, v: 2 })
    expect(await runInNewContext(runScript('throw new Error("not signed in")', {}), {})).toEqual({ ok: false, e: 'not signed in' })
  })

  it('checks syntax without running anything', () => {
    expect(syntaxError('return 1')).toBe('')
    expect(syntaxError('return (')).not.toBe('')
    expect(syntaxError('globalThis.ran = true; return 1')).toBe('')
    expect((globalThis as Record<string, unknown>)['ran']).toBeUndefined()
  })
})

describe('learning a site', () => {
  it('saves only after the person approves, as JSON under userData', async () => {
    const { list } = tools()
    const declined = await toolNamed(list, 'webapp_save').run(
      { name: 'News Site', start_url: 'https://news.example.com', tools: [readTool] as never },
      testContext({ approve: async () => false }),
    )
    expect(declined).toContain('Not saved')
    expect(store.apps()).toHaveLength(0)
    expect(await saveExample(list)).toContain('Saved News Site with 1 tool')
    const saved = JSON.parse(readFileSync(join(dir, 'learned-apps.json'), 'utf8')) as Array<{ id: string; startUrl: string }>
    expect(saved[0]).toMatchObject({ id: 'news_site', startUrl: 'https://news.example.com' })
  })

  it('refuses bad tool names, empty bodies, code that does not parse and private addresses', async () => {
    const { list } = tools()
    const save = toolNamed(list, 'webapp_save')
    const ctx = testContext({ approve: async () => true })
    expect(await save.run({ name: 'X site', start_url: 'https://x.example.com', tools: [{ ...readTool, name: 'Bad Name' }] as never }, ctx)).toContain('must be lower-case')
    expect(await save.run({ name: 'X site', start_url: 'https://x.example.com', tools: [{ ...readTool, js: '' }] as never }, ctx)).toContain('empty')
    expect(await save.run({ name: 'X site', start_url: 'https://x.example.com', tools: [{ ...readTool, js: 'return (' }] as never }, ctx)).toContain('does not parse')
    expect(await save.run({ name: 'X site', start_url: 'http://127.0.0.1:8080', tools: [readTool] as never }, ctx)).toContain('public https')
    expect(store.apps()).toHaveLength(0)
  })

  it('saving again replaces the tools but keeps the trust the person gave', async () => {
    const { list } = tools()
    await saveExample(list)
    store.setTrusted('news_site', true)
    await saveExample(list, [readTool, writeTool])
    const app = store.find('News Site')
    expect(app?.tools.map((t) => t.name)).toEqual(['front_page', 'post_comment'])
    expect(app?.trusted).toBe(true)
  })
})

describe('running saved tools', () => {
  it('opens the site when the browser is elsewhere, then runs the read-only tool without asking', async () => {
    const { list, fake } = tools({ titles: ['One', 'Two', 'Three'] })
    await saveExample(list)
    let asked = 0
    const out = await toolNamed(list, 'webapp_run').run(
      { app: 'News Site', tool: 'front_page', args: { limit: 3 } },
      testContext({ approve: async () => ((asked += 1), true) }),
    )
    expect(out).toBe('["One","Two","Three"]')
    expect(fake.opened).toEqual(['https://news.example.com'])
    expect(asked).toBe(0)
  })

  it('does not reopen the site when the browser is already on it', async () => {
    const { list, fake } = tools({ titles: ['One'] })
    await saveExample(list)
    fake.setUrl('https://www.news.example.com/item?id=1')
    await toolNamed(list, 'webapp_run').run({ app: 'news_site', tool: 'front_page' }, testContext())
    expect(fake.opened).toEqual([])
  })

  it('a tool that changes things asks first, and a no means it never runs', async () => {
    const posted: string[] = []
    const { list } = tools({ posted })
    await saveExample(list, [writeTool])
    const run = toolNamed(list, 'webapp_run')
    const no = await run.run({ app: 'News Site', tool: 'post_comment', args: { text: 'hi' } }, testContext({ approve: async () => false }))
    expect(no).toContain('DECLINED')
    expect(posted).toEqual([])
    const yes = await run.run({ app: 'News Site', tool: 'post_comment', args: { text: 'hi' } }, testContext({ approve: async () => true }))
    expect(yes).toBe('posted')
    expect(posted).toEqual(['hi'])
  })

  it('a trusted app runs its changes without asking; missing inputs are caught first', async () => {
    const posted: string[] = []
    const { list } = tools({ posted })
    await saveExample(list, [writeTool])
    store.setTrusted('news_site', true)
    const run = toolNamed(list, 'webapp_test')
    expect(await run.run({ app: 'News Site', tool: 'post_comment', args: '{}' }, testContext())).toBe('Missing input: text.')
    expect(await run.run({ app: 'News Site', tool: 'post_comment', args: '{"text":"ok"}' }, testContext({ approve: async () => false }))).toBe('posted')
  })

  it('a page error comes back as a plain error, and webapp_list says what each tool does', async () => {
    const { list } = tools({})
    await saveExample(list)
    const out = await toolNamed(list, 'webapp_run').run({ app: 'News Site', tool: 'front_page' }, testContext())
    expect(out.startsWith('Error:')).toBe(true)
    const listed = await toolNamed(list, 'webapp_list').run({}, testContext())
    expect(listed).toContain('front_page [reads]: The titles on the front page')
  })

  it('removing asks first', async () => {
    const { list } = tools()
    await saveExample(list)
    expect(await toolNamed(list, 'webapp_remove').run({ app: 'News Site' }, testContext({ approve: async () => false }))).toContain('Keep it')
    expect(store.apps()).toHaveLength(1)
    expect(await toolNamed(list, 'webapp_remove').run({ app: 'News Site' }, testContext({ approve: async () => true }))).toBe('Removed News Site.')
    expect(store.apps()).toHaveLength(0)
  })

  it('browser_eval runs in the page and browser_network says when it is not watching', async () => {
    const { list, fake } = tools({ document: { title: 'Front page' }, window: {} })
    fake.setUrl('https://news.example.com')
    expect(await toolNamed(list, 'browser_eval').run({ js: 'return document.title' }, testContext())).toBe('Front page')
    expect(await toolNamed(list, 'browser_network').run({ action: 'log' }, testContext())).toContain('Not watching')
  })
})
