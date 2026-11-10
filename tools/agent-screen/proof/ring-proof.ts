// Proves, in a bare Electron (not the Agent app), that the ring the app draws lands on the element the screen
// reader found, and that it is on the screen but not in a capture:
//
//   npx esbuild tools/agent-screen/proof/ring-proof.ts --bundle --platform=node --format=cjs --external:electron --outfile=<tmp>/ring-proof.cjs
//   npx electron <tmp>/ring-proof.cjs --out <folder>
//
// It uses the app's own pieces end to end: the screen reader (main/showme/native), the engine's pixel-to-DIP
// conversion and adapter (main/showme/coords.ts, overlay-adapter.ts), and the shared overlay (main/overlay) with
// the app's capture privacy. It opens its own Chrome with a throwaway profile, and closes everything after.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { app, desktopCapturer, screen } from 'electron'

import { CapturePrivacy } from '../../../apps/desktop/src/main/capture-privacy'
import { createGuideOverlay } from '../../../apps/desktop/src/main/overlay/overlay-window'
import { displaysOf } from '../../../apps/desktop/src/main/showme/coords'
import { createScreenReader } from '../../../apps/desktop/src/main/showme/native'
import { walkOverlay } from '../../../apps/desktop/src/main/showme/overlay-adapter'
import type { Rect } from '../../../apps/desktop/src/main/showme/screen'
import { brandLook } from '../../../apps/desktop/src/shared/brand'
// @ts-expect-error a plain script shared with proof.mjs
import { boxOfColour, decodePng } from './png.mjs'

interface Png { width: number; height: number; channels: number; pixels: Buffer }

const args = process.argv.slice(2)
const repo = resolve(args.includes('--repo') ? String(args[args.indexOf('--repo') + 1]) : process.cwd())
const outDir = resolve(args.includes('--out') ? String(args[args.indexOf('--out') + 1]) : join(tmpdir(), 'show-me-ring-proof'))
mkdirSync(outDir, { recursive: true })
// Its own data folder: this is not the Agent app and must not touch its files.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'show-me-ring-electron-')))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async <T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 8000, step = 60): Promise<T | null> => {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) return null
    await sleep(step)
  }
}
const checks: Array<{ name: string; ok: boolean; detail: string }> = []
const check = (name: string, ok: unknown, detail = ''): void => {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  (${detail})`}`)
}
const fmt = (r: Rect | null | undefined): string => (r ? `${r.x},${r.y} ${r.width}x${r.height}` : 'null')

/** How many pixels differ between two pictures inside a box, and the first differing pixel walking out from each edge of `inner`. */
function differ(a: Png, b: Png, x: number, y: number): boolean {
  const i = (y * a.width + x) * a.channels
  const j = (y * b.width + x) * b.channels
  return Math.abs(a.pixels[i]! - b.pixels[j]!) + Math.abs(a.pixels[i + 1]! - b.pixels[j + 1]!) + Math.abs(a.pixels[i + 2]! - b.pixels[j + 2]!) > 24
}
function countDiff(a: Png, b: Png, box: Rect): number {
  let n = 0
  for (let y = Math.max(0, box.y); y < Math.min(a.height, box.y + box.height); y++) {
    for (let x = Math.max(0, box.x); x < Math.min(a.width, box.x + box.width); x++) if (differ(a, b, x, y)) n++
  }
  return n
}
/** From each edge of the element, straight out through its middle: how far to the ring's first pixel, and how thick it is. */
function ringAround(withRing: Png, without: Png, el: Rect): { left: number; right: number; top: number; bottom: number; stroke: number } | null {
  const cx = Math.round(el.x + el.width / 2)
  const cy = Math.round(el.y + el.height / 2)
  const walk = (x0: number, y0: number, dx: number, dy: number): { gap: number; stroke: number } | null => {
    let gap = -1
    let stroke = 0
    for (let d = 0; d < 60; d++) {
      const x = x0 + dx * d
      const y = y0 + dy * d
      if (x < 0 || y < 0 || x >= withRing.width || y >= withRing.height) break
      const on = differ(withRing, without, x, y)
      if (on && gap < 0) gap = d
      if (on) stroke++
      else if (gap >= 0) break
    }
    return gap < 0 ? null : { gap, stroke }
  }
  const l = walk(el.x - 1, cy, -1, 0)
  const r = walk(el.x + el.width, cy, 1, 0)
  const t = walk(cx, el.y - 1, 0, -1)
  const b = walk(cx, el.y + el.height, 0, 1)
  if (l === null || r === null || t === null || b === null) return null
  return { left: l.gap, right: r.gap, top: t.gap, bottom: b.gap, stroke: Math.round((l.stroke + r.stroke + t.stroke + b.stroke) / 4) }
}

async function main(): Promise<number> {
  const cleanup: Array<() => unknown> = []
  const reader = createScreenReader({ lookup: { dirs: [repo] } })
  cleanup.push(() => reader.dispose())
  try {
    check('the helper is found and answers', await reader.available(), reader.unavailableReason() ?? '')
    const primary = screen.getPrimaryDisplay()
    const displays = displaysOf(screen)
    console.log('displays', JSON.stringify(displays))

    const page = readFileSync(join(repo, 'tools', 'agent-screen', 'proof', 'site', 'index.html'))
    const server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    cleanup.push(() => server.close())
    const site = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`

    const chromePath = [process.env['CHROME_PATH'], 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => p !== undefined && existsSync(p))
    if (chromePath === undefined) throw new Error('No Chrome or Edge found; set CHROME_PATH.')
    const profile = mkdtempSync(join(tmpdir(), 'show-me-ring-chrome-'))
    const winW = 820
    const chrome = spawn(chromePath, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', `--window-position=${Math.max(0, primary.workArea.width - winW - 10)},10`, `--window-size=${winW},720`, '--new-window', `${site}#/home`], { stdio: 'ignore' })
    cleanup.push(async () => {
      if (chrome.exitCode === null && chrome.pid !== undefined) try { process.kill(chrome.pid) } catch { /* gone */ }
      await sleep(800)
      try { rmSync(profile, { recursive: true, force: true }) } catch { /* still letting go */ }
    })
    const win = await until(async () => (await reader.windows()).find((w) => w.title.includes('Show me proof site')), 15000, 200)
    if (win === null) throw new Error('Chrome did not open the proof site.')
    const node = await until(() => reader.find(win.hwnd, { name: 'Probe target', role: 'button' }), 8000, 100)
    check('the reader finds the button in Chrome', node !== null, `${fmt(node?.bounds)} physical pixels, screen scale ${primary.scaleFactor}`)
    if (node === null) throw new Error('no target')

    // The app's own overlay, with the app's own privacy rule, driven through the engine's adapter.
    let hideFromCapture = true
    const privacy = new CapturePrivacy(() => ({ hideGuidesFromCapture: hideFromCapture, hideChatFromCapture: false }))
    const overlay = createGuideOverlay({ privacy })
    cleanup.push(() => overlay.destroyAll())
    const ring = walkOverlay(overlay, () => displaysOf(screen), () => brandLook({ theme: 'light' }))
    const display = displays.find((d) => d.id === primary.id) ?? displays[0]!
    const grabGdi = async (name: string): Promise<Png> => {
      const png = await reader.capture({ displayId: primary.id })
      writeFileSync(join(outDir, `${name}-gdi.png`), png)
      return decodePng(png) as Png
    }
    const grabElectron = async (name: string): Promise<Png> => {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.pixel.width, height: display.pixel.height } })
      const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]!
      const png = source.thumbnail.toPNG()
      writeFileSync(join(outDir, `${name}-desktopcapturer.png`), png)
      return decodePng(png) as Png
    }

    // 1. No ring at all: what the screen looks like, and where the button's own pixels are.
    const bareGdi = await grabGdi('1-no-ring')
    const bareEl = await grabElectron('1-no-ring')
    const box = boxOfColour(bareGdi, [255, 0, 170]) as (Rect & { count: number }) | null
    if (box === null) throw new Error('the button is not on the screen')
    const truth: Rect = { x: box.x, y: box.y, width: box.width, height: box.height }
    // Compared only inside the browser window: whatever is behind it is somebody else's moving picture.
    const inside = { left: win.bounds.x + 12 - display.pixel.x, right: win.bounds.x + win.bounds.width - 12 - display.pixel.x }
    const left = Math.max(truth.x - 40, inside.left)
    const around: Rect = { x: left, y: truth.y - 40, width: Math.min(truth.x + truth.width + 40, inside.right) - left, height: truth.height + 80 }

    // 2. The ring, hidden from capture (the default).
    ring.show({ rect: node.bounds, label: 'Press the pink button', step: 1, of: 5 })
    await until(() => overlay.state().shown && overlay.state().windows > 0, 3000, 30)
    await sleep(900)
    const shown = overlay.state()
    check('the overlay is showing and says it is hidden from capture', shown.shown && shown.protected, JSON.stringify(shown))
    const hiddenGdi = await grabGdi('2-ring-hidden-from-capture')
    const hiddenEl = await grabElectron('2-ring-hidden-from-capture')
    const leakGdi = countDiff(hiddenGdi, bareGdi, around)
    const leakEl = countDiff(hiddenEl, bareEl, around)
    check('ring ABSENT in a GDI screen capture (BitBlt, what the helper and older recorders use)', leakGdi === 0, `${leakGdi} pixels differ from the screen with no ring, around the button`)
    check('ring ABSENT in an Electron desktopCapturer screen capture (what screen sharing in Chromium apps uses)', leakEl === 0, `${leakEl} pixels differ`)

    // 3. The same ring with the setting off: now a capture is what the eye sees, so it shows where the ring really is.
    hideFromCapture = false
    privacy.apply()
    await sleep(700)
    check('with the setting off the overlay says it is not hidden', overlay.state().protected === false, JSON.stringify(overlay.state()))
    const seenGdi = await grabGdi('3-ring-visible')
    const seenEl = await grabElectron('3-ring-visible')
    const drawnGdi = countDiff(seenGdi, bareGdi, around)
    const drawnEl = countDiff(seenEl, bareEl, around)
    check('the ring IS on the screen (same window, same place, setting off)', drawnGdi > 200 && drawnEl > 200, `${drawnGdi} pixels (GDI), ${drawnEl} pixels (desktopCapturer) differ around the button`)
    const gaps = ringAround(seenGdi, bareGdi, truth)
    const even = gaps !== null && Math.abs(gaps.left - gaps.right) <= 3 && Math.abs(gaps.top - gaps.bottom) <= 3
    check(`the ring hugs the button's true pixels on all four sides at ${primary.scaleFactor * 100}%`, even, gaps === null ? 'no ring found next to the button' : `gap from the button's pixels to the ring: left ${gaps.left}, right ${gaps.right}, top ${gaps.top}, bottom ${gaps.bottom} px; ring ${gaps.stroke} px thick; button pixels ${fmt(truth)}, reader said ${fmt(node.bounds)}`)

    // 4. Hidden again, live, without making the window anew.
    hideFromCapture = true
    privacy.apply()
    await sleep(700)
    const againGdi = await grabGdi('4-ring-hidden-again')
    check('switching the setting back hides it from capture again', overlay.state().protected && countDiff(againGdi, bareGdi, around) === 0, JSON.stringify(overlay.state()))

    ring.hide()
    await sleep(200)
    writeFileSync(join(outDir, 'ring-results.json'), JSON.stringify({ when: new Date().toISOString(), scale: primary.scaleFactor, reader: node.bounds, truePixels: truth, gaps, leakGdi, leakEl, drawnGdi, drawnEl, checks }, null, 2))
  } catch (error) {
    console.error(error)
    check('the proof ran to the end', false, String(error))
  } finally {
    for (const fn of cleanup.reverse()) {
      try {
        await fn()
      } catch {
        // best effort
      }
    }
  }
  const bad = checks.filter((c) => !c.ok)
  console.log(`\n${checks.length - bad.length} of ${checks.length} checks passed. Pictures: ${outDir}`)
  return bad.length === 0 ? 0 : 1
}

void app.whenReady().then(async () => {
  const code = await main()
  app.exit(code)
})
