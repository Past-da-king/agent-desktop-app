// Screenshots for the Devices work (workstream A), with the same checks as shoot.mjs (console errors, horizontal
// overflow, text under 12px, contrast).
//   node scripts/devices-shoot.mjs mock [--out shots-devices]
//     The built renderer on the MOCK bridge: Settings > Devices on, then the Add a device dialog.
//   node scripts/devices-shoot.mjs remote --url https://127.0.0.1:7787 --pass <pass> [--out shots-devices]
//     The node's own web UI at /app/ on the REMOTE bridge, as a paired phone and a desktop browser see it.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const mode = args[0] ?? 'mock'
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const outDir = path.resolve(root, arg('--out', 'shots-devices'))
fs.mkdirSync(outDir, { recursive: true })

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = path.join(os.homedir(), '.cache/ms-playwright')
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium')).sort().reverse() : []
  for (const d of dirs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-win64/chrome.exe', 'chrome-win/chrome.exe']) {
      const p = path.join(base, d, sub)
      if (fs.existsSync(p)) return p
    }
  }
  throw new Error('No Chromium found. Set CHROME_PATH.')
}

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
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

async function audit(page) {
  return page.evaluate(() => {
    const out = { overflow: null, tiny: [], contrast: [] }
    const de = document.documentElement
    if (de.scrollWidth > de.clientWidth + 1) out.overflow = `${de.scrollWidth} > ${de.clientWidth}`
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a } }
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const bgOf = (el) => { let e = el; while (e) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0.9) return c; e = e.parentElement } return { r: 255, g: 255, b: 255, a: 1 } }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    const seen = new Set()
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent?.trim(); const el = n.parentElement
      if (!t || !el || seen.has(el)) continue
      seen.add(el)
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || el.closest('[aria-hidden="true"], svg, script, style')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      const size = parseFloat(cs.fontSize)
      if (size < 12 && !(cs.textTransform === 'uppercase' && size >= 11)) out.tiny.push(`${size}px "${t.slice(0, 30)}"`)
      const fg = parse(cs.color)
      if (fg && !el.closest('[disabled], [aria-disabled="true"]')) {
        const bg = bgOf(el); const a = fg.a
        const mix = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) }
        const l1 = lum(mix), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        if (ratio < 4.5) out.contrast.push({ ratio: Math.round(ratio * 100) / 100, text: t.slice(0, 30) })
      }
    }
    return out
  })
}

const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] })
const failures = []
const warnings = []

async function check(page, tag) {
  const a = await audit(page)
  if (a.overflow) failures.push(`${tag} horizontal overflow ${a.overflow}`)
  for (const t of a.tiny.slice(0, 5)) failures.push(`${tag} text under 12px: ${t}`)
  for (const c of a.contrast) (c.ratio < 3 ? failures : warnings).push(`${tag} contrast ${c.ratio}: "${c.text}"`)
}

async function context(width, height, theme, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce', ...extra })
  const page = await ctx.newPage()
  const tag = `${width}-${theme}`
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) failures.push(`${tag} console error: ${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => failures.push(`${tag} page error: ${e.message.slice(0, 200)}`))
  return { ctx, page, tag }
}

const shot = (page, name) => page.screenshot({ path: path.join(outDir, `${name}.png`) })

if (mode === 'mock') {
  const dist = path.join(root, 'apps/desktop/out/renderer')
  const { server, port } = await serve(dist)
  for (const [w, h, theme] of [[1280, 860, 'light'], [1280, 860, 'dark'], [390, 844, 'light'], [412, 915, 'dark']]) {
    const { ctx, page, tag } = await context(w, h, theme)
    await page.goto(`http://127.0.0.1:${port}/index.html?demo=1#/settings`)
    await page.waitForTimeout(900)
    const section = page.locator('section.dv')
    await section.scrollIntoViewIfNeeded()
    await page.getByRole('switch', { name: 'Let my other devices connect' }).click()
    await page.waitForTimeout(300)
    await section.scrollIntoViewIfNeeded()
    await check(page, `devices-mock@${tag}`)
    await section.screenshot({ path: path.join(outDir, `mock-devices-${tag}.png`) })
    await page.getByRole('button', { name: 'Add a device' }).click()
    await page.waitForTimeout(400)
    await check(page, `devices-mock-add@${tag}`)
    await shot(page, `mock-add-${tag}`)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Take out' }).first().click()
    await page.waitForTimeout(300)
    await shot(page, `mock-revoke-${tag}`)
    await ctx.close()
  }
  server.close()
} else {
  const base = arg('--url', '')
  const pass = arg('--pass', '')
  if (base === '' || pass === '') throw new Error('--url and --pass are needed')
  for (const [w, h, theme, name] of [[390, 844, 'light', 'phone'], [412, 915, 'dark', 'phone'], [1280, 860, 'light', 'desktop']]) {
    const touch = name === 'phone'
    const { ctx, page, tag } = await context(w, h, theme, { ignoreHTTPSErrors: true, hasTouch: touch, isMobile: touch, userAgent: touch ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36' : undefined })
    await page.goto(`${base}/app/?k=${encodeURIComponent(pass)}`)
    await page.waitForTimeout(2500)
    await check(page, `remote-home@${tag}`)
    await shot(page, `remote-home-${tag}`)
    for (const view of ['chat', 'tasks', 'memory', 'settings']) {
      await page.evaluate((v) => { window.location.hash = `#/${v}` }, view)
      await page.waitForTimeout(1500)
      await check(page, `remote-${view}@${tag}`)
      await shot(page, `remote-${view}-${tag}`)
    }
    await ctx.close()
  }
}

await browser.close()
for (const w of warnings) console.log(`WARN ${w}`)
for (const f of failures) console.log(`FAIL ${f}`)
console.log(failures.length === 0 ? `devices-shoot ${mode}: ok (${outDir})` : `devices-shoot ${mode}: ${failures.length} problem(s)`)
process.exit(failures.length === 0 ? 0 : 1)
