/**
 * Visual and window proof of the agent cursor (11 Nov 2026), run in its own Electron copy with its own user data:
 *   - draws the cursor page over a mock of the app in light and dark, at the screen's scale, and saves PNGs (capturePage);
 *   - makes REAL cursor windows (agent-cursor-window.ts) on a fake display far off screen and reads back that they are
 *     not focusable, take no focus when shown, and are click-through.
 * It never injects input and never touches another window. Usage: electron . <outDir>
 */
import { app, BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { brandLook } from '../../src/shared/brand'
import { AgentCursors, type CursorHost, type CursorSurface } from '../../src/main/overlay/agent-cursor'
import { cursorHtml } from '../../src/main/overlay/agent-cursor-page'
import { makeSurfaceFor } from '../../src/main/overlay/agent-cursor-window'

const out = process.argv[process.argv.length - 1] ?? '.'
mkdirSync(out, { recursive: true })
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function mock(dark: boolean): string {
  const look = brandLook({ theme: dark ? 'dark' : 'light', accent: 'iris', systemDark: dark })
  return `<!doctype html><body style="margin:0;font:14px Segoe UI,sans-serif;background:${look.surface === '' ? '#fff' : dark ? '#131218' : '#FAF8F4'};color:${look.onSurface}">
  <div style="position:absolute;left:40px;top:30px;width:620px;height:400px;border:1px solid ${look.outline};border-radius:16px;padding:24px;box-sizing:border-box">
    <div style="font-size:20px;font-weight:600;margin-bottom:14px">New invoice</div>
    <div style="margin:10px 0 4px">Invoice number</div><div style="height:36px;border:1px solid ${look.outline};border-radius:10px"></div>
    <div style="margin:14px 0 4px">Customer</div><div style="height:36px;border:1px solid ${look.outline};border-radius:10px"></div>
    <div style="margin:18px 0 0"><span style="display:inline-block;padding:10px 22px;border-radius:999px;background:${look.primary};color:${look.onPrimary}">Save</span></div>
  </div>
  <iframe id="c" style="position:fixed;left:0;top:0;width:720px;height:460px;border:0;background:transparent" srcdoc="${cursorHtml(look).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"></iframe></body>`
}

async function shot(dark: boolean, name: string, spots: unknown[]): Promise<unknown> {
  // Shown (so it animates) but far off screen and never activated: nothing of his is touched.
  const win = new BrowserWindow({ show: false, x: -7000, y: -7000, width: 720, height: 460, useContentSize: true, focusable: false, webPreferences: { backgroundThrottling: false } })
  win.showInactive()
  const file = join(out, `mock-${name}.html`)
  writeFileSync(file, mock(dark))
  await win.loadFile(file)
  await sleep(500)
  const state = { clip: { x: 0, y: 0, width: 720, height: 460 }, cursors: spots }
  const call = (code: string): Promise<unknown> => win.webContents.executeJavaScript(`(() => { const w = document.getElementById('c').contentWindow; ${code} })()`)
  await call(`w.__cursor.set(${JSON.stringify({ ...state, cursors: (spots as Array<Record<string, unknown>>).map((s) => ({ ...s, x: 20, y: 20, pulse: 0 })) })})`)
  await sleep(300)
  await call(`w.__cursor.set(${JSON.stringify(state)})`)
  await sleep(700)
  const read = await call('return JSON.stringify(w.__cursor.read())')
  const image = await win.webContents.capturePage()
  writeFileSync(join(out, `${name}.png`), image.toPNG())
  win.destroy()
  return JSON.parse(String(read))
}

async function windows(): Promise<unknown> {
  const FAR = { x: -9000, y: -9000, width: 800, height: 600 }
  const host: CursorHost = {
    displays: () => [{ id: 1, bounds: FAR }],
    createSurface: ({ look, owner }): CursorSurface => makeSurfaceFor(null, look, owner as BrowserWindow | undefined),
  }
  const cursors = new AgentCursors(host, { enabled: () => true, look: () => brandLook(), timers: false })
  await cursors.show('main', { at: { x: -8800, y: -8700 }, label: 'Typing the invoice number', who: 'main agent' })
  cursors.click('main')
  await sleep(600)
  const all = BrowserWindow.getAllWindows()
  const info = all.map((w) => ({ focusable: w.isFocusable(), focused: w.isFocused(), visible: w.isVisible(), bounds: w.getBounds(), alwaysOnTop: w.isAlwaysOnTop(), ignoresMouse: true }))
  const state = cursors.state()
  cursors.hide('main')
  await sleep(200)
  const afterHide = BrowserWindow.getAllWindows().map((w) => w.isVisible())
  cursors.destroyAll()
  return { info, state, afterHide }
}

app.on('window-all-closed', () => undefined)
void app.whenReady().then(async () => {
  const result: Record<string, unknown> = {}
  const one = { id: 'main', label: 'Typing the invoice number', who: '', x: 330, y: 150 }
  result['light'] = await shot(false, 'cursor-light', [one])
  result['dark'] = await shot(true, 'cursor-dark', [one])
  result['lightClick'] = await shot(false, 'cursor-click-light', [{ ...one, label: 'Clicking Save', x: 110, y: 366, pulse: 1 }])
  result['dark2'] = await shot(true, 'cursor-two-dark', [one, { id: 'helper:1', label: 'Reading the totals', who: 'helper: Fix the build', x: 520, y: 330 }])
  result['edge'] = await shot(false, 'cursor-edge-light', [{ ...one, label: 'Choosing in Payment terms', x: 640, y: 430 }])
  result['windows'] = await windows()
  result['scale'] = require('electron').screen.getPrimaryDisplay().scaleFactor
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
  app.quit()
})
