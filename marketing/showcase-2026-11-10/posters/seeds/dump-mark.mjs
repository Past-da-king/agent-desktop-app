// Writes the app's own mark (the title bar logo) as an SVG, taken from the built renderer.
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'
const root = path.resolve(process.argv[2]); const out = process.argv[3]
const { chromium } = await import(path.join(root, 'node_modules/playwright-core/index.mjs'))
const dir = path.join(root, 'apps/desktop/out/renderer')
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
const server = http.createServer((req, res) => { let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end() } res.writeHead(200, { 'content-type': mime[path.extname(p)] ?? 'application/octet-stream' }); fs.createReadStream(p).pipe(res) })
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = path.join(process.env.HOME, '.cache/ms-playwright'); const cdir = fs.readdirSync(base).filter((d) => /^chromium-\d/.test(d)).sort().reverse()[0]
const browser = await chromium.launch({ executablePath: path.join(base, cdir, 'chrome-linux64/chrome'), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?demo=1#/home`); await page.waitForTimeout(1200)
const info = await page.evaluate(() => { const els = [...document.querySelectorAll('svg')].filter((s) => { const r = s.getBoundingClientRect(); return r.top < 60 && r.left < 80 }); return els.map((s) => ({ html: s.outerHTML, fill: getComputedStyle(s).color, w: s.getBoundingClientRect().width, parent: s.parentElement.className })) })
fs.writeFileSync(out, JSON.stringify(info, null, 1)); console.log(info.length, info.map((i) => i.html.length + ' ' + i.parent))
await browser.close(); server.close()
