// Draws the Agent mascot once as SVG, rasterises it in the Chromium already on this machine, and
// writes build/icon.png (1024), build/icon.ico and build/icon.icns. No image libraries are needed:
// ICO and ICNS are simple containers around PNG images, and both packers are implemented below.
//
// Usage: node scripts/make-icons.mjs
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = path.join(root, 'apps/desktop/build')
const pngDir = path.join(buildDir, 'icons')
fs.mkdirSync(pngDir, { recursive: true })

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const base = path.join(os.homedir(), '.cache/ms-playwright')
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith('chromium')).sort().reverse() : []
  for (const dir of dirs) {
    for (const rel of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = path.join(base, dir, rel)
      if (fs.existsSync(candidate)) return candidate
    }
  }
  throw new Error('No Chromium found. Set CHROME_PATH to a Chromium binary.')
}

async function loadPlaywright() {
  try {
    return await import('playwright-core')
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
    return import(pathToFileURL(path.join(globalRoot, 'playwright-core/index.js')).href)
  }
}

/** The scout mascot from design/mockup.html, drawn as a static path. */
// The phone app's default launcher icon (res/drawable/ic_fg_scout_iris.xml on an icon_bg_iris background), so the
// desktop app carries the same face: the scout sidekick in iris with light eyes, on the iris container colour.
const SCOUT = 'M54.00,24.85 C56.19,24.85 58.38,25.64 60.11,27.21 C61.88,28.81 64.20,29.65 66.58,29.56 C71.26,29.38 75.31,32.78 75.94,37.42 C76.26,39.78 77.50,41.92 79.38,43.38 C83.08,46.25 84.00,51.45 81.50,55.42 C80.23,57.43 79.81,59.86 80.31,62.19 C81.30,66.77 78.66,71.35 74.20,72.78 C71.93,73.50 70.04,75.09 68.93,77.20 C66.74,81.34 61.77,83.15 57.44,81.38 C55.23,80.48 52.77,80.48 50.56,81.38 C46.23,83.15 41.26,81.34 39.07,77.20 C37.96,75.09 36.07,73.50 33.80,72.78 C29.34,71.35 26.70,66.77 27.69,62.19 C28.19,59.86 27.77,57.43 26.50,55.42 C24.00,51.45 24.92,46.25 28.62,43.38 C30.50,41.92 31.74,39.78 32.06,37.42 C32.69,32.78 36.74,29.38 41.42,29.56 C43.80,29.65 46.12,28.81 47.89,27.21 C49.62,25.64 51.81,24.85 54.00,24.85 Z'
const EYES = 'M46,51 a3,4.6 0 1,0 6,0 a3,4.6 0 1,0 -6,0 Z M56,51 a3,4.6 0 1,0 6,0 a3,4.6 0 1,0 -6,0 Z'

function iconSvg() {
  // Android adaptive icons are drawn on a 108 x 108 canvas; the whole canvas fills the tile here.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="#E4E0FF"/>
  <g transform="scale(9.4815)">
    <path d="${SCOUT}" fill="#4A3FD1"/>
    <path d="${EYES}" fill="#FBFAFF"/>
  </g>
</svg>`
}

function ico(pngs) {
  const images = pngs
    .filter(([size]) => size <= 256)
    .sort((a, b) => a[0] - b[0])
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(16 * images.length)
  let offset = 6 + entries.length
  images.forEach(([size, data], index) => {
    const at = index * 16
    entries.writeUInt8(size >= 256 ? 0 : size, at)
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1)
    entries.writeUInt8(0, at + 2)
    entries.writeUInt8(0, at + 3)
    entries.writeUInt16LE(1, at + 4)
    entries.writeUInt16LE(32, at + 6)
    entries.writeUInt32LE(data.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, entries, ...images.map(([, data]) => data)])
}

const ICNS_TYPES = new Map([
  [16, 'icp4'],
  [32, 'icp5'],
  [64, 'icp6'],
  [128, 'ic07'],
  [256, 'ic08'],
  [512, 'ic09'],
  [1024, 'ic10'],
])

function icns(pngs) {
  const entries = []
  for (const [size, data] of pngs) {
    const type = ICNS_TYPES.get(size)
    if (!type) continue
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(8 + data.length, 4)
    entries.push(Buffer.concat([header, data]))
  }
  const total = 8 + entries.reduce((sum, entry) => sum + entry.length, 0)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(total, 4)
  return Buffer.concat([header, ...entries])
}

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ executablePath: findChrome(), args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
await page.setContent(`<!doctype html><style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${iconSvg()}`)

const pngs = []
for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size })
  const data = await page.screenshot({ omitBackground: true, type: 'png' })
  pngs.push([size, data])
  fs.writeFileSync(path.join(pngDir, `${size}x${size}.png`), data)
}
await browser.close()

const largest = pngs[pngs.length - 1]
if (largest === undefined) throw new Error('no icons were rendered')
fs.writeFileSync(path.join(buildDir, 'icon.png'), largest[1])
fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico(pngs))
fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns(pngs))
console.log(`icons written to ${path.relative(root, buildDir)}`)
