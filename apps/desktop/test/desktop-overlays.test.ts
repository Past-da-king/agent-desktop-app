/**
 * Desktop overlays are centred panels that fit the window. Bug of 29 Oct 2026 (0.2.110): the mini-app "What it may do"
 * panel was drawn inside its 300 px card, so its scrim was the card, the panel was squeezed to the card, scrolled
 * sideways (a bar that looked like a phone sheet's grab handle) and was cut off at the left of the window.
 *
 * This lays the REAL shared Dialog out with the REAL renderer styles in a headless Electron window, opened from inside
 * a small card, a side panel, a moving (transformed) container and the page itself, at 1440, 1280 and 800 wide, light
 * and dark, and fails when a dialog's box leaves the window, scrolls sideways, sits in a scrim smaller than the
 * window, is covered, or carries a grab handle. The static half checks every overlay goes through that Dialog.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const DESKTOP = path.join(__dirname, '..')
const RENDERER = path.join(DESKTOP, 'src/renderer')

const ENTRY = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Dialog } from './src/renderer/ui/Dialog'
import './src/renderer/styles/index.css'

// The same words and parts as the mini-app permissions panel, plus a wide row, so a squeezed panel scrolls sideways.
function Body({ name }) {
  return React.createElement('div', { className: 'ma-dialog' },
    React.createElement('div', { className: 'h3' }, 'What ' + name + ' may do'),
    React.createElement('p', { className: 'muted' }, 'It has no network and sees nothing else of the app. It reads only what is listed; anything that changes something asks you first, unless you allow it here.'),
    React.createElement('ul', { className: 'ma-rights' },
      React.createElement('li', null,
        React.createElement('span', { className: 'ma-right-name' }, React.createElement('code', null, 'calendar_events'), React.createElement('span', { className: 'small muted' }, 'Reads')),
        React.createElement('span', { className: 'pill ok' }, 'Allowed'))),
    React.createElement('div', { className: 'ma-dialog-actions' }, React.createElement('button', { className: 'btn' }, 'Done')))
}
const D = ({ where }) => React.createElement(Dialog, { label: 'Dialog in ' + where, onClose: () => {} }, React.createElement(Body, { name: where }))

// The window as Main draws it: title bar, stage with the rail and the sheet, the side panel, and the overlay layer.
function Win({ where }) {
  const card = React.createElement('div', { className: 'ma-grid' },
    React.createElement('div', { className: 'ma-card', style: { minHeight: 120 } }, where === 'card' ? React.createElement(D, { where }) : null))
  const moving = React.createElement('div', { style: { transform: 'translateY(0.5px)', position: 'relative', width: 260, height: 90 } }, where === 'moving' ? React.createElement(D, { where }) : null)
  return React.createElement('div', { className: 'win' },
    React.createElement('div', { className: 'titlebar', style: { height: 44 } }),
    React.createElement('div', { className: 'stage' },
      React.createElement('div', { className: 'shell panel' },
        React.createElement('aside', { className: 'rail' }),
        React.createElement('main', { className: 'sheet' },
          React.createElement('div', { className: 'page' }, card, moving, where === 'page' ? React.createElement(D, { where }) : null)),
        React.createElement('aside', { className: 'panel-w', style: { position: 'relative', overflow: 'hidden' } }, where === 'panel' ? React.createElement(D, { where }) : null))),
    React.createElement('div', { className: 'overlay' }))
}
window.__show = (where) => new Promise((resolve) => {
  document.documentElement.classList.add('native') // the real window is the frame, as main.tsx sets it
  document.body.innerHTML = '<div id="root"></div>'
  createRoot(document.getElementById('root')).render(React.createElement(Win, { where }))
  setTimeout(resolve, 700)
})
window.__measure = () => {
  const vw = innerWidth, vh = innerHeight
  return [...document.querySelectorAll('[role=dialog]')].map((d) => {
    const r = d.getBoundingClientRect()
    const s = d.parentElement.getBoundingClientRect()
    // 24 px in from each corner: inside the rounded corner (radius up to 28), so it lands on the panel when it is on top.
    const pts = [[r.left + 24, r.top + 24], [r.right - 24, r.top + 24], [r.left + 24, r.bottom - 24], [r.right - 24, r.bottom - 24]]
    const handle = [...d.querySelectorAll('*'), d].some((e) => /handle|grab/i.test(String(e.className))) ||
      [d, ...d.children].some((e) => ['::before', '::after'].some((p) => { const c = getComputedStyle(e, p); return c.content !== 'none' && c.content !== 'normal' && parseFloat(c.height) <= 8 && parseFloat(c.width) >= 20 && parseFloat(c.width) <= 80 }))
    return {
      label: d.getAttribute('aria-label'), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vw, vh,
      inside: r.left >= 0 && r.top >= 0 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5,
      sideways: d.scrollWidth > d.clientWidth + 1,
      scrimFull: s.left <= 0.5 && s.top <= 0.5 && s.width >= vw - 1 && s.height >= vh - 1,
      onTop: pts.every(([x, y]) => { const e = document.elementFromPoint(x, y); return e !== null && d.contains(e) }),
      centred: Math.abs(r.left + r.width / 2 - vw / 2) <= 2,
      handle, hit: (() => { const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e ? e.tagName + '.' + String(e.className).slice(0, 30) : 'none' })(),
    }
  })
}
`

const MAIN = `
const { app, BrowserWindow } = require('electron')
app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  const out = []
  try {
    const w = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { offscreen: true } })
    await w.loadFile(process.argv[process.argv.length - 1])
    for (const theme of ['light', 'dark']) for (const [vw, vh] of [[1440, 900], [1280, 800], [800, 760]]) {
      w.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: vw, height: vh }, viewSize: { width: vw, height: vh }, viewPosition: { x: 0, y: 0 }, deviceScaleFactor: 1, scale: 1 })
      await w.webContents.executeJavaScript("document.documentElement.dataset.theme = '" + theme + "'")
      for (const where of ['card', 'panel', 'moving', 'page']) {
        await w.webContents.executeJavaScript('window.__show(' + JSON.stringify(where) + ')')
        out.push({ theme, width: vw, where, dialogs: await w.webContents.executeJavaScript('window.__measure()') })
      }
    }
  } catch (error) { out.push({ error: String(error && error.stack || error) }) }
  console.log('RESULT ' + JSON.stringify(out))
  app.exit(0)
})
`

type Row = { theme?: string; width?: number; where?: string; error?: string; dialogs?: Array<Record<string, unknown>> }

function layout(): Row[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-overlays-'))
  const esbuild = require('esbuild') as typeof import('esbuild')
  esbuild.buildSync({
    stdin: { contents: ENTRY, resolveDir: DESKTOP, loader: 'jsx', sourcefile: 'entry.jsx' },
    bundle: true,
    outdir: dir,
    entryNames: 'page',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    loader: { '.woff2': 'empty', '.woff': 'empty', '.png': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
  })
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="page.css"></head><body><script src="page.js"></script></body></html>')
  fs.writeFileSync(path.join(dir, 'main.js'), MAIN)
  const electron = require('electron') as unknown as string
  const args = [...(process.platform === 'linux' ? ['--ozone-platform=headless', '--no-sandbox'] : []), path.join(dir, 'main.js'), path.join(dir, 'index.html')]
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (process.platform === 'linux') { delete env.DISPLAY; delete env.WAYLAND_DISPLAY }
  const run = spawnSync(electron, args, { env, encoding: 'utf8', timeout: 90_000 })
  const line = `${run.stdout}`.split('\n').find((l) => l.startsWith('RESULT '))
  fs.rmSync(dir, { recursive: true, force: true })
  if (line === undefined) throw new Error(`electron gave no result: ${run.error ?? ''} ${run.stderr?.slice(-2000)}`)
  return JSON.parse(line.slice(7)) as Row[]
}

describe('desktop overlays fit the window', () => {
  it('a dialog opened from a card, a side panel, a moving container or the page is a centred panel inside the window at 1440, 1280 and 800, light and dark, with no grab handle', () => {
    const rows = layout()
    expect(rows.filter((r) => r.error)).toEqual([])
    expect(rows).toHaveLength(2 * 3 * 4)
    const bad: string[] = []
    for (const row of rows) {
      const where = `${row.where} at ${row.width} ${row.theme}`
      if (row.dialogs?.length !== 1) { bad.push(`${where}: ${row.dialogs?.length ?? 0} dialogs`); continue }
      const d = row.dialogs[0] as Record<string, unknown>
      for (const key of ['inside', 'scrimFull', 'onTop', 'centred']) if (d[key] !== true) bad.push(`${where}: not ${key} ${JSON.stringify(d.box)} ${String(d.hit)}`)
      if (d.sideways === true) bad.push(`${where}: scrolls sideways`)
      if (d.handle === true) bad.push(`${where}: has a grab handle`)
      // Sized to its content, never squeezed to whatever opened it.
      if ((d.box as number[])[2] < Math.min(480, (row.width ?? 0) - 64)) bad.push(`${where}: squeezed to ${(d.box as number[])[2]} px`)
    }
    expect(bad).toEqual([])
  }, 120_000)
})

describe('every desktop overlay goes through the one Dialog', () => {
  const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  const all = files(RENDERER)
  const tsx = all.filter((f) => f.endsWith('.tsx'))
  const css = all.filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(f, 'utf8')).join('\n')

  it('draws into the window overlay layer, not inside whatever opened it', () => {
    const dialog = fs.readFileSync(path.join(RENDERER, 'ui/Dialog.tsx'), 'utf8')
    expect(dialog).toMatch(/createPortal\(dialog, layer\)/)
    expect(dialog).toMatch(/DIALOG_LAYER = '\.win > \.overlay'/)
    const app = fs.readFileSync(path.join(RENDERER, 'App.tsx'), 'utf8')
    expect(app).toMatch(/<div className="overlay">/)
  })

  it('no view makes its own scrim; modal overlays use Dialog', () => {
    const own = tsx.filter((f) => !f.endsWith(path.join('ui', 'Dialog.tsx')) && /className=["'`]scrim/.test(fs.readFileSync(f, 'utf8')))
    expect(own.map((f) => path.relative(RENDERER, f))).toEqual([])
  })

  it('no desktop style draws a phone grab handle, and no dialog body forces a width wider than its panel', () => {
    expect(css).not.toMatch(/(grab|drag|sheet)-handle/)
    expect(css).not.toMatch(/\.ma-dialog\{[^}]*min-width:min\(480px/)
  })
})
