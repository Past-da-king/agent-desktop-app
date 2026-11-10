// shoot-desk.mjs: stills of the BUILT desktop renderer on its mock bridge (demo data only), at 2x.
// node shoot-desk.mjs --root <clone with out/renderer built> --out <dir> [--only name]
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
const args = process.argv.slice(2); const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const root = path.resolve(arg('--root', '.')); const out = path.resolve(arg('--out', '/tmp/desk-stills')); const only = arg('--only', ''); fs.mkdirSync(out, { recursive: true })
const { chromium } = await import(path.join(root, 'node_modules/playwright-core/index.mjs'))
const dir = path.join(root, 'apps/desktop/out/renderer')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' }
const server = http.createServer((req, res) => { let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html'); if (!fs.existsSync(p)) { res.writeHead(404); return res.end() } res.writeHead(200, { 'content-type': mime[path.extname(p)] ?? 'application/octet-stream' }); fs.createReadStream(p).pipe(res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port
const base = path.join(process.env.HOME, '.cache/ms-playwright'); const cdir = fs.readdirSync(base).filter((d) => /^chromium-\d/.test(d)).sort().reverse()[0]
const browser = await chromium.launch({ executablePath: path.join(base, cdir, 'chrome-linux64/chrome'), args: ['--no-sandbox'] })

// name, route, [width, height], steps: clicks (css or text=) and evals run in order
const scenes = [
  { name: 'desk-chat', route: '#/chat', size: [1440, 900] },
  { name: 'desk-chat-top', route: '#/chat', size: [1440, 900], evals: ["document.querySelectorAll('*').forEach(e=>{if(e.scrollHeight>e.clientHeight+200&&getComputedStyle(e).overflowY!=='visible'&&e.closest('main,.chat,.thread')){e.scrollTop=0}})", "document.querySelectorAll('.new-below').forEach(e=>e.remove())"] },
  { name: 'desk-home', route: '#/home', size: [1440, 900] },
  { name: 'desk-learned', route: '#/connections', size: [1440, 900], clicks: ['text=Learned apps'] },
  { name: 'desk-apps', route: '#/apps', size: [1440, 900] },
  { name: 'desk-project', route: '#/project/pj-site', size: [1440, 900] },
  { name: 'desk-chat-tall', route: '#/chat', size: [1440, 1500] },
]
for (const s of scenes) for (const theme of ['light', 'dark']) {
  if (only && !s.name.includes(only)) continue
  const ctx = await browser.newContext({ viewport: { width: s.size[0], height: s.size[1] }, deviceScaleFactor: 2, colorScheme: theme, reducedMotion: 'reduce' })
  const page = await ctx.newPage(); const errs = []
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)))
  await page.goto(`http://127.0.0.1:${port}/index.html?demo=1${s.route}`); await page.waitForTimeout(1200)
  for (const c of s.clicks ?? []) { try { await page.locator(c).first().click({ timeout: 3000 }); await page.waitForTimeout(500) } catch { errs.push('click failed ' + c) } }
  for (const e of s.evals ?? []) { try { await page.evaluate(e); await page.waitForTimeout(500) } catch (x) { errs.push('eval failed ' + String(x.message).slice(0, 100)) } }
  await page.screenshot({ path: path.join(out, `${s.name}-${theme}.png`) })
  console.log(`${s.name}-${theme}.png ${errs.length ? errs.join(' | ') : 'ok'}`)
  await ctx.close()
}
await browser.close(); server.close()
