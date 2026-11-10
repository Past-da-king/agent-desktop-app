// posters.mjs: writes one HTML page per poster and size into pages/, then renders each to PNG at 2x and scales to 1080 wide.
// node posters.mjs --pw <dir with node_modules/playwright-core> --out <dir> [--only "Poster 1"] [--keep2x]
// Pages are static: open pages/*.html in any browser to look at one.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2); const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const out = path.resolve(arg('--out', path.join(here, 'out'))); const only = arg('--only', ''); const pw = path.resolve(arg('--pw', '.'))
fs.mkdirSync(out, { recursive: true }); fs.mkdirSync(path.join(here, 'pages'), { recursive: true })

// The app's own mark: the title bar logo of the desktop app (Mascot.tsx, shape cookie9, with its two eyes).
const MARK = `<svg viewBox="0 0 100 100"><path class="mark-body" d="M50.0 4.5L52.4 4.7L54.8 5.3L57.0 6.3L59.0 7.7L60.9 9.2L63.0 10.5L65.3 11.4L67.7 11.9L70.1 12.0L72.6 12.1L74.9 12.6L77.2 13.6L79.3 14.9L81.1 16.5L82.6 18.4L83.8 20.5L84.6 22.8L85.1 25.2L85.7 27.6L86.8 29.8L88.1 31.8L89.9 33.5L91.7 35.1L93.3 37.0L94.6 39.0L95.4 41.3L95.9 43.7L96.0 46.2L95.7 48.6L94.9 50.9L93.8 53.1L92.7 55.2L92.0 57.6L91.6 60.0L91.7 62.4L92.0 64.8L92.2 67.3L92.0 69.7L91.3 72.0L90.3 74.2L88.9 76.2L87.2 78.0L85.2 79.4L83.0 80.5L80.7 81.3L78.6 82.5L76.7 84.0L75.0 85.9L73.7 87.9L72.4 90.0L70.7 91.7L68.8 93.2L66.7 94.4L64.3 95.2L61.9 95.5L59.5 95.5L57.1 95.0L54.8 94.2L52.4 93.6L50.0 93.4L47.6 93.6L45.2 94.2L42.9 95.0L40.5 95.5L38.1 95.5L35.7 95.2L33.3 94.4L31.2 93.2L29.3 91.7L27.6 90.0L26.3 87.9L25.0 85.9L23.3 84.0L21.4 82.5L19.3 81.3L17.0 80.5L14.8 79.4L12.8 78.0L11.1 76.2L9.7 74.2L8.7 72.0L8.0 69.7L7.8 67.3L8.0 64.8L8.3 62.4L8.4 60.0L8.0 57.6L7.3 55.2L6.2 53.1L5.1 50.9L4.3 48.6L4.0 46.2L4.1 43.7L4.6 41.3L5.4 39.0L6.7 37.0L8.3 35.1L10.1 33.5L11.9 31.8L13.2 29.8L14.3 27.6L14.9 25.2L15.4 22.8L16.2 20.5L17.4 18.4L18.9 16.5L20.7 14.9L22.8 13.6L25.1 12.6L27.4 12.1L29.9 12.0L32.3 11.9L34.7 11.4L37.0 10.5L39.1 9.2L41.0 7.7L43.0 6.3L45.2 5.3L47.6 4.7Z"/><ellipse class="mark-eye" cx="37.5" cy="49" rx="4.3" ry="6.4"/><ellipse class="mark-eye" cx="62.5" cy="49" rx="4.3" ry="6.4"/></svg>`
const SIGNAL = `<svg viewBox="0 0 46 14"><path d="M0 10h3v4H0zM5 7h3v7H5zM10 4h3v10h-3zM15 1h3v13h-3z"/><rect x="25" y="1.5" width="18" height="11" rx="3"/><rect x="44" y="5" width="2" height="4" rx="1"/></svg>`

// Devices: phone {img, sq, tall} with css box (w plus left/right/top), win the same for a desktop window.
const P = (img, sq, tall) => ({ kind: 'phone', img: 'stills/phone/' + img, sq, tall })
const W = (img, sq, tall) => ({ kind: 'win', img: 'stills/desk/' + img, sq, tall })
// A slide-up sheet over the page it belongs to: both are real renders, put together the way the app shows them (page dimmed, sheet on top).
const S = (img, sheet, anchor, sq, tall) => ({ kind: 'phone', img: 'stills/phone/' + img, sheet: 'stills/phone/' + sheet, anchor, sq, tall })
const SQ = { w: 440, right: 64, top: 57 }       // whole phone, right side
const TALL = { w: 600, left: 240, top: 600 }    // big phone, runs off the bottom

const posters = [
  { file: 'Poster 1 Call', theme: 't-iris', h1: ['It picks up', 'the phone.'],
    sub: 'Your agent places a real WhatsApp voice call from inside the phone app, then tells you what was said.',
    note: 'No telephony service. No second device.', tallH1: 128,
    devices: [P('01-call-chat-light.png', SQ, { w: 620, left: 230, top: 650 })] },
  { file: 'Poster 2 Learned apps', theme: 't-dark', h1: ['One agent learns it.', 'Every agent can use it.'],
    sub: 'Calling on WhatsApp is a learned app: a skill saved once, that any agent you run can call.',
    note: 'Next: agents sharing what they learn.', tallH1: 84,
    devices: [S('05c-connections-dark.png', '05b-learned-open-dark.png', 'top', SQ, TALL)] },
  { file: 'Poster 3 Helpers', theme: 't-light', h1: ['Work happens', 'in the background.'],
    sub: 'Helpers run side by side, across your projects, and report back when they land.',
    devices: [P('04-running-chat-light.png', SQ, TALL)] },
  { file: 'Poster 4 Approvals', theme: 't-lav', h1: ['Nothing goes out', 'without your yes.'],
    sub: 'Anything sent in your name waits for you first, with the exact details in front of you.',
    devices: [P('07b-approval-chat-light.png', SQ, TALL)] },
  { file: 'Poster 5 Phone and desktop', theme: 't-dark', stack: true, h1: ['One agent.', 'Phone and desktop.'],
    sub: 'Start on your phone, carry on at your desk. Same chat, same memory, same helpers.',
    devices: [W('desk-chat-top-dark.png', { w: 980, left: 162, top: 500 }, { w: 1120, left: 216, top: 560 }), P('01-call-chat-dark.png', { w: 290, left: 72, top: 476 }, { w: 380, left: 72, top: 536 })] },
  { file: 'Poster 6 Browser', theme: 't-light', stack: true, h1: ['Watch it work.', 'Take over any time.'],
    sub: 'It has its own browser, right beside the chat. Answers come back as cards you can act on.',
    devices: [W('desk-chat-light.png', { w: 1290, right: 64, top: 480 }, { w: 1290, right: 64, top: 560 })] },
  { file: 'Poster 7 Talk', theme: 't-light', h1: ['Or just', 'talk to it.'],
    sub: 'A voice call with your own agent, with live captions, while it does the work.',
    devices: [P('02-call-captions-dark.png', SQ, TALL)] },
  { file: 'Poster 8 Projects', theme: 't-iris', side: true, h1: ['A chat for', 'every project.'],
    sub: 'Each project keeps its own chat and helpers. Switch from the title and see what is running where.',
    devices: [S('01-call-chat-dark.png', '06-switcher-dark.png', 'bottom', SQ, { w: 460, right: 64, top: 176 })] },
]

const box = (b) => `--w:${b.w}px;` + ['left', 'right', 'top', 'bottom'].filter((k) => b[k] !== undefined).map((k) => `${k}:${b[k]}px;`).join('')
function device(d, size, colours) {
  const b = d[size]
  if (d.kind === 'win') return `<div class="win" style="${box(b)}"><img src="../${d.img}" alt=""></div>`
  const c = colours[d.img]
  if (d.sheet) {
    const s = sheets[d.sheet]; const u = (n) => `calc(var(--sw) * ${n} / 1170)`
    const place = d.anchor === 'bottom' ? `bottom:0;height:${u(s.bottom - s.top + 84)};` : `top:${u(s.top)};bottom:0;`
    return `<div class="phone" style="${box(b)}--sb:${c.dim};--sbink:#F2F0F7;"><div class="screen"><div class="status"><span>9:41</span>${SIGNAL}</div><div class="cam"></div><div class="stage"><img src="../${d.img}" alt=""><div class="scrim"></div><div class="sheet" style="${place}border-radius:${u(s.radius)} ${u(s.radius)} 0 0;background:${s.bg};"><img src="../${d.sheet}" alt="" style="margin-top:${u(-s.top)};"></div></div></div></div>`
  }
  return `<div class="phone" style="${box(b)}--sb:${c.bg};--sbink:${c.ink};"><div class="screen"><div class="status"><span>9:41</span>${SIGNAL}</div><div class="cam"></div><img src="../${d.img}" alt=""></div></div>`
}
function page(p, size, colours) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${p.file} ${size}</title><link rel="stylesheet" href="../posters.css"></head><body>
<div class="poster ${size} ${p.theme}${p.stack ? ' stack' : ''}${p.side ? ' side' : ''}">
  <div class="brand">${MARK}<span>Agent</span><span class="tag">Open source</span></div>
  <div class="copy"><h1${size === 'tall' && p.tallH1 ? ` style="font-size:${p.tallH1}px"` : ''}>${p.h1.map((l) => `<span>${l}</span>`).join('')}</h1><p class="sub">${p.sub}</p>${p.note ? `<p class="note">${p.note}</p>` : ''}</div>
  ${p.devices.map((d) => device(d, size, colours)).join('\n  ')}
</div></body></html>`
}

const { chromium } = await import(pathToFileURL(path.join(pw, 'node_modules/playwright-core/index.mjs')).href)
const base = path.join(process.env.HOME, '.cache/ms-playwright'); const cdir = fs.readdirSync(base).filter((d) => /^chromium-\d/.test(d)).sort().reverse()[0]
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? path.join(base, cdir, 'chrome-linux64/chrome'), args: ['--no-sandbox', '--allow-file-access-from-files'] })
const ctx = await browser.newContext({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 }); const page_ = await ctx.newPage()

// The colour at the top of each phone still, so the status bar the frame draws continues the screen under it.
const colours = {}
await page_.goto(pathToFileURL(path.join(here, 'posters.css')).href)
for (const img of new Set(posters.flatMap((p) => p.devices.filter((d) => d.kind === 'phone').map((d) => d.img)))) {
  colours[img] = await page_.evaluate(async (src) => {
    const im = new Image(); im.src = src; await im.decode()
    const c = document.createElement('canvas'); c.width = im.width; c.height = 8; const g = c.getContext('2d'); g.drawImage(im, 0, 0)
    const [r, gg, b] = g.getImageData(Math.floor(im.width / 2), 2, 1, 1).data
    const lum = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255
    return { bg: `rgb(${r},${gg},${b})`, dim: `rgb(${Math.round(r * 0.5)},${Math.round(gg * 0.5)},${Math.round(b * 0.5)})`, ink: lum > 0.55 ? '#1B1A1F' : '#F2F0F7' }
  }, pathToFileURL(path.join(here, img)).href)
}

// Where each sheet starts and ends inside its still (the harness draws it on an empty page), and its corner radius.
const sheets = {}
for (const img of new Set(posters.flatMap((p) => p.devices.filter((d) => d.sheet).map((d) => d.sheet)))) {
  sheets[img] = await page_.evaluate(async (src) => {
    const im = new Image(); im.src = src; await im.decode()
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0)
    const px = (x, y) => g.getImageData(x, y, 1, 1).data; const far = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 5
    const x0 = Math.floor(im.width / 4); const band = px(x0, 2); let top = 0
    for (let y = 3; y < im.height; y++) if (far(px(x0, y), band)) { top = y; break }
    const bg = px(x0, top + 8); let radius = 0
    for (let x = 0; x < 300; x++) if (!far(px(x, top + 3), bg)) { radius = x + 6; break }
    let bottom = im.height
    for (let y = im.height - 1; y > top; y -= 2) { const row = g.getImageData(0, y, im.width, 1).data; let hit = false; for (let i = 0; i < row.length; i += 16) if (far([row[i], row[i + 1], row[i + 2]], bg)) { hit = true; break } if (hit) { bottom = y; break } }
    return { top, bottom, radius, bg: `rgb(${bg[0]},${bg[1]},${bg[2]})` }
  }, pathToFileURL(path.join(here, img)).href)
}
console.log('sheets', JSON.stringify(sheets))

for (const p of posters) for (const [size, label, h] of [['sq', 'square', 1080], ['tall', '4x5', 1350]]) {
  if (only && !p.file.includes(only)) continue
  const html = path.join(here, 'pages', `${p.file} ${label}.html`); fs.writeFileSync(html, page(p, size, colours))
  await page_.setViewportSize({ width: 1080, height: h }); await page_.goto(pathToFileURL(html).href); await page_.evaluate(() => document.fonts.ready); await page_.waitForTimeout(150)
  const big = await page_.screenshot({ clip: { x: 0, y: 0, width: 1080, height: h } })
  if (args.includes('--keep2x')) fs.writeFileSync(path.join(out, `${p.file} ${label} @2x.png`), big)
  // Scale the 2x render down to exactly 1080 wide with the browser's own high quality resampling.
  const small = await page_.evaluate(async ({ data, w, h }) => {
    const im = new Image(); im.src = 'data:image/png;base64,' + data; await im.decode()
    const bmp = await createImageBitmap(im, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0)
    return c.toDataURL('image/png').split(',')[1]
  }, { data: big.toString('base64'), w: 1080, h })
  fs.writeFileSync(path.join(out, `${p.file} ${label}.png`), Buffer.from(small, 'base64'))
  console.log(`${p.file} ${label}.png`)
}
// --feed: every poster at 400 px wide on one sheet per size, the way a phone feed shows them, for a look before shipping.
if (args.includes('--feed')) {
  const small = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 }); const sp = await small.newPage()
  await sp.goto(pathToFileURL(path.join(here, 'posters.css')).href)
  fs.mkdirSync(path.join(out, 'feed'), { recursive: true })
  for (const [label, h] of [['square', 400], ['4x5', 500]]) {
    const imgs = posters.map((p) => `<img src="${pathToFileURL(path.join(out, `${p.file} ${label}.png`)).href}" style="width:400px;height:${h}px;display:block">`).join('')
    await sp.setViewportSize({ width: 1600, height: h * Math.ceil(posters.length / 4) })
    await sp.evaluate((html) => { document.documentElement.innerHTML = `<body style="margin:0;display:flex;flex-wrap:wrap;background:#000">${html}</body>` }, imgs); await sp.waitForTimeout(600)
    await sp.screenshot({ path: path.join(out, 'feed', `feed ${label}.png`) })
  }
}
await browser.close()
