/**
 * The developer tools against a real Chromium: a Playwright CDP session stands in for Electron's
 * webContents.debugger, and a local server serves a page that calls its API, logs and throws.
 */
import { existsSync, readdirSync } from 'node:fs'
import http from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEVTOOLS_EVENTS, TabDevtools, type DevtoolsChannel } from '../src/main/browser/devtools'
import { browserDevtoolsTools } from '../src/main/tools/browser-devtools'
import { testContext, toolNamed } from './support'

function findChrome(): string | null {
  const env = process.env.CHROME_PATH
  if (env !== undefined && env !== '' && existsSync(env)) return env
  const base = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(base)) return null
  const dirs = readdirSync(base)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse()
  for (const dir of dirs) {
    const path = join(base, dir, 'chrome-linux64/chrome')
    if (existsSync(path)) return path
  }
  return null
}

export const DEVTOOLS_FIXTURE = `<!doctype html>
<html><head><title>Shop</title></head>
<body>
  <h1>Shop</h1>
  <button id="buy" class="primary" style="color: rgb(255, 255, 255); background-color: rgb(20, 90, 50)">Buy now</button>
  <div class="card" hidden>Secret card</div>
  <div class="card">Visible card</div>
  <img src="/pixel.png" alt="">
  <script>
    localStorage.setItem('theme', 'dark');
    sessionStorage.setItem('step', '2');
    document.cookie = 'seen=yes; path=/';
    console.log('page ready', { items: 3, user: 'ann' });
    console.warn('stock is low');
    fetch('/api/items?q=shoes').then((r) => r.json()).then((d) => console.info('items', d.items.length));
    const x = new XMLHttpRequest();
    x.open('POST', '/api/login');
    x.setRequestHeader('content-type', 'application/json');
    x.send(JSON.stringify({ user: 'ann', remember: true }));
    fetch('/api/missing');
    setTimeout(() => { throw new Error('checkout exploded'); }, 50);
    Promise.reject(new Error('promise said no'));
  </script>
</body></html>`

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

export function devtoolsFixtureServer(): http.Server {
  return http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (url.pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'sid=s3cr3t-session; HttpOnly; Path=/; SameSite=Lax' })
      response.end(DEVTOOLS_FIXTURE)
      return
    }
    if (url.pathname === '/api/items') {
      const signedIn = (request.headers.cookie ?? '').includes('sid=s3cr3t-session')
      response.writeHead(200, { 'content-type': 'application/json', 'x-api-version': '7' })
      response.end(JSON.stringify({ q: url.searchParams.get('q'), signedIn, items: [{ id: 1, name: 'Red shoes' }, { id: 2, name: 'Blue shoes' }, { id: 3, name: 'Boots' }], notes: 'n'.repeat(400) }))
      return
    }
    if (url.pathname === '/api/login' && request.method === 'POST') {
      let body = ''
      request.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, echo: JSON.parse(body || '{}') as unknown, method: request.method }))
      })
      return
    }
    if (url.pathname === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' })
      response.end(PIXEL)
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end('{"error":"not found"}')
  })
}

/** Playwright's CDP session, shaped like the Electron debugger channel. */
function playwrightChannel(session: CDPSession, page: Page): DevtoolsChannel {
  return {
    send: async (method, params) => (await session.send(method as 'Runtime.evaluate', params as never)) as unknown,
    onEvent: (listener) => {
      for (const name of DEVTOOLS_EVENTS) session.on(name, (params: unknown) => listener(name, params))
    },
    onDetach: () => undefined,
    url: () => page.url(),
  }
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const chrome = findChrome()
const suite = chrome === null ? describe.skip : describe

suite('browser developer tools in a real Chromium', () => {
  let browser: Browser
  let server: http.Server
  let base = ''
  let page: Page
  let tab: TabDevtools
  const run = async (name: string, input: Record<string, unknown> = {}): Promise<string> =>
    toolNamed(browserDevtoolsTools({ devtools: async () => tab }), name).run(input as never, testContext())

  beforeAll(async () => {
    server = devtoolsFixtureServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no server address')
    base = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox'] })
    page = await browser.newPage()
    const session = await page.context().newCDPSession(page)
    tab = new TabDevtools(playwrightChannel(session, page))
    expect(await tab.start()).toBe(true)
    // Recording starts before the page loads, as it does for a new tab in the app.
    await page.goto(`${base}/`)
    await until(() => tab.console.all().some((e) => e.text.includes('promise said no')) && tab.console.all().some((e) => e.text.includes('checkout exploded')))
    await until(() => tab.network.all().filter((e) => e.url.includes('/api/')).every((e) => e.finished) && tab.network.all().filter((e) => e.url.includes('/api/')).length === 3)
  }, 30_000)

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  it('lists the page and its API calls, filtered', async () => {
    const all = await run('browser_network')
    expect(all).toContain(`GET 200 document text/html`)
    expect(all).toContain(`GET 200 image image/png`)
    const api = await run('browser_network', { api: true })
    expect(api).toContain(`fetch application/json`)
    expect(api).toContain(`${base}/api/items?q=shoes`)
    expect(api).toContain(`POST 200 xhr application/json`)
    expect(api).not.toContain('pixel.png')
    expect(await run('browser_network', { status: '4xx' })).toContain(`GET 404 fetch application/json`)
    expect(await run('browser_network', { status: 'nonsense' })).toContain('status is a code')
  })

  it('shows one request in full: headers, request body, response body', async () => {
    const login = tab.network.all().find((e) => e.url.endsWith('/api/login'))!
    const out = await run('browser_network_get', { id: login.id })
    expect(out).toContain(`${login.id} POST ${base}/api/login`)
    expect(out).toContain('Request body (31 characters):\n{"user":"ann","remember":true}'.replace('31', String('{"user":"ann","remember":true}'.length)))
    expect(out).toContain('content-type: application/json')
    expect(out).toContain('"echo":{"user":"ann","remember":true}')
    // The real headers the browser sent, cookies included.
    expect(out.toLowerCase()).toContain('cookie: sid=s3cr3t-session')
    const items = tab.network.all().find((e) => e.url.includes('/api/items'))!
    const body = await run('browser_network_get', { id: items.id, max: 200 })
    expect(body).toContain('x-api-version: 7')
    expect(body).toContain('{"q":"shoes","signedIn":true,"items":[{')
    expect(body).toContain('[cut: ')
    const pixel = tab.network.all().find((e) => e.url.endsWith('/pixel.png'))!
    expect(await run('browser_network_get', { id: pixel.id })).toContain('Response body (binary, 70 characters):\n[binary image/png, 70 B')
    expect(await run('browser_network_get', { id: 'r999' })).toContain('No recorded request r999')
  })

  it('replays a recorded API call from inside the page, and sends a new one', async () => {
    const items = tab.network.all().find((e) => e.url.includes('/api/items'))!
    const replay = await run('browser_fetch', { from: items.id })
    expect(replay).toContain(`GET ${base}/api/items?q=shoes`)
    expect(replay).toContain('200 OK')
    expect(replay).toContain('"signedIn":true')
    const post = await run('browser_fetch', { url: '/api/login', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"user":"bea"}' })
    expect(post).toContain('"echo":{"user":"bea"}')
    expect(await run('browser_fetch', { url: 'file:///etc/passwd' })).toContain('Only http and https')
    // The replay itself is recorded too.
    await until(() => tab.network.all().filter((e) => e.url.includes('/api/login')).length === 2)
  })

  it('lists console messages and uncaught errors with a level filter', async () => {
    const all = await run('browser_console')
    expect(all).toContain('[log] ')
    expect(all).toContain('page ready {items: 3, user: "ann"}')
    expect(all).toContain('[warning] ')
    expect(all).toContain('items 3')
    const errors = await run('browser_console', { level: 'error' })
    expect(errors).toContain('[uncaught] ')
    expect(errors).toContain('Uncaught Error: checkout exploded')
    expect(errors).toContain('Uncaught (in promise) Error: promise said no')
    expect(errors).toContain('404')
    expect(errors).not.toContain('page ready')
    expect(await run('browser_console', { clear: true })).toBe('Console cleared.')
    expect(await run('browser_console')).toBe('The console of this tab is empty.')
  })

  it('inspects elements with box, visibility, attributes and styles', async () => {
    const out = await run('browser_inspect', { selector: '#buy', styles: 'color, background-color' })
    expect(out).toContain('1 element match #buy')
    expect(out).toContain('<button id="buy" class="primary"')
    expect(out).toContain('visible, at ')
    expect(out).toContain('text: Buy now')
    expect(out).toContain('styles: color: rgb(255, 255, 255); background-color: rgb(20, 90, 50)')
    const cards = await run('browser_inspect', { selector: '.card' })
    expect(cards).toContain('2 elements match .card')
    expect(cards).toContain('NOT visible')
    expect(await run('browser_inspect', { selector: 'button[' })).toContain('not a valid CSS selector')
    expect(await run('browser_inspect', { selector: '.nothing' })).toBe('Nothing on the page matches .nothing.')
  })

  it('reads cookies (httpOnly too) and both storages', async () => {
    const out = await run('browser_storage')
    expect(out).toContain('sid=s3cr3t-session  (domain 127.0.0.1, path /, httpOnly, SameSite Lax, expires session)')
    expect(out).toContain('seen=yes')
    expect(out).toContain('localStorage (1 key')
    expect(out).toContain('theme = dark')
    expect(out).toContain('sessionStorage (1 key')
    expect(out).toContain('step = 2')
    const only = await run('browser_storage', { what: 'cookies', name: 'sid' })
    expect(only).toContain('sid=')
    expect(only).not.toContain('seen=')
    expect(only).not.toContain('localStorage')
  })

  it('clears the network log', async () => {
    expect(await run('browser_network', { clear: true })).toContain('Cleared')
    expect(await run('browser_network')).toContain('No requests recorded')
  })

  it('says when there is no page', async () => {
    const out = await toolNamed(browserDevtoolsTools({ devtools: async () => null }), 'browser_console').run({}, testContext())
    expect(out).toContain('No page is open')
  })
})
