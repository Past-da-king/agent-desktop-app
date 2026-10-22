// Screenshots and checks for Settings > Devices > Network (workstream E), on the MOCK bridge, with the same audit as
// devices-shoot.mjs (console errors, horizontal overflow, text under 12px, contrast). Drives the row for real:
// None, then Tailscale (key field, Save, joined), then Headscale (address field), then back to None.
//   node scripts/devices-net-shoot.mjs [--out shots-devices-net]
// Needs the built renderer (apps/desktop/out/renderer) and a Playwright Chromium.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt }
const outDir = path.resolve(root, arg('--out', 'shots-devices-net'))
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
    const scope = document.querySelector('.dv-net') ?? document.body
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
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
const expect = (ok, what) => { if (!ok) failures.push(what) }

async function check(page, tag) {
  const a = await audit(page)
  if (a.overflow) failures.push(`${tag} horizontal overflow ${a.overflow}`)
  for (const t of a.tiny.slice(0, 5)) failures.push(`${tag} text under 12px: ${t}`)
  for (const c of a.contrast) (c.ratio < 3 ? failures : warnings).push(`${tag} contrast ${c.ratio}: "${c.text}"`)
}

const dist = path.join(root, 'apps/desktop/out/renderer')
const { server, port } = await serve(dist)
for (const [w, h, theme] of [[1280, 860, 'light'], [1280, 860, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, reducedMotion: 'reduce' })
  const page = await ctx.newPage()
  const tag = `${w}-${theme}`
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text())) failures.push(`${tag} console error: ${m.text().slice(0, 200)}`) })
  page.on('pageerror', (e) => failures.push(`${tag} page error: ${e.message.slice(0, 200)}`))
  await page.goto(`http://127.0.0.1:${port}/index.html?demo=1#/settings`)
  await page.waitForTimeout(900)
  const net = page.locator('.dv-net')
  await net.scrollIntoViewIfNeeded()
  const shoot = async (name) => {
    await net.scrollIntoViewIfNeeded()
    await check(page, `${name}@${tag}`)
    await page.locator('section.dv').screenshot({ path: path.join(outDir, `${name}-${tag}.png`) })
  }
  const lineText = async () => (await net.locator('p').first().textContent()) ?? ''

  // 1. None, Devices off.
  expect((await page.getByRole('tab', { name: 'None' }).getAttribute('aria-selected')) === 'true', `${tag} None not selected at first`)
  await shoot('net-none')

  // 2. Tailscale: the key field appears, Save is off until a key is typed.
  await page.getByRole('switch', { name: 'Let my other devices connect' }).click()
  await page.waitForTimeout(300)
  await page.getByRole('tab', { name: 'Tailscale' }).click()
  await page.waitForTimeout(200)
  const save = net.getByRole('button', { name: 'Save' })
  expect(await save.isDisabled(), `${tag} Save enabled without a key`)
  expect((await net.getByLabel('Auth key').getAttribute('type')) === 'password', `${tag} key field is not a password field`)
  await shoot('net-tailscale-key')
  await net.getByLabel('Auth key').fill('made-up-key-for-preview')
  expect(!(await save.isDisabled()), `${tag} Save still disabled with a key`)
  await save.click()
  await page.waitForTimeout(400)
  const joined = await lineText()
  expect(/Joined as/.test(joined), `${tag} not joined after Save: "${joined}"`)
  expect((await net.getByLabel('Auth key').inputValue()) === '', `${tag} key field not cleared after Save`)
  expect(/saved/i.test((await net.getByLabel('Auth key').getAttribute('placeholder')) ?? ''), `${tag} placeholder does not say the key is saved`)
  const addresses = await page.locator('.dv-urls').textContent()
  expect((addresses ?? '').length > 0, `${tag} no addresses listed`)
  await shoot('net-tailscale-joined')

  // 3. Headscale: the address field appears; Save needs it.
  await page.getByRole('tab', { name: 'Headscale' }).click()
  await page.waitForTimeout(200)
  expect(await net.getByLabel('Headscale address').isVisible(), `${tag} no Headscale address field`)
  expect(await save.isDisabled(), `${tag} Save enabled for Headscale without an address`)
  await net.getByLabel('Headscale address').fill('https://headscale.example.com')
  expect(!(await save.isDisabled()), `${tag} Save disabled with an address and a saved key`)
  await shoot('net-headscale')
  await save.click()
  await page.waitForTimeout(400)
  expect(/Joined as/.test(await lineText()), `${tag} Headscale not joined`)

  // 4. Back to None in one tap.
  await page.getByRole('tab', { name: 'None' }).click()
  await page.waitForTimeout(400)
  expect(/local network/.test(await lineText()), `${tag} None line wrong: "${await lineText()}"`)
  expect((await net.getByLabel('Auth key').count()) === 0, `${tag} key field still shown with None`)
  await shoot('net-none-again')
  await ctx.close()
}
server.close()
await browser.close()
for (const w of warnings) console.log(`WARN ${w}`)
for (const f of failures) console.log(`FAIL ${f}`)
console.log(failures.length === 0 ? `devices-net-shoot: ok (${outDir})` : `devices-net-shoot: ${failures.length} problem(s)`)
process.exit(failures.length === 0 ? 0 : 1)
