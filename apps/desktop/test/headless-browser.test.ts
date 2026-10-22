import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { browserOwner } from '../src/main/browser/owner'
import { findChromium, HeadlessBrowser } from '../src/headless/browser'

// A real Chromium, driven the way the server drives it. Skipped on a machine without one.
const chromium = findChromium()
const PAGE = `<!doctype html><html><head><title>Test page</title></head><body>
<h1>Hello there</h1>
<label>Search here <input id="q" aria-label="Search here"></label>
<button id="go" onclick="document.getElementById('out').textContent = 'pressed ' + document.getElementById('q').value">Press me</button>
<p id="out">waiting</p>
<a href="/two">Second page</a>
</body></html>`

let server: Server
let base = ''
let dir = ''
let browser: HeadlessBrowser

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(req.url === '/two' ? '<!doctype html><title>Two</title><h1>Page two</h1>' : PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`
  dir = mkdtempSync(join(tmpdir(), 'agent-node-browser-'))
  if (chromium !== null) browser = new HeadlessBrowser({ dir: join(dir, 'browser'), executable: chromium, idleMs: 60_000 })
})

afterAll(async () => {
  await browser?.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const as = <T>(owner: string, work: () => Promise<T>): Promise<T> => browserOwner.run({ owner }, work)

describe.skipIf(chromium === null)('headless browser (real Chromium)', () => {
  it('opens a page, reads its outline, types and clicks with trusted input, and runs a script', async () => {
    const outline = await as('main', () => browser.open(`${base}/`))
    expect(outline).toContain('Title: Test page')
    expect(outline).toMatch(/\[\d+\] \w+ "Press me"/)

    const typed = await as('main', () => browser.act({ action: 'type', name: 'Search here', text: 'hello world' }))
    expect(typed).toMatch(/^Done: type/)
    await as('main', () => browser.act({ action: 'click', name: 'Press me' }))
    const result = await as('main', () => browser.evaluate("({ out: document.getElementById('out').textContent, trusted: true })", 10))
    expect(result).toContain('pressed hello world')

    const snap = await as('main', () => browser.snapshotPro({}))
    expect(snap).toContain('Press me')
    const shot = await as('main', () => browser.screenshot())
    expect(shot !== null && existsSync(shot)).toBe(true)
  }, 90_000)

  it('gives each agent its own tab', async () => {
    await as('helper-a', () => browser.open(`${base}/two`))
    await as('helper-b', () => browser.open(`${base}/`))
    expect(await as('helper-a', () => browser.snapshot())).toContain('Title: Two')
    expect(await as('helper-b', () => browser.snapshot())).toContain('Title: Test page')
    expect(await as('nobody-yet', () => browser.snapshot())).toMatch(/No page is open yet/)
  }, 90_000)

  it('closes Chromium when told to and starts again on the next call', async () => {
    await browser.close('test')
    expect(browser.isRunning()).toBe(false)
    const again = await as('main', () => browser.open(`${base}/two`))
    expect(again).toContain('Page two')
    expect(browser.isRunning()).toBe(true)
  }, 90_000)
})
