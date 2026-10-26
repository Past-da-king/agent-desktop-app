/**
 * What a guided session leaves behind (26 Oct 2026): the requests each step's click sent (guide-log.ts), readable by a
 * watcher while he clicks; and a learned app made from them (guide-app.ts) that does the task by API next time with
 * no secret saved in its code, reads Authorization / CSRF fresh from the signed-in page at run time, and, when the
 * site refuses the replay as a bot, fails with the guided steps to fall back to. Plus the tools and the prompt.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { chromium, type Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS } from '@agent/core'

import { runScript } from '../src/main/apps/page-js'
import { LearnedStore } from '../src/main/apps/store'
import { toolLimitMs, guardBrowserTool } from '../src/main/browser/deadline'
import type { NetEntry } from '../src/main/browser/devtools-log'
import { guideShowsFullSize, type GuideResult, type StepLog } from '../src/main/browser/guide'
import { appFromSession, secretValues } from '../src/main/browser/guide-app'
import { assignRequests, formatLog, GuideLog, redactBody, type CapturedRequest } from '../src/main/browser/guide-log'
import type { GuideRequest } from '../src/main/browser/types'
import { buildSystemPrompt, GUIDED_MODE } from '../src/main/runtime/prompt'
import { buildWorkerToolset } from '../src/main/runtime/toolset'
import { browserGuideTools, stepOf } from '../src/main/tools/browser-guide'
import { Store } from '../src/main/db'
import { testContext } from './support'

const SESSION = 'sid-SESSIONSECRET-4471'
const OLD_CSRF = 'csrf-CAPTUREDTOKEN-9931'
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.CAPTUREDBEARER.x81'

function entry(id: string, over: Partial<NetEntry>): NetEntry {
  return {
    id,
    requestId: id,
    url: 'https://shop.example.com/api/thing',
    method: 'GET',
    type: 'Fetch',
    wallTime: 0,
    requestHeaders: {},
    rawRequestHeaders: true,
    postData: null,
    hasPostData: false,
    status: 200,
    statusText: 'OK',
    mimeType: 'application/json',
    responseHeaders: {},
    rawResponseHeaders: true,
    remoteAddress: '',
    fromCache: false,
    fromServiceWorker: false,
    encodedBytes: 10,
    finished: true,
    failed: '',
    redirectedTo: '',
    initiator: '',
    timing: { start: null, end: null, dnsMs: null, connectMs: null, sslMs: null, waitMs: null, downloadMs: null, headersAt: null },
    body: { text: '{"ok":true}', base64: false },
    ...over,
  }
}

function log(n: number, at: number, over: Partial<StepLog> = {}): StepLog {
  return { n, label: `Step ${n}`, outcome: 'clicked', target: '', role: 'button', name: `Button ${n}`, frame: '', foundMs: 10, waitedMs: 100, returnMs: 20, at, url: '', ...over }
}

describe('the step log: each step owns the requests its click sent', () => {
  it('assigns API calls and form posts to the step whose action came just before them, ignores page loads and earlier calls', () => {
    const logs = [log(1, 1000), log(2, 2000, { outcome: 'typed', name: 'Pixel name', role: 'textbox', value: 'Shop pixel' }), log(3, 3000)]
    const rows = [
      entry('r1', { wallTime: 500 }), // before his first action: not his
      entry('r2', { wallTime: 1010, url: 'https://shop.example.com/api/list' }),
      entry('r3', { wallTime: 1020, type: 'Script', url: 'https://shop.example.com/app.js' }), // not an API call
      entry('r4', { wallTime: 3050, method: 'POST', url: 'https://shop.example.com/api/pixels', postData: '{"name":"Shop pixel"}' }),
      entry('r5', { wallTime: 3100, method: 'POST', type: 'Document', url: 'https://shop.example.com/form' }), // a form post
      entry('r6', { wallTime: 9000 }), // long after the end
    ]
    const got = assignRequests(logs, rows, 3500)
    expect(got.map((r) => [r.id, r.step])).toEqual([
      ['r2', 1],
      ['r4', 3],
      ['r5', 3],
    ])
  })

  it('wakes a waiting watcher the moment the next step ends, and masks secrets in what it shows', async () => {
    const guides = new GuideLog()
    const rows: NetEntry[] = []
    const session = guides.start({ owner: 'main', tabId: 'tab-1', url: 'https://shop.example.com/', steps: [{ label: 'Click Save', target: { name: 'Save' } }], network: () => rows })
    const started = Date.now()
    const waiting = guides.waitFor('latest', 0, 5000)
    setTimeout(() => {
      rows.push(entry('r9', { wallTime: Date.now() + 5, method: 'POST', url: 'https://shop.example.com/api/save', requestHeaders: { 'X-CSRF-Token': OLD_CSRF, Cookie: `sid=${SESSION}`, 'Content-Type': 'application/json' }, postData: `{"name":"A","csrf":"${OLD_CSRF}"}` }))
      guides.stepEnded(session.id, log(1, Date.now()))
    }, 150)
    await waiting
    expect(Date.now() - started).toBeLessThan(1500)
    await new Promise((r) => setTimeout(r, 20))
    const text = formatLog(guides.get(session.id)!, guides.requests(session.id))
    expect(text).toContain('Step 1. Step 1: clicked')
    expect(text).toContain('POST https://shop.example.com/api/save')
    expect(text).not.toContain(OLD_CSRF)
    expect(text).not.toContain(SESSION)
    expect(redactBody(`csrf_token=${OLD_CSRF}&name=A`)).toBe('csrf_token=[secret]&name=A')
  })
})

/** A session as the guide leaves it: he typed a name and clicked Save, which posted with a cookie, CSRF and a bearer. */
function capturedSession(origin: string): { guides: GuideLog; id: string; requests: CapturedRequest[] } {
  const guides = new GuideLog()
  const rows: NetEntry[] = []
  const session = guides.start({
    owner: 'main',
    tabId: 'tab-1',
    url: `${origin}/app`,
    steps: [
      { label: 'Type the pixel name', target: { name: 'Pixel name', role: 'textbox' } },
      { label: 'Click Save', target: { name: 'Save', role: 'button' } },
    ],
    network: () => rows,
  })
  guides.stepEnded(session.id, log(1, 1000, { outcome: 'typed', name: 'Pixel name', role: 'textbox', label: 'Type the pixel name', value: 'Shop pixel' }))
  guides.stepEnded(session.id, log(2, 2000, { name: 'Save', label: 'Click Save' }))
  rows.push(
    entry('r1', {
      wallTime: 2010,
      method: 'POST',
      url: `${origin}/api/pixels?access_token=${BEARER}&mode=fast`,
      requestHeaders: { 'Content-Type': 'application/json', 'X-CSRF-Token': OLD_CSRF, Authorization: `Bearer ${BEARER}`, Cookie: `sid=${SESSION}; theme=dark`, Accept: 'application/json', 'User-Agent': 'Chrome' },
      postData: JSON.stringify({ name: 'Shop pixel', csrf: OLD_CSRF, kind: 'web' }),
    }),
  )
  const result: GuideResult = { outcome: 'clicked', completed: 2, total: 2, steps: guides.get(session.id)!.logs, url: `${origin}/app`, title: 'App', dialogs: [], jsDialog: '', text: '', note: '' }
  guides.end(session.id, result)
  return { guides, id: session.id, requests: guides.requests(session.id) }
}

describe('a guided session becomes a learned app with no secret in it', () => {
  it('strips Authorization, Cookie, CSRF and tokens from the code, and makes what he typed an input', () => {
    const { guides, id, requests } = capturedSession('https://shop.example.com')
    expect(requests).toHaveLength(1)
    const draft = appFromSession(guides.get(id)!, requests, { toolName: 'create_pixel', description: 'Create a pixel' })
    expect(draft.problem).toBeNull()
    for (const secret of [SESSION, OLD_CSRF, BEARER, ...secretValues(requests)]) expect(draft.tool.js).not.toContain(secret)
    expect(draft.tool.js).not.toMatch(/Cookie|User-Agent/)
    expect(draft.fresh).toEqual(expect.arrayContaining(['X-CSRF-Token', 'Authorization', 'csrf', 'access_token']))
    expect(Object.keys(draft.tool.params)).toEqual(['pixel_name'])
    expect(draft.tool.readOnly).toBe(false)
    expect(draft.startUrl).toBe('https://shop.example.com/')
    expect(draft.fallback.map((s) => s.label)).toEqual(['Type the pixel name', 'Click Save'])
  })

  it('refuses to save when a secret would end up in the code', () => {
    const { guides, id, requests } = capturedSession('https://shop.example.com')
    // A token in a field with an innocent name still gets caught by the value check.
    const sneaky = requests.map((r) => ({ ...r, postData: JSON.stringify({ name: 'Shop pixel', note: SESSION }) }))
    const draft = appFromSession(guides.get(id)!, sneaky, { toolName: 'create_pixel', description: 'Create a pixel' })
    expect(draft.problem).toContain('secret')
  })

  it('says so when nothing was captured', () => {
    const guides = new GuideLog()
    const session = guides.start({ owner: 'main', tabId: 't', url: 'https://x.example.com/', steps: [] })
    expect(appFromSession(session, [], { toolName: 'x_y', description: 'x' }).problem).toContain('no API request')
  })
})

function findChrome(): string | null {
  const env = process.env.CHROME_PATH
  if (env !== undefined && env !== '' && existsSync(env)) return env
  const base = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(base)) return null
  for (const dir of readdirSync(base).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
    const path = join(base, dir, 'chrome-linux64/chrome')
    if (existsSync(path)) return path
  }
  return null
}
const chrome = findChrome()

;(chrome === null ? describe.skip : describe)('the learned tool replays the task by API in a real page', () => {
  let browser: Browser
  let server: Server
  let origin = ''
  let bot = false
  const seen: Array<{ csrf: string; auth: string; cookie: string; body: string; url: string }> = []
  let token = ''

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = req.url ?? '/'
      if (url === '/app') {
        // Every load hands out a new CSRF token and bearer: the tool must read them fresh, never reuse the captured ones.
        token = `fresh-${Math.random().toString(36).slice(2, 10)}`
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `sid=${SESSION}; HttpOnly; Path=/` })
        res.end(`<!doctype html><meta name="csrf-token" content="${token}"><script>localStorage.setItem('auth_token', '${token}-bearer')</script><h1>App</h1>`)
        return
      }
      if (url.startsWith('/api/pixels') && req.method === 'POST') {
        let body = ''
        req.on('data', (d) => (body += d))
        req.on('end', () => {
          seen.push({ csrf: String(req.headers['x-csrf-token'] ?? ''), auth: String(req.headers['authorization'] ?? ''), cookie: String(req.headers['cookie'] ?? ''), body, url })
          if (bot) {
            res.writeHead(403, { 'content-type': 'text/plain' })
            res.end('Forbidden: bot detected')
            return
          }
          const parsed = JSON.parse(body) as { name: string; csrf: string }
          const okCsrf = req.headers['x-csrf-token'] === token && parsed.csrf === token && req.headers['authorization'] === `Bearer ${token}-bearer`
          const okSession = String(req.headers['cookie'] ?? '').includes(`sid=${SESSION}`)
          res.writeHead(okCsrf && okSession ? 200 : 401, { 'content-type': 'application/json' })
          res.end(JSON.stringify(okCsrf && okSession ? { id: 7, name: parsed.name } : { error: 'bad token' }))
        })
        return
      }
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox'] })
  })

  afterAll(async () => {
    await browser?.close()
    server?.close()
  })

  it('creates the thing with a new input, reading the session cookie, CSRF and bearer fresh; a 403 bot answer falls back to guided steps', async () => {
    const { guides, id, requests } = capturedSession(origin)
    const draft = appFromSession(guides.get(id)!, requests, { toolName: 'create_pixel', description: 'Create a pixel' })
    expect(draft.problem).toBeNull()
    const page = await browser.newPage()
    await page.goto(`${origin}/app`)
    const out = (await page.evaluate(runScript(draft.tool.js, { pixel_name: 'Second pixel' }))) as { ok: boolean; v?: { status: number; data: { id: number; name: string } }; e?: string }
    expect(out.e ?? '').toBe('')
    expect(out.ok).toBe(true)
    expect(out.v?.data).toEqual({ id: 7, name: 'Second pixel' })
    const sent = seen[seen.length - 1]!
    expect(sent.csrf).toBe(token)
    expect(sent.auth).toBe(`Bearer ${token}-bearer`)
    expect(sent.cookie).toContain(SESSION)
    expect(sent.url).not.toContain(BEARER)
    expect(sent.body).not.toContain(OLD_CSRF)

    bot = true
    const refused = (await page.evaluate(runScript(draft.tool.js, { pixel_name: 'Third' }))) as { ok: boolean; e?: string }
    expect(refused.ok).toBe(false)
    expect(refused.e).toContain('bot check')
    expect(refused.e).toContain('browser_guide')
    expect(refused.e).toContain('Click Save')
    bot = false
    await page.close()
  })
})

describe('the guide tools and the prompt', () => {
  it('shows the guide where he can see it: the panel when it shows this tab, else the page full size over the window', () => {
    expect(guideShowsFullSize({ panelVisible: true, panelWidth: 420, shownTab: 'tab-2', expanded: false }, 'tab-2')).toBe(false)
    expect(guideShowsFullSize({ panelVisible: false, panelWidth: 0, shownTab: 'tab-2', expanded: false }, 'tab-2')).toBe(true)
    expect(guideShowsFullSize({ panelVisible: true, panelWidth: 420, shownTab: 'tab-1', expanded: false }, 'tab-2')).toBe(true)
    expect(guideShowsFullSize({ panelVisible: false, panelWidth: 0, shownTab: 'tab-1', expanded: true }, 'tab-2')).toBe(false)
  })

  it('the browser hands the tab to him for the guide and ends it on run end, tab close and Done (source wiring)', () => {
    const source = readFileSync(join(__dirname, '../src/main/browser/browser.ts'), 'utf8')
    expect(source).toContain('this.guiding.endOwner(owner)')
    expect(source).toContain("this.guiding.endTab(tab.id, 'closed')")
    expect(source).toContain("if (on) this.guiding.endAll('person')")
    expect(source).toMatch(/enterGuide[\s\S]*this\.personTab = tab\.id/)
  })

  it('reads steps the way browser_act reads a target', () => {
    expect(stepOf({ label: 'Click Create Pixel', name: 'Create Pixel', role: 'button', nth: 2 })).toEqual({ label: 'Click Create Pixel', target: { name: 'Create Pixel', role: 'button', nth: 2 } })
    expect(stepOf({ index: '4' })).toEqual({ label: 'Use this', target: { index: 4 } })
    expect(stepOf({ label: 'x' })).toContain('say which element')
  })

  it('passes a steps chain to the browser and the abort signal with it; says so when no person can see a browser here', async () => {
    let got: GuideRequest | null = null
    const driver = {
      guide: async (request: GuideRequest, signal?: AbortSignal) => {
        got = request
        return `outcome: clicked ${signal === undefined ? 'no signal' : 'signal'}`
      },
      guideLog: () => new GuideLog(),
    }
    const [guide] = browserGuideTools({ browser: driver })
    const answer = await guide!.run({ steps: [{ label: 'Click A', name: 'A' }, { label: 'Click B', selector: '#b' }], timeout_seconds: 30 }, testContext({ signal: new AbortController().signal }))
    expect(answer).toBe('outcome: clicked signal')
    expect(got!.steps).toHaveLength(2)
    expect(got!.timeoutMs).toBe(30_000)
    const [none] = browserGuideTools({ browser: {} })
    expect(await none!.run({ name: 'A' }, testContext())).toContain('this device has none')
    // It waits on the person, so the browser tools' 60 s limit never cuts it off.
    expect(guardBrowserTool(guide!)).toBe(guide)
    expect(toolLimitMs('browser_guide')).toBeGreaterThan(0)
  })

  it('browser_guide_save_app saves the session as a learned app with no secret in it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'guide-app-'))
    try {
      const store = new LearnedStore(join(dir, 'learned.json'))
      const { guides } = capturedSession('https://shop.example.com')
      const tools = browserGuideTools({ browser: { guide: async () => '', guideLog: () => guides }, learned: store })
      const save = tools.find((t) => t.spec.name === 'browser_guide_save_app')!
      const answer = await save.run({ app_name: 'Shop', tool_name: 'create_pixel', description: 'Create a pixel' }, testContext())
      expect(answer).toContain('Saved create_pixel in Shop')
      const app = store.find('Shop')!
      expect(app.startUrl).toBe('https://shop.example.com/')
      const saved = JSON.stringify(app)
      for (const secret of [SESSION, OLD_CSRF, BEARER]) expect(saved).not.toContain(secret)
      expect(app.tools[0]?.params).toHaveProperty('pixel_name')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('every agent with browser tools gets them and the GUIDED MODE section, API first', () => {
    const store = new Store(':memory:')
    const names = buildWorkerToolset({ store }).map((tool) => tool.spec.name)
    expect(names).toEqual(expect.arrayContaining(['browser_guide', 'browser_guide_log']))
    for (const role of ['main', 'helper', 'routine'] as const) {
      const prompt = buildSystemPrompt({ settings: DEFAULT_SETTINGS, now: new Date('2026-10-26T10:00:00Z'), platform: 'win32', memories: [], goals: [], tasks: [], latestUserText: '', role, timeZone: 'UTC', promptRules: [] })
      expect(prompt).toContain('GUIDED MODE')
      expect(prompt).toContain('browser_guide')
      const section = prompt.slice(prompt.indexOf('GUIDED MODE'))
      expect(section.indexOf('API first')).toBeLessThan(section.indexOf('Use browser_guide'))
    }
    expect(GUIDED_MODE.join(' ')).not.toMatch(/facebook|meta pixel/i)
  })
})
