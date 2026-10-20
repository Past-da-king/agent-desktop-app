import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'

import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  evalWrapper,
  fieldValueScript,
  formatSnapshot,
  looksLikeExpression,
  parseResolved,
  parseSnapshot,
  resolveScript,
  selectFieldScript,
  selectOptionScript,
  snapshotScript,
} from '../src/main/browser/snapshot'

const FIXTURE = `<!doctype html><html><head><title>Snapshot Fixture</title></head><body>
<h1>Book a trip</h1>
<button id="search">Search</button>
<a href="/deals">Deals</a>
<label>Where to? <input id="where" value="Lon"></label>
<div role="checkbox" aria-checked="true" aria-label="Flexible dates" tabindex="0" style="width:20px;height:20px"></div>
<button aria-expanded="false">More options</button>
<button disabled>Pay</button>
<button>Play song one</button><button>Play song two</button>
<select id="cls"><option>Economy</option><option>Business</option></select>
<div aria-label="Pick 12 March" style="width:30px;height:30px;cursor:pointer"></div>
<x-card></x-card>
<iframe srcdoc="<button>Inside frame</button>" style="width:200px;height:60px"></iframe>
<div id="veil" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.3)"></div>
<script>
customElements.define('x-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow buy</button>'; } });
window.__clicks = 0; document.getElementById('search').addEventListener('click', () => window.__clicks++);
</script></body></html>`

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
const suite = chrome === null ? describe.skip : describe

suite('snapshot by role and name, in a real Chromium', () => {
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox'] })
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } })
    await page.setContent(FIXTURE)
    await page.waitForTimeout(150)
  })

  afterAll(async () => {
    await browser?.close()
  })

  it('numbers elements with role, name and state, through shadow roots and same-origin frames', async () => {
    const snap = parseSnapshot(await page.evaluate(snapshotScript()))
    const line = (name: string) => snap.elements.find((element) => element.name === name)
    expect(line('Search')?.role).toBe('button')
    expect(line('Deals')?.role).toBe('link')
    expect(line('Where to?')?.state).toContain('value="Lon"')
    expect(line('Flexible dates')).toMatchObject({ role: 'checkbox', state: 'checked' })
    expect(line('More options')?.state).toBe('collapsed')
    expect(line('Pay')?.state).toBe('disabled')
    expect(line('Shadow buy')?.role).toBe('button')
    expect(line('Inside frame')?.role).toBe('button')
    expect(snap.headings).toContain('h1 Book a trip')
    const text = formatSnapshot(snap, { view: 'Desktop 1440x900' })
    expect(text).toContain('View: Desktop 1440x900')
    expect(text).toMatch(/\[\d+\] button "Search"/)
  })

  it('filters, and finds unlabelled clickable things only in deep mode', async () => {
    const filtered = parseSnapshot(await page.evaluate(snapshotScript({ filter: 'play' })))
    expect(filtered.elements.map((element) => element.name)).toEqual(['Play song one', 'Play song two'])
    const shallow = parseSnapshot(await page.evaluate(snapshotScript()))
    expect(shallow.elements.some((element) => element.name === 'Pick 12 March')).toBe(false)
    const deep = parseSnapshot(await page.evaluate(snapshotScript({ deep: true })))
    expect(deep.elements.some((element) => element.name === 'Pick 12 March')).toBe(true)
  })

  it('resolves by name live, refuses an ambiguous partial name and lists the candidates', async () => {
    const found = parseResolved(await page.evaluate(resolveScript({ name: 'search' }, 500)))
    expect(found.ok).toBe(true)
    expect(found.label).toBe('button "Search"')
    expect(found.x).toBeGreaterThan(0)
    const ambiguous = parseResolved(await page.evaluate(resolveScript({ name: 'Play' }, 300)))
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.candidates).toHaveLength(2)
    const second = parseResolved(await page.evaluate(resolveScript({ name: 'Play', nth: 2 }, 300)))
    expect(second.label).toBe('button "Play song two"')
    const missing = parseResolved(await page.evaluate(resolveScript({ name: 'Checkout now' }, 200)))
    expect(missing.ok).toBe(false)
    expect(missing.reason).toContain('Nothing on the page')
  })

  it('reports what covers a target, so a swallowed click is not claimed as done', async () => {
    await page.evaluate(() => {
      const veil = document.getElementById('veil')
      if (veil) veil.style.display = 'block'
    })
    const covered = parseResolved(await page.evaluate(resolveScript({ name: 'Search', role: 'button' }, 300)))
    expect(covered.ok).toBe(true)
    expect(covered.covered).toContain('div#veil')
    await page.evaluate(() => {
      const veil = document.getElementById('veil')
      if (veil) veil.style.display = 'none'
    })
  })

  it('selects a field for replacing, reads it back and picks a dropdown option', async () => {
    await page.evaluate(resolveScript({ name: 'Where to?' }, 300))
    expect((await page.evaluate(selectFieldScript())) as { ok: boolean }).toMatchObject({ ok: true })
    await page.keyboard.type('Paris')
    expect(await page.evaluate(fieldValueScript())).toEqual({ ok: true, value: 'Paris' })
    await page.evaluate(resolveScript({ name: "cls", role: "combobox" }, 300))
    expect(await page.evaluate(selectOptionScript('business'))).toMatchObject({ ok: true, value: 'Business' })
    expect(await page.evaluate(() => (document.getElementById('cls') as HTMLSelectElement).value)).toBe('Business')
  })

  it('runs a multi-step script in the page and returns its value and log', async () => {
    const compiles = (source: string): boolean => {
      try {
        new Script(source)
        return true
      } catch {
        return false
      }
    }
    const code = "log('start'); const b = $('#search'); b.click(); await sleep(10); log('clicked', window.__clicks); return { clicks: window.__clicks, title: document.title };"
    expect(looksLikeExpression(code, compiles)).toBe(false)
    const result = (await page.evaluate(evalWrapper(code, false))) as { ok: boolean; value: { clicks: number; title: string }; log: string[] }
    expect(result.ok).toBe(true)
    expect(result.value.title).toBe('Snapshot Fixture')
    expect(result.log[0]).toContain('start')
    expect(looksLikeExpression('document.title', compiles)).toBe(true)
    const expr = (await page.evaluate(evalWrapper('document.title', true))) as { value: string }
    expect(expr.value).toBe('Snapshot Fixture')
    const broken = (await page.evaluate(evalWrapper("throw new Error('step 3 failed')", false))) as { ok: boolean; error: string }
    expect(broken.ok).toBe(false)
    expect(broken.error).toContain('step 3 failed')
  })
})
