// Renders the built renderer (apps/desktop/out/renderer) in headless Chromium on the MOCK bridge and saves PNGs.
// Usage: node scripts/shoot.mjs [--only boot|screens|onboarding|chat|data] [--out shots]
// Exit code 1 when any page has a console error, horizontal overflow, text under 12px (11px uppercase eyebrows excepted),
// or text with contrast under 3:1 (3 to 4.5 is reported as a warning).
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const only = arg('--only', 'screens')
const outDir = path.resolve(root, arg('--out', 'shots'))
fs.mkdirSync(outDir, { recursive: true })

async function loadPlaywright() {
  for (const spec of ['playwright-core']) {
    try { return await import(spec) } catch { /* try the global copy */ }
  }
  const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
  const cand = path.join(globalRoot, '@playwright/cli/node_modules/playwright-core/index.mjs')
  if (fs.existsSync(cand)) return import(pathToFileURL(cand).href)
  const cand2 = path.join(globalRoot, '@playwright/cli/node_modules/playwright-core/index.js')
  return import(pathToFileURL(cand2).href)
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = path.join(os.homedir(), '.cache/ms-playwright')
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium')).sort().reverse() : []
  for (const d of dirs) {
    const p = path.join(base, d, 'chrome-linux64/chrome')
    if (fs.existsSync(p)) return p
  }
  throw new Error('No Chromium found. Set CHROME_PATH.')
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
function serve(dir) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    let p = path.join(dir, decodeURIComponent(u.pathname))
    if (!p.startsWith(dir)) { res.writeHead(403); return res.end() }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html')
    if (!fs.existsSync(p)) { res.writeHead(404); return res.end('not found') }
    res.writeHead(200, { 'content-type': mime[path.extname(p)] ?? 'application/octet-stream' })
    fs.createReadStream(p).pipe(res)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

const D = { w: 1440, h: 900 }, T = { w: 1024, h: 768 }, P = { w: 390, h: 844 }
const FULL = [[D, 'light'], [D, 'dark'], [T, 'light'], [P, 'light'], [P, 'dark']]
const DESK = [[D, 'light'], [D, 'dark'], [P, 'light']]
// name, query, hash, viewports, optional keyboard action
const GROUPS = {
  boot: [['boot', '', '#/', DESK]],
  screens: [
    ['home', '?demo=1', '#/home', FULL], ['chat', '?demo=1', '#/chat', FULL], ['tasks', '?demo=1', '#/tasks', FULL],
    ['memory', '?demo=1', '#/memory', FULL], ['routines', '?demo=1', '#/routines', FULL], ['connections', '?demo=1', '#/connections', FULL],
    ['settings', '?demo=1', '#/settings', FULL],
    ['ob-signin', '', '#/onboarding/signin', FULL], ['ob-sync', '', '#/onboarding/sync', DESK], ['ob-ai', '', '#/onboarding/ai', DESK], ['ob-style', '', '#/onboarding/style', DESK],
    ['palette', '?demo=1', '#/home', [[D, 'dark'], [D, 'light']], 'Control+k'],
    ['quick', '?demo=1', '#/home', [[D, 'light']], 'Control+Shift+Space'],
  ],
  chat: [['chat-full', '?demo=1', '#/chat', DESK], ['chat-empty', '?demo=empty', '#/chat', DESK]],
  data: [
    ['home-empty', '?demo=empty', '#/home', DESK], ['tasks-empty', '?demo=empty', '#/tasks', DESK], ['memory-empty', '?demo=empty', '#/memory', DESK], ['routines-empty', '?demo=empty', '#/routines', DESK],
    ['home-big', '?demo=big', '#/home', DESK], ['tasks-big', '?demo=big', '#/tasks', DESK], ['memory-big', '?demo=big', '#/memory', DESK], ['routines-big', '?demo=big', '#/routines', DESK],
  ],
}

const IGNORE_REQ = /fonts\.(googleapis|gstatic)\.com/

async function audit(page) {
  return page.evaluate(() => {
    const out = { overflow: null, tiny: [], contrast: [] }
    const de = document.documentElement
    if (de.scrollWidth > de.clientWidth + 1) out.overflow = `${de.scrollWidth} > ${de.clientWidth}`
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a } }
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const bgOf = (el) => {
      let e = el
      while (e) {
        const c = parse(getComputedStyle(e).backgroundColor)
        if (c && c.a > 0.9) return c
        e = e.parentElement
      }
      return { r: 255, g: 255, b: 255, a: 1 }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const seen = new Set()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent?.trim()
      const el = n.parentElement
      if (!t || !el || seen.has(el)) continue
      seen.add(el)
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"], svg, script, style')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const size = parseFloat(cs.fontSize)
      const eyebrow = cs.textTransform === 'uppercase' && size >= 11
      if (size < 12 && !eyebrow) out.tiny.push(`${size}px "${t.slice(0, 30)}"`)
      const fg = parse(cs.color)
      if (fg && !el.closest('[disabled], [aria-disabled="true"]')) {
        const bg = bgOf(el)
        const a = fg.a
        const mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }
        const l1 = lum(mix), l2 = lum(bg)
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        if (ratio < 4.5) out.contrast.push({ ratio: Math.round(ratio * 100) / 100, text: t.slice(0, 30) })
      }
    }
    return out
  })
}

const { chromium } = await loadPlaywright()
const dist = path.join(root, 'apps/desktop/out/renderer')
if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error(`FAIL: ${dist}/index.html missing. Run npm run build first.`); process.exit(1) }
const { server, port } = await serve(dist)
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] })
const failures = [], warnings = [], report = []

async function run(name, query, hash, viewports, key, extra) {
  for (const [vp, theme] of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: theme, reducedMotion: 'reduce' })
    const page = await ctx.newPage()
    const tag = `${name}@${vp.w}-${theme}`
    page.on('console', (m) => { if (m.type() === 'error' && !IGNORE_REQ.test(m.text()) && !/Failed to load resource/.test(m.text())) failures.push(`${tag} console error: ${m.text().slice(0, 200)}`) })
    page.on('pageerror', (e) => failures.push(`${tag} page error: ${e.message.slice(0, 200)}`))
    page.on('requestfailed', (r) => { if (!IGNORE_REQ.test(r.url())) failures.push(`${tag} request failed: ${r.url().slice(0, 120)}`) })
    await page.goto(`http://127.0.0.1:${port}/index.html${query}${hash}`)
    await page.waitForTimeout(900)
    if (key) { await page.keyboard.press(key); await page.waitForTimeout(500) }
    if (extra) await extra(page, tag, vp, theme)
    const file = path.join(outDir, `${name}-${vp.w}-${theme}.png`)
    await page.screenshot({ path: file })
    const a = await audit(page)
    if (a.overflow) failures.push(`${tag} horizontal overflow ${a.overflow}`)
    for (const t of a.tiny.slice(0, 5)) failures.push(`${tag} text under 12px: ${t}`)
    for (const c of a.contrast) (c.ratio < 3 ? failures : warnings).push(`${tag} contrast ${c.ratio}: "${c.text}"`)
    report.push({ tag, file: path.relative(root, file), tiny: a.tiny.length, contrast: a.contrast.length })
    await ctx.close()
  }
}

// Walks the onboarding on the mock bridge using accessible names (the contract is in tasks/M5.md).
async function onboardingFlow() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light', reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => failures.push(`onboarding-flow page error: ${e.message.slice(0, 200)}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) failures.push(`onboarding-flow console error: ${m.text().slice(0, 200)}`) })
  const shot = (n) => page.screenshot({ path: path.join(outDir, `flow-${n}.png`) })
  const step = async (label, fn) => { try { await fn() } catch (e) { failures.push(`onboarding-flow "${label}": ${String(e.message).split('\n')[0]}`) } }
  await page.goto(`http://127.0.0.1:${port}/index.html#/onboarding/signin`)
  await page.waitForTimeout(800)
  await step('create account tab', async () => { await page.getByRole('tab', { name: /create account/i }).click({ timeout: 4000 }) })
  await step('fill email', async () => { await page.getByLabel('Email', { exact: false }).first().fill('sam@example.test', { timeout: 4000 }) })
  await step('fill password', async () => { await page.getByLabel('Password', { exact: false }).first().fill('secret1', { timeout: 4000 }) })
  await shot('1-signin')
  await step('create account', async () => { await page.getByRole('button', { name: /^create account$/i }).click({ timeout: 4000 }) })
  await page.waitForTimeout(1500); await shot('2-sync')
  await step('sync continue', async () => { await page.getByRole('button', { name: /^continue$/i }).click({ timeout: 8000 }) })
  await page.waitForTimeout(500)
  await step('choose API key', async () => { await page.getByRole('tab', { name: /an api key/i }).or(page.getByRole('radio', { name: /an api key/i })).first().click({ timeout: 4000 }) })
  await page.waitForTimeout(300)
  await step('provider', async () => { await page.getByRole('radio', { name: /anthropic/i }).or(page.getByRole('button', { name: /anthropic/i })).first().click({ timeout: 4000 }) })
  await step('api key', async () => { await page.getByLabel('API key', { exact: false }).first().fill('sk-test-0000', { timeout: 4000 }) })
  await step('check key', async () => { await page.getByRole('button', { name: /^check key$/i }).click({ timeout: 4000 }) })
  await page.waitForTimeout(900); await shot('3-ai')
  await step('ai continue', async () => { await page.getByRole('button', { name: /^continue$/i }).click({ timeout: 4000 }) })
  await page.waitForTimeout(500)
  await step('your name', async () => { await page.getByLabel('Your name', { exact: false }).first().fill('Sam', { timeout: 4000 }) })
  await step('agent name', async () => { await page.getByLabel('Agent name', { exact: false }).first().fill('Nova', { timeout: 4000 }) })
  await shot('4-style')
  await step('open agent', async () => { await page.getByRole('button', { name: /^open agent$/i }).click({ timeout: 4000 }) })
  await page.waitForTimeout(1200); await shot('5-home')
  const home = await page.evaluate(() => location.hash)
  if (!/home/.test(home)) failures.push(`onboarding-flow: after Open Agent the route is ${home}, expected home`)
  await ctx.close()
}

try {
  if (only === 'onboarding') {
    await onboardingFlow()
  } else {
    for (const [name, query, hash, vps, key] of GROUPS[only] ?? []) await run(name, query, hash, vps, key)
  }
} finally {
  await browser.close(); server.close()
}
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ only, failures, warnings, report }, null, 2))
for (const w of warnings.slice(0, 30)) console.log('warn:', w)
if (warnings.length > 30) console.log(`warn: ... and ${warnings.length - 30} more (see shots/report.json)`)
if (failures.length) { for (const f of failures.slice(0, 60)) console.log('FAIL:', f); console.log(`shoot ${only}: ${failures.length} failure(s)`); process.exit(1) }
console.log(`shoot ${only}: ok, ${report.length} screenshots in ${path.relative(root, outDir)}/`)
