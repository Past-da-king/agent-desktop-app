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
function mascotPath() {
  const N = 240
  const n = 9
  const a = 0.07
  const points = []
  for (let i = 0; i < N; i += 1) {
    const th = (i / N) * Math.PI * 2 - Math.PI / 2
    const r = 1 - a + a * Math.cos(n * (th + Math.PI / 2))
    points.push([50 + 46 * r * Math.cos(th), 50 + 46 * r * Math.sin(th)])
  }
  return `M${points.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L')}Z`
}

function iconSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#5A50E0"/>
      <stop offset="1" stop-color="#3B31B8"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="224" fill="url(#bg)"/>
  <g transform="translate(192 176) scale(6.4)">
    <path d="${mascotPath()}" fill="#F29A2E"/>
    <ellipse cx="37.5" cy="49" rx="4.3" ry="6.4" fill="#3A1F00"/>
    <ellipse cx="62.5" cy="49" rx="4.3" ry="6.4" fill="#3A1F00"/>
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
