import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  clickScript,
  formatOutline,
  outlineScript,
  parseOutline,
  parseRead,
  readScript,
  scrollScript,
  typeScript,
  waitForScript,
} from '../src/main/browser/outline'

const FIXTURE = `<!doctype html>
<html><head><title>Fixture Page</title></head>
<body>
  <h1>Welcome</h1>
  <h2>Booking</h2>
  <button id="search" type="button">Search</button>
  <a id="flights" href="/flights">Flights</a>
  <label for="where">Where to?</label>
  <input id="where" name="where">
  <input id="remember" type="checkbox" checked>
  <label for="remember">Remember me</label>
  <select id="class"><option>Economy</option><option>Business</option></select>
  <input id="file" type="file">
  <button id="pay" disabled>Pay</button>
  <div style="display:none"><button id="secret">Secret</button></div>
  <input type="hidden" id="token" value="x">
  <div id="late"></div>
  <div id="tall" style="height:4000px"></div>
  <script>
    window.__clicked = '';
    window.__inputs = 0;
    document.getElementById('search').addEventListener('click', function () { window.__clicked = 'yes'; });
    document.getElementById('where').addEventListener('input', function () { window.__inputs++; });
    setTimeout(function () { document.getElementById('late').textContent = 'Arrived now'; }, 300);
  </script>
</body></html>`

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

const chrome = findChrome()
const suite = chrome === null ? describe.skip : describe

suite('browser page helpers', () => {
  let browser: Browser
  let server: http.Server
  let baseUrl = ''
  let page: Page

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/flights') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html><head><title>Flights</title></head><body><h1>Flights</h1></body></html>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(FIXTURE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no server address')
    baseUrl = `http://127.0.0.1:${address.port}/`
    browser = await chromium.launch({
      executablePath: chrome ?? undefined,
      args: ['--no-sandbox'],
    })
  })

  afterAll(async () => {
    await browser?.close()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  })

  async function freshPage(): Promise<Page> {
    const next = await browser.newPage()
    await next.goto(baseUrl)
    return next
  }

  it('lists visible interactive elements and headings with stable numbers', async () => {
    page = await freshPage()
    const outline = parseOutline(await page.evaluate(outlineScript()))

    expect(outline.title).toBe('Fixture Page')
    expect(outline.headings).toEqual(['Welcome', 'Booking'])

    const labels = outline.elements.map((element) => element.label)
    expect(labels).toContain('Search')
    expect(labels).toContain('Flights')
    expect(labels).toContain('Where to?')
    expect(labels).toContain('Remember me')
    expect(labels).not.toContain('Secret')

    const search = outline.elements.find((element) => element.label === 'Search')
    expect(search?.kind).toBe('button')
    const checkbox = outline.elements.find((element) => element.label === 'Remember me')
    expect(checkbox?.extra).toContain('(checked)')
    const pay = outline.elements.find((element) => element.label === 'Pay')
    expect(pay?.extra).toContain('(disabled)')
    const flight = outline.elements.find((element) => element.label === 'Flights')
    expect(flight?.extra).toContain('/flights')

    const numbers = outline.elements.map((element) => element.index)
    expect(numbers).toEqual(numbers.map((_number, position) => position))
    await page.close()
  })

  it('clicks a numbered element', async () => {
    page = await freshPage()
    const outline = parseOutline(await page.evaluate(outlineScript()))
    const index = outline.elements.find((element) => element.label === 'Search')?.index ?? -1
    expect(index).toBeGreaterThanOrEqual(0)

    const result = await page.evaluate(clickScript(index))
    expect(result).toMatchObject({ ok: true })
    expect(await page.evaluate('window.__clicked')).toBe('yes')
    await page.close()
  })

  it('types into a numbered field and fires input events', async () => {
    page = await freshPage()
    const outline = parseOutline(await page.evaluate(outlineScript()))
    const index = outline.elements.find((element) => element.label === 'Where to?')?.index ?? -1
    expect(index).toBeGreaterThanOrEqual(0)

    const result = await page.evaluate(typeScript(index, 'Durban'))
    expect(result).toMatchObject({ ok: true })
    expect(await page.inputValue('#where')).toBe('Durban')
    expect(await page.evaluate('window.__inputs')).toBeGreaterThan(0)
    await page.close()
  })

  it('reads an element, a selector and the whole page', async () => {
    page = await freshPage()
    const outline = parseOutline(await page.evaluate(outlineScript()))
    const index = outline.elements.find((element) => element.label === 'Search')?.index ?? -1
    const field = outline.elements.find((element) => element.label === 'Where to?')?.index ?? -1

    const byIndex = parseRead(await page.evaluate(readScript({ index })))
    expect(byIndex.ok).toBe(true)
    expect(byIndex.text).toContain('Search')

    await page.evaluate(typeScript(field, 'Cape Town'))
    const bySelector = parseRead(await page.evaluate(readScript({ selector: '#where' })))
    expect(bySelector.text).toBe('Cape Town')

    const whole = parseRead(await page.evaluate(readScript()))
    expect(whole.text).toContain('Welcome')
    await page.close()
  })

  it('says when a number is not on the current outline', async () => {
    page = await freshPage()
    await page.evaluate(outlineScript())
    const result = await page.evaluate(clickScript(99))
    expect(result).toMatchObject({ ok: false })
    expect(String((result as { reason: string }).reason)).toContain('outline')
    await page.close()
  })

  it('waits for text and reports a timeout', async () => {
    page = await freshPage()
    const found = await page.evaluate(waitForScript('Arrived now', '', 3_000))
    expect(found).toMatchObject({ ok: true })
    const missed = await page.evaluate(waitForScript('Never going to be here', '', 1_000))
    expect(missed).toMatchObject({ ok: false })
    await page.close()
  })

  it('scrolls the page', async () => {
    page = await freshPage()
    await page.evaluate(scrollScript(600))
    const offset = await page.evaluate('window.scrollY')
    expect(offset).toBeGreaterThan(0)
    await page.close()
  })

  it('notes a captcha so the model knows to hand over', async () => {
    page = await browser.newPage()
    await page.setContent(
      '<html><body><h1>Verify</h1><p>Please verify you are human</p><button>Go</button></body></html>',
    )
    const outline = parseOutline(await page.evaluate(outlineScript()))
    expect(outline.note).toMatch(/captcha/i)
    await page.close()
  })

  it('formats the outline for the model', async () => {
    page = await freshPage()
    const outline = parseOutline(await page.evaluate(outlineScript()))
    const text = formatOutline(outline, ['/tmp/agent-browser/downloads/a.pdf'])
    expect(text).toContain('URL: http://127.0.0.1:')
    expect(text).toContain('Title: Fixture Page')
    expect(text).toContain('[0]')
    expect(text).toContain('Headings:')
    expect(text).toContain('- Welcome')
    expect(text).toContain('Files downloaded:')
    expect(text).toContain('/tmp/agent-browser/downloads/a.pdf')
    await page.close()
  })
})
