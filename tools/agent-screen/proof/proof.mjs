// Proves the Windows screen reader on a real computer, with no Agent app involved:
//   node tools/agent-screen/proof/proof.mjs [--out <folder>] [--skip-native] [--skip-input]
// It starts its own Chrome (a throwaway profile) on a small site it serves itself, and Character Map as the
// native app, and measures: active window, tree, find (cold and warm), watch through scroll and redraw, real
// click and key events, captures, and whether a rectangle lands on the true pixels of the element.
// It closes everything it started. Needs Node 22.18 or newer on Windows; nothing to install.
import './ts-loader.mjs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boxOfColour, decodePng } from './png.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')
const { createScreenReader } = await import(new URL('../../../apps/desktop/src/main/showme/native/index.ts', import.meta.url).href)

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const outDir = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : join(tmpdir(), 'show-me-proof-out')
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = { when: new Date().toISOString(), node: process.version, checks: [], timings: {} }
const check = (name, ok, detail = '') => {
  results.checks.push({ name, ok: Boolean(ok), detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
}
const timed = async (fn) => {
  const t = performance.now()
  const value = await fn()
  return [value, Math.round((performance.now() - t) * 10) / 10]
}
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)]
const until = async (fn, ms = 5000, step = 50) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) return null
    await sleep(step)
  }
}
// Plays real input (send-input.ps1) without blocking this process, so the events can arrive while it runs.
const play = (actions) => process.env.AGENT_PROOF_REAL_INPUT !== '1' ? Promise.reject(new Error('This step sends real mouse and keyboard input. Run it only when nobody is using the PC: set AGENT_PROOF_REAL_INPUT=1.')) : new Promise((done) => spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'send-input.ps1'), '-Actions', actions], { stdio: 'inherit' }).once('exit', done))
// Real input goes wherever the mouse is, so before any is played: is OUR window the one on top at that point?
// If somebody else's window is in the way, the proof stops there instead of clicking into it.
const onTop = async (hwnd, x, y) => {
  const top = (await reader.windows()).find((w) => x >= w.bounds.x && x < w.bounds.x + w.bounds.width && y >= w.bounds.y && y < w.bounds.y + w.bounds.height)
  return top?.hwnd === hwnd
}
const mustBeOnTop = async (hwnd, rect, what) => {
  for (const [x, y] of [[rect.x + 2, rect.y + 2], [rect.x + rect.width - 3, rect.y + rect.height - 3], [rect.x + Math.round(rect.width / 2), rect.y + Math.round(rect.height / 2)]]) {
    if (!(await onTop(hwnd, x, y))) throw new Error(`Another window covers the ${what}. Nothing was clicked. Run the proof again when that part of the screen is free.`)
  }
}
const fmt = (r) => (r === null || r === undefined ? 'null' : `${r.x},${r.y} ${r.width}x${r.height}`)

const reader = createScreenReader({ lookup: { dirs: [repo] }, keys: ['Escape', 'Enter', 'Tab'] })
const started = []
const cleanup = []
let failed = null

try {
  check('the helper is found and answers', await reader.available(), reader.unavailableReason() ?? '')
  const monitors = await reader.monitors()
  results.monitors = monitors
  console.log('monitors', JSON.stringify(monitors))
  const idle = await reader.idleMs()
  console.log(`the person has been idle for ${Math.round(idle / 1000)} s`)
  results.idleAtStartMs = idle

  // ---- the site ----
  const page = readFileSync(join(here, 'site', 'index.html'))
  const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page))
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  cleanup.push(() => server.close())
  const site = `http://127.0.0.1:${server.address().port}/`

  // ---- Chrome, its own profile ----
  const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => p && existsSync(p))
  if (!chromePath) throw new Error('No Chrome or Edge found; set CHROME_PATH.')
  const profile = mkdtempSync(join(tmpdir(), 'show-me-chrome-'))
  const primary = monitors.find((m) => m.primary) ?? monitors[0]
  const scale = primary.scale
  // Aside, at the left of the primary screen.
  const winW = 820, winH = 720
  const winX = 10, winY = 10
  const chrome = spawn(chromePath, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--remote-debugging-port=0',
    `--window-position=${winX},${winY}`, `--window-size=${winW},${winH}`, '--new-window', `${site}#/home`], { stdio: 'ignore' })
  started.push(chrome.pid)
  cleanup.push(async () => {
    try { await cdp('Browser.close') } catch { /* closed */ }
    await sleep(800)
    if (chrome.exitCode === null) try { process.kill(chrome.pid) } catch { /* gone */ }
    await sleep(500)
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* Chrome still letting go */ }
  })

  // The page, over the DevTools protocol: to scroll and redraw it and to read its state, never to click for the hooks.
  const portFile = join(profile, 'DevToolsActivePort')
  await until(() => existsSync(portFile), 15000)
  const port = readFileSync(portFile, 'utf8').split('\n')[0].trim()
  const target = await until(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      return list.find((t) => t.type === 'page' && t.url.startsWith(site))
    } catch { return null }
  }, 15000, 200)
  if (!target) throw new Error('Chrome did not open the proof site.')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r, j) => { socket.onopen = r; socket.onerror = j })
  let cdpId = 0
  const cdpWait = new Map()
  socket.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && cdpWait.has(msg.id)) { cdpWait.get(msg.id)(msg); cdpWait.delete(msg.id) } }
  const cdp = (method, params = {}) => new Promise((r) => { const id = ++cdpId; cdpWait.set(id, r); socket.send(JSON.stringify({ id, method, params })) })
  const js = async (expression) => (await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value

  const chromeWin = await until(async () => (await reader.windows()).find((w) => w.title.includes('Show me proof site')), 15000, 200)
  check('Chrome window is listed', chromeWin, chromeWin ? `${chromeWin.hwnd} ${chromeWin.process} at ${fmt(chromeWin.bounds)}` : '')
  const hwnd = chromeWin.hwnd
  results.chrome = { window: chromeWin, dpr: await js('devicePixelRatio') }

  // ---- reading ----
  const [treeCold, treeColdMs] = await timed(() => reader.tree(hwnd))
  results.timings.chromeTreeColdMs = treeColdMs
  check('Chrome: first tree fills with the page (accessibility wakes by itself)', treeCold.some((n) => n.name === 'Probe target'), `${treeCold.length} elements in ${treeColdMs} ms`)
  const warm = []
  let tree = treeCold
  for (let i = 0; i < 5; i++) { const [t, ms] = await timed(() => reader.tree(hwnd)); warm.push(ms); tree = t }
  results.timings.chromeTreeWarmMs = median(warm)
  results.chrome.treeSize = tree.length
  console.log(`Chrome tree warm: ${tree.length} elements, median ${median(warm)} ms of ${warm.join(', ')}`)
  console.log(tree.map((n) => `  ${n.role.padEnd(9)} ${JSON.stringify(n.name)} ${fmt(n.bounds)}  [${n.path}]`).join('\n'))

  const [active, activeMs] = await timed(() => reader.window(hwnd))
  const urlWarm = []
  for (let i = 0; i < 5; i++) urlWarm.push((await timed(() => reader.window(hwnd)))[1])
  results.timings.windowWithUrlFirstMs = activeMs
  results.timings.windowWithUrlWarmMs = median(urlWarm)
  check('Chrome: the address is read from the address bar', active?.url === `${site}#/home`, `${active?.url} first ${activeMs} ms, then ${median(urlWarm)} ms`)

  const [probeCold, findColdMs] = await timed(() => reader.find(hwnd, { name: 'Probe target' }))
  const findWarm = []
  for (let i = 0; i < 10; i++) findWarm.push((await timed(() => reader.find(hwnd, { name: 'Probe target' })))[1])
  results.timings.chromeFindFirstMs = findColdMs
  results.timings.chromeFindWarmMs = median(findWarm)
  check('Chrome: find by exact name', probeCold?.role === 'button', `first ${findColdMs} ms, warm median ${median(findWarm)} ms (${findWarm.join(', ')})`)
  const [link, linkMs] = await timed(() => reader.find(hwnd, { name: 'Go to pixels', role: 'link' }))
  check('Chrome: find a link by name and role', link?.role === 'link', `${linkMs} ms at ${fmt(link?.bounds)}`)
  const [loose, looseMs] = await timed(() => reader.find(hwnd, { name: 'go to pix' }))
  results.timings.chromeFindLooseMs = looseMs
  check('Chrome: find by part of a name (the slow road)', loose?.name === 'Go to pixels', `${looseMs} ms`)
  const [none, noneMs] = await timed(() => reader.find(hwnd, { name: 'No such thing here' }))
  check('Chrome: a name that is not there gives null', none === null, `${noneMs} ms`)
  const [deep, deepMs] = await timed(() => reader.find(hwnd, { name: 'Deep button' }))
  check('Chrome: an element far down the page is found and marked off screen', deep !== null && deep.offscreen === true, `${deepMs} ms`)

  // ---- do the rectangles land on the true pixels? ----
  await mustBeOnTop(hwnd, (await reader.find(hwnd, { name: 'Probe target' })).bounds, 'test page')
  const [shot, shotMs] = await timed(() => reader.capture({ displayId: 0 }))
  results.timings.captureDisplayMs = shotMs
  writeFileSync(join(outDir, 'screen.png'), shot)
  const png = decodePng(shot)
  const box = boxOfColour(png, [255, 0, 170])
  const truth = box === null ? null : { x: box.x + primary.bounds.x, y: box.y + primary.bounds.y, width: box.width, height: box.height }
  const probe = await reader.find(hwnd, { name: 'Probe target' })
  const off = truth === null || probe === null ? null : { dx: probe.bounds.x - truth.x, dy: probe.bounds.y - truth.y, dw: probe.bounds.width - truth.width, dh: probe.bounds.height - truth.height }
  results.pixelProof = { scale, reported: probe?.bounds, truePixels: truth, difference: off, cssSize: '173x41' }
  check(`rectangle is within 2 px of the element's true pixels at ${scale * 100}% (the browser rounds its own numbers)`, off !== null && Math.max(Math.abs(off.dx), Math.abs(off.dy), Math.abs(off.dw), Math.abs(off.dh)) <= 2,
    `reported ${fmt(probe?.bounds)}, pixels of its colour in a screenshot ${fmt(truth)}, difference ${JSON.stringify(off)}`)
  check('capture of the display', png.width === primary.bounds.width && png.height === primary.bounds.height, `${png.width}x${png.height}, ${shot.length} bytes, ${shotMs} ms`)
  const [winShot, winShotMs] = await timed(() => reader.capture({ hwnd }))
  results.timings.captureWindowMs = winShotMs
  writeFileSync(join(outDir, 'chrome-window.png'), winShot)
  const winPng = decodePng(winShot)
  check('capture of the Chrome window', winPng.width === chromeWin.bounds.width && boxOfColour(winPng, [255, 0, 170]) !== null, `${winPng.width}x${winPng.height}, ${winShot.length} bytes, ${winShotMs} ms`)

  // ---- following: scroll ----
  const moves = []
  let stop = reader.watch(hwnd, probe, (r) => moves.push({ r, at: performance.now() }))
  await until(() => moves.length > 0, 3000, 10)
  check('watch: the first rectangle arrives', moves.length > 0 && moves[0].r !== null, fmt(moves[0]?.r))
  const before = moves.length
  const dpr = results.chrome.dpr
  let t0 = performance.now()
  await js('scrollBy(0, 40)')
  const scrolled = await until(() => moves.length > before && moves.at(-1).r && moves.at(-1).r.y === probe.bounds.y - Math.round(40 * dpr), 3000, 5)
  const scrollMs = Math.round(moves.at(-1).at - t0)
  results.timings.watchFollowsScrollMs = scrollMs
  check('watch: follows a scroll', scrolled, `moved by ${moves.at(-1).r ? moves.at(-1).r.y - probe.bounds.y : '?'} px for a 40 CSS px scroll at ${dpr}, ${scrollMs} ms after the scroll`)
  // A run of small scrolls, like a mouse wheel: how far behind is the rectangle while it moves, and when it stops?
  const lags = []
  for (let i = 1; i <= 12; i++) {
    const at = performance.now()
    await js('scrollBy(0, 8)')
    const wantY = probe.bounds.y - Math.round((40 + 8 * i) * dpr)
    const ok = await until(() => moves.at(-1).r && Math.abs(moves.at(-1).r.y - wantY) <= 1, 1500, 2)
    lags.push(ok ? Math.round(moves.at(-1).at - at) : -1)
  }
  results.timings.watchSmallScrollLagMs = lags
  check('watch: keeps up with a run of small scrolls', lags.every((l) => l >= 0), `each step caught up after ${lags.join(', ')} ms`)
  t0 = performance.now()
  await js('scrollTo(0, 900)')
  const hid = await until(() => moves.at(-1).r === null, 3000, 5)
  check('watch: scrolled out of view gives null', hid, `${Math.round(moves.at(-1).at - t0)} ms`)
  t0 = performance.now()
  await js('scrollTo(0, 0)')
  const back = await until(() => moves.at(-1).r !== null && moves.at(-1).r.y === probe.bounds.y, 3000, 5)
  check('watch: scrolled back gives the rectangle again', back, `${Math.round(moves.at(-1).at - t0)} ms`)
  stop()

  // ---- following: a page that draws itself again ----
  await js("location.hash = '#/settings'")
  const mover = await until(() => reader.find(hwnd, { name: 'Moving button' }), 3000, 30)
  const redraws = []
  stop = reader.watch(hwnd, mover, (r) => redraws.push({ r, at: performance.now() }))
  await until(() => redraws.length > 0, 3000, 10)
  t0 = performance.now()
  await js('redraw()')
  const want = mover.bounds.x + Math.round(60 * dpr)
  const refound = await until(() => redraws.at(-1).r !== null && Math.abs(redraws.at(-1).r.x - want) <= 1, 5000, 5)
  results.timings.watchFollowsRedrawMs = Math.round(redraws.at(-1).at - t0)
  check('watch: follows an element the page made anew in another place', refound, `x ${mover.bounds.x} to ${redraws.at(-1).r?.x} (wanted ${want}), ${results.timings.watchFollowsRedrawMs} ms, events: ${redraws.map((m) => (m.r ? m.r.x : 'null')).join(' ')}`)
  stop()

  // ---- a five-step walk, the way the engine will do it: after each step, how soon is the next target known? ----
  const walk = []
  const step = async (label, q, act) => {
    const t = performance.now()
    const node = await until(() => reader.find(hwnd, q), 4000, 15)
    const ms = Math.round(performance.now() - t)
    walk.push({ label, ms, found: node !== null, bounds: node?.bounds, role: node?.role })
    if (node !== null && act) await js(act)
    return node
  }
  await step('Pixels in the top bar', { name: 'Pixels', role: 'link' }, "document.getElementById('nav-pixels').click()")
  await step('Create pixel', { name: 'Create pixel', role: 'button' }, "document.getElementById('create').click()")
  await step('Pixel name', { name: 'Pixel name', role: 'textbox' }, "(() => { const i = document.getElementById('pname'); i.focus(); i.value = 'Winter sale'; i.dispatchEvent(new Event('input', { bubbles: true })) })()")
  const kind = await step('Pixel kind', { name: 'Pixel kind', role: 'combobox' }, "(() => { const s = document.getElementById('kind'); s.value = 'App'; s.dispatchEvent(new Event('input', { bubbles: true })) })()")
  await step('Growth in the plan list', { name: 'Growth', role: 'option' }, "document.querySelector('[data-plan=Growth]').click()")
  await step('Send test events', { name: 'Send test events', role: 'checkbox' }, "document.getElementById('agree').click()")
  await step('Save pixel', { name: 'Save pixel', role: 'button' }, "document.getElementById('save').click()")
  await step('Delete Winter sale (made by the save)', { name: 'Delete Winter sale', role: 'button' })
  results.walk = walk
  results.timings.walkNextTargetMs = walk.map((w) => w.ms)
  check('Chrome: an eight-step walk finds every next target', walk.every((w) => w.found), walk.map((w) => `${w.label} ${w.ms} ms`).join('; '))
  check('Chrome: the dropdown is a combobox with a value', kind?.role === 'combobox', `value ${JSON.stringify(kind?.value)}`)
  await js("document.getElementById('create').click()")
  const form = await until(async () => { const t = await reader.tree(hwnd); return t.some((n) => n.name === 'Secret key') ? t : null }, 3000, 30)
  const secret = form?.find((n) => n.name === 'Secret key')
  const named = form?.find((n) => n.name === 'Pixel name')
  check('a password field never has a value', secret !== undefined && secret.value === undefined && !JSON.stringify(form).includes('hunter2'), `Secret key: value ${JSON.stringify(secret?.value)}; Pixel name next to it: ${JSON.stringify(named?.value ?? '')}`)

  // ---- his clicks and keys ----
  if (!flag('--skip-input')) {
    await js("location.hash = '#/home'")
    await js('scrollTo(0, 0)')
    const target = await until(() => reader.find(hwnd, { name: 'Probe target' }), 3000, 30)
    const cx = target.bounds.x + Math.round(target.bounds.width / 2), cy = target.bounds.y + Math.round(target.bounds.height / 2)
    const events = []
    const off2 = reader.onInput((e) => events.push({ ...e, got: Date.now() }))
    await until(async () => (await rawHello()).hooks === true, 2000, 20)
    check('hooks are on only while someone listens (on)', (await rawHello()).hooks === true)
    await mustBeOnTop(hwnd, target.bounds, 'test page')
    await play(`click:${cx},${cy}`)
    // Keys go to whatever is in front: only once the click has made that our own window.
    if ((await reader.activeWindow())?.hwnd !== hwnd) throw new Error('The test window did not come to the front after the click. No keys were sent.')
    await play('key:Escape;key:a;paste;key:Tab')
    await sleep(400)
    const click = events.find((e) => e.kind === 'click')
    const state = await js('JSON.stringify(proofState)').then(JSON.parse)
    results.input = { sent: { x: cx, y: cy }, events: events.map((e) => ({ ...e, window: e.window ? { title: e.window.title, process: e.window.process } : undefined })), page: { clicks: state.clicks, lastClick: state.lastClick } }
    check('a real click arrives with the right coordinates', click && click.x === cx && click.y === cy && click.button === 'left', `sent ${cx},${cy} got ${click?.x},${click?.y}`)
    check('the click reached the page untouched (nothing is swallowed)', state.clicks === 1, `page counted ${state.clicks}; page saw it at CSS ${state.lastClick?.x},${state.lastClick?.y} = ${Math.round((state.lastClick?.x ?? 0) * dpr)},${Math.round((state.lastClick?.y ?? 0) * dpr)} px`)
    const lat = events.filter((e) => e.kind !== 'foreground').map((e) => e.got - e.time)
    results.timings.inputEventLatencyMs = lat
    check('events arrive fast', lat.length > 0 && Math.max(...lat) < 50, `hook to listener: ${lat.join(', ')} ms`)
    const keysSeen = events.filter((e) => e.kind === 'key').map((e) => e.key)
    check('only the named keys are reported: Escape and Tab yes, the letter A no', keysSeen.includes('Escape') && keysSeen.includes('Tab') && keysSeen.length === 2 && !JSON.stringify(events).toLowerCase().includes('"a"'), keysSeen.join(', '))
    check('Ctrl+V arrives as paste', events.some((e) => e.kind === 'paste'))
    // The wheel over a browser: the ring must not sit in the old place for the half second the browser takes to say where things went.
    const wheelMoves = []
    const wheels = []
    const offWheel = reader.onScroll((e) => wheels.push({ ...e, got: performance.now() }))
    const stopWheel = reader.watch(hwnd, target, (r) => wheelMoves.push({ r, at: performance.now() }))
    await until(() => wheelMoves.length > 0, 3000, 10)
    await mustBeOnTop(hwnd, { x: cx - 5, y: cy + 195, width: 10, height: 10 }, 'test page')
    await play(`wheel:${cx},${cy + 200},-1`)
    const rested = await until(() => wheelMoves.some((m) => m.r === null), 1500, 5)
    const cameBack = await until(() => wheelMoves.at(-1).r !== null && wheelMoves.at(-1).r.y !== target.bounds.y, 3000, 10)
    const wheelAt = wheels[0]?.got ?? 0
    const nullAt = wheelMoves.find((m) => m.r === null)?.at ?? 0
    results.timings.wheelRingRestsAfterMs = Math.round(nullAt - wheelAt)
    results.timings.wheelRingBackAfterMs = Math.round(wheelMoves.at(-1).at - wheelAt)
    check('wheel over a browser: the rectangle rests at once and comes back in the new place', wheels.length > 0 && rested && cameBack, `null ${Math.round(nullAt - wheelAt)} ms after the wheel, back ${Math.round(wheelMoves.at(-1).at - wheelAt)} ms after it, moved ${wheelMoves.at(-1).r ? wheelMoves.at(-1).r.y - target.bounds.y : '?'} px; events: ${wheelMoves.map((m) => (m.r ? m.r.y : 'null')).join(' ')}`)
    stopWheel()
    offWheel()
    if (await onTop(hwnd, cx, cy + 200)) await play(`wheel:${cx},${cy + 200},3`)
    off2()
    await until(async () => (await rawHello()).hooks === false, 2000, 20)
    check('hooks are on only while someone listens (off again)', (await rawHello()).hooks === false)
    const [aw, awMs] = await timed(() => reader.activeWindow())
    const awWarm = []
    for (let i = 0; i < 5; i++) awWarm.push((await timed(() => reader.activeWindow()))[1])
    results.timings.activeWindowMs = median(awWarm)
    check('activeWindow is the Chrome window he clicked in', aw?.hwnd === hwnd, `${aw?.process} "${aw?.title}" ${aw?.url ?? ''} first ${awMs} ms, then ${median(awWarm)} ms`)
  }

  // ---- a native app: Character Map ----
  if (!flag('--skip-native')) {
    // Listening from before it opens: it comes to the front either when it opens or when it is clicked.
    const fronts = []
    const offFront = reader.onInput((e) => { if (e.kind === 'foreground') fronts.push(e) })
    cleanup.push(offFront)
    await until(async () => (await rawHello()).hooks === true, 2000, 20)
    const charmap = spawn('charmap.exe', [], { stdio: 'ignore' })
    started.push(charmap.pid)
    cleanup.push(() => { if (charmap.exitCode === null) try { process.kill(charmap.pid) } catch { /* gone */ } })
    const win = await until(async () => (await reader.windows()).find((w) => w.pid === charmap.pid), 8000, 100)
    check('native app window is listed', win, win ? `${win.process} "${win.title}" at ${fmt(win.bounds)}` : '')
    const [nTree, nTreeColdMs] = await timed(() => reader.tree(win.hwnd))
    const nWarm = []
    for (let i = 0; i < 5; i++) nWarm.push((await timed(() => reader.tree(win.hwnd)))[1])
    results.timings.nativeTreeColdMs = nTreeColdMs
    results.timings.nativeTreeWarmMs = median(nWarm)
    results.native = { window: win, treeSize: nTree.length }
    console.log(nTree.slice(0, 40).map((n) => `  ${n.role.padEnd(9)} ${JSON.stringify(n.name)} ${fmt(n.bounds)}  [${n.path}]`).join('\n'))
    check('native: tree', nTree.length > 5, `${nTree.length} elements, first ${nTreeColdMs} ms, warm median ${median(nWarm)} ms`)
    const [select, nFindColdMs] = await timed(() => reader.find(win.hwnd, { name: 'Select', role: 'button' }))
    const nFindWarm = []
    for (let i = 0; i < 10; i++) nFindWarm.push((await timed(() => reader.find(win.hwnd, { name: 'Select', role: 'button' })))[1])
    results.timings.nativeFindFirstMs = nFindColdMs
    results.timings.nativeFindWarmMs = median(nFindWarm)
    check('native: find a button', select?.role === 'button', `first ${nFindColdMs} ms, warm median ${median(nFindWarm)} ms at ${fmt(select?.bounds)}`)
    const font = await reader.find(win.hwnd, { name: 'Font', role: 'combobox' })
    check('native: find the dropdown', font !== null, `${font?.role} value ${JSON.stringify(font?.value)}`)
    const box2 = await reader.find(win.hwnd, { name: 'Advanced view', role: 'checkbox' })
    check('native: find the checkbox', box2 !== null, fmt(box2?.bounds))
    const nMoves = []
    const nStop = reader.watch(win.hwnd, select, (r) => nMoves.push({ r, at: performance.now() }))
    await until(() => nMoves.length > 0, 3000, 10)
    // Beside our own browser window, not under it.
    const nx = chromeWin.bounds.x + chromeWin.bounds.width + 12, ny = win.bounds.y + 50
    await play(`move:${win.hwnd},${nx},${ny}`)
    const moved = await until(() => nMoves.at(-1).r && nMoves.at(-1).r.x !== select.bounds.x, 3000, 10)
    const after = await reader.window(win.hwnd)
    const dx = after.bounds.x - win.bounds.x, dy = after.bounds.y - win.bounds.y
    check('native: watch follows the window when it moves', moved && nMoves.at(-1).r.x - select.bounds.x === dx && nMoves.at(-1).r.y - select.bounds.y === dy, `window moved ${dx},${dy}; button moved ${nMoves.at(-1).r ? `${nMoves.at(-1).r.x - select.bounds.x},${nMoves.at(-1).r.y - select.bounds.y}` : 'null'}`)
    nStop()
    if (!flag('--skip-input')) {
      const copy = await reader.find(win.hwnd, { name: 'Advanced view', role: 'checkbox' })
      const cx = copy.bounds.x + 8, cy = copy.bounds.y + Math.round(copy.bounds.height / 2)
      const events = []
      const offN = reader.onInput((e) => events.push({ ...e, got: Date.now() }))
      await until(async () => (await rawHello()).hooks === true, 2000, 20)
      await mustBeOnTop(win.hwnd, { x: cx - 4, y: cy - 4, width: 8, height: 8 }, 'Character Map window')
      await play(`click:${cx},${cy}`)
      await sleep(300)
      offN()
      const click = events.find((e) => e.kind === 'click')
      results.timings.nativeClickLatencyMs = click ? click.got - click.time : null
      check('a window coming to the front arrives as foreground', fronts.some((e) => e.window.hwnd === win.hwnd), fronts.map((e) => `${e.window.process} "${e.window.title}"`).join(' | '))
      check('native: a real click arrives with the right coordinates', click && click.x === cx && click.y === cy, `sent ${cx},${cy} got ${click?.x},${click?.y}, ${click ? click.got - click.time : '?'} ms`)
    }
    const [nShot, nShotMs] = await timed(() => reader.capture({ hwnd: win.hwnd }))
    writeFileSync(join(outDir, 'native-window.png'), nShot)
    const nPng = decodePng(nShot)
    check('native: capture of the window', nPng.width === after.bounds.width, `${nPng.width}x${nPng.height}, ${nShot.length} bytes, ${nShotMs} ms`)
  }
} catch (error) {
  failed = error
  console.error(error)
} finally {
  for (const fn of cleanup.reverse()) { try { await fn() } catch { /* best effort */ } }
  reader.dispose()
}

function rawHello() {
  // The helper's own word on whether its hooks exist.
  return reader.helperState().then((state) => state ?? { hooks: null })
}

results.failed = failed === null ? null : String(failed)
const bad = results.checks.filter((c) => !c.ok)
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
console.log(`\n${results.checks.length - bad.length} of ${results.checks.length} checks passed. Timings: ${JSON.stringify(results.timings)}`)
console.log(`Results and pictures: ${outDir}`)
process.exit(bad.length === 0 && failed === null ? 0 : 1)
