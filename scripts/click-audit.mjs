// Presses every visible, enabled button on every screen (mock bridge, demo data) and reports the ones that do nothing
// or throw. "Does something" = the URL, an overlay, the DOM, focus or the bridge's data changed within 600 ms.
// Usage: node scripts/click-audit.mjs [--width 1440] [--out shots/click-audit.json]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const width = Number(arg('--width', '1440'))
const height = width < 600 ? 844 : 900
const outFile = path.resolve(root, arg('--out', 'shots/click-audit.json'))

async function loadPlaywright() {
  try { return await import('playwright-core') } catch { /* fall through */ }
  const g = execSync('npm root -g', { encoding: 'utf8' }).trim()
  return import(pathToFileURL(path.join(g, '@playwright/cli/node_modules/playwright-core/index.mjs')).href)
}
function chrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = path.join(os.homedir(), '.cache/ms-playwright')
  for (const d of fs.readdirSync(base).filter((x) => x.startsWith('chromium')).sort().reverse()) {
    const p = path.join(base, d, 'chrome-linux64/chrome')
    if (fs.existsSync(p)) return p
  }
  throw new Error('no chromium')
}
const dist = path.join(root, 'apps/desktop/out/renderer')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  let p = path.join(dist, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html')
  if (!fs.existsSync(p)) { res.writeHead(404); return res.end() }
  res.writeHead(200, { 'content-type': mime[path.extname(p)] ?? 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/index.html`

const ROUTES = [
  ['?demo=1', '#/home'], ['?demo=1', '#/chat'], ['?demo=1', '#/tasks'], ['?demo=1', '#/memory'], ['?demo=1', '#/routines'],
  ['?demo=1', '#/connections'], ['?demo=1', '#/settings'], ['?demo=empty', '#/home'],
  ['', '#/onboarding/signin'], ['', '#/onboarding/sync'], ['', '#/onboarding/ai'], ['', '#/onboarding/style'],
]
// Buttons whose only job is to close or quit the window: in a plain browser they cannot do anything visible.
const SKIP = /^(Minimise|Minimize|Maximise|Maximize|Restore|Close window|Close)$/i

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ executablePath: chrome(), args: ['--no-sandbox'] })
const results = []

async function fresh(query, hash) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()) })
  await page.goto(base + query + hash)
  await page.waitForTimeout(500)
  return { ctx, page, errors }
}
const snapshot = (page) => page.evaluate(() => ({
  url: location.hash,
  html: document.body.innerHTML.length + ':' + document.querySelectorAll('*').length,
  text: document.body.innerText.slice(0, 4000),
  focus: document.activeElement ? document.activeElement.outerHTML.slice(0, 80) : '',
  data: (() => { try { return JSON.stringify(window.__mockState ?? null).length } catch { return 0 } })(),
}))

for (const [query, hash] of ROUTES) {
  const first = await fresh(query, hash)
  const labels = await first.page.evaluate(() =>
    [...document.querySelectorAll('button, [role="tab"], [role="switch"], a[href]')]
      .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden' })
      .map((b, i) => ({ i, name: (b.getAttribute('aria-label') || b.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60), disabled: b.disabled || b.getAttribute('aria-disabled') === 'true' })))
  await first.ctx.close()
  for (const b of labels) {
    const rec = { route: query + hash, index: b.i, name: b.name || '(no name)', result: '' }
    if (b.disabled) { rec.result = 'disabled'; results.push(rec); continue }
    if (SKIP.test(b.name)) { rec.result = 'skipped (window control)'; results.push(rec); continue }
    const { ctx, page, errors } = await fresh(query, hash)
    try {
      const before = await snapshot(page)
      const handle = (await page.$$('button, [role="tab"], [role="switch"], a[href]')).filter(Boolean)
      const visible = []
      for (const h of handle) { const box = await h.boundingBox(); if (box && box.width > 0 && box.height > 0) visible.push(h) }
      const target = visible[b.i]
      if (!target) { rec.result = 'not found on reload'; results.push(rec); await ctx.close(); continue }
      await target.click({ timeout: 2000 })
      await page.waitForTimeout(600)
      const after = await snapshot(page)
      const changed = before.url !== after.url || before.html !== after.html || before.text !== after.text || before.focus !== after.focus
      rec.result = errors.length ? `ERROR: ${errors[0].slice(0, 120)}` : changed ? 'ok' : 'NO VISIBLE EFFECT'
    } catch (e) {
      rec.result = `click failed: ${String(e.message).split('\n')[0].slice(0, 100)}`
    }
    results.push(rec)
    await ctx.close()
  }
}
await browser.close(); server.close()
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(results, null, 2))
const bad = results.filter((r) => /^(ERROR|NO VISIBLE|click failed|not found)/.test(r.result))
const count = (k) => results.filter((r) => r.result.startsWith(k)).length
console.log(`click audit @${width}: ${results.length} controls, ok ${count('ok')}, disabled ${count('disabled')}, skipped ${count('skipped')}, problems ${bad.length}`)
for (const r of bad) console.log(`  ${r.route}  "${r.name}"  -> ${r.result}`)
