/**
 * The look check (docs/plans/mini-apps.md): before he is shown an app, it is opened offscreen in light and dark at
 * 1440 and 390 wide, exactly as served to the window (same protocol, rules and bridge, its reads answered for real,
 * its writes not run), and looked at: errors it throws, calls it was refused, sideways scrolling, an empty page. The
 * four screenshots are saved for the agent (and him) to look at.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BrowserWindow, ipcMain, session as sessions, type Session } from 'electron'
import type { MiniAppCheck, MiniAppRow } from '@agent/core'

import type { MiniAppHost } from './host'
import { serveMiniAppsIn } from './protocol'

export const CHECK_PARTITION = 'miniapp-check'
export const CHECK_CHANNELS = { hello: 'agent:miniapp-check.hello', post: 'agent:miniapp-check.post', push: 'agent:miniapp-check.push' } as const

export const CHECK_LOOKS: Array<{ width: number; height: number; theme: 'light' | 'dark' }> = [
  { width: 1440, height: 900, theme: 'light' },
  { width: 1440, height: 900, theme: 'dark' },
  { width: 390, height: 844, theme: 'light' },
  { width: 390, height: 844, theme: 'dark' },
]

export interface CheckDeps {
  host: () => MiniAppHost | null
  filesOf: (id: string) => Promise<Record<string, string> | null>
  font: (name: string) => Uint8Array | null
  preload: string
  outDir: string
  accent: () => string
  log: (message: string, detail?: Record<string, unknown>) => void
  /** How long an app gets to draw after it loads (ms). */
  settleMs?: number
}

export class MiniAppChecker {
  private readonly deps: CheckDeps
  private session: Session | null = null
  private readonly byContents = new Map<number, string>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(deps: CheckDeps) {
    this.deps = deps
    ipcMain.on(CHECK_CHANNELS.hello, (event) => {
      event.returnValue = this.byContents.has(event.sender.id)
    })
    ipcMain.on(CHECK_CHANNELS.post, (event, text: unknown) => {
      const sessionId = this.byContents.get(event.sender.id)
      const host = this.deps.host()
      if (sessionId === undefined || host === null || typeof text !== 'string' || text.length > 200_000) return
      let message: unknown
      try {
        message = JSON.parse(text)
      } catch {
        return
      }
      void host.handle(sessionId, message as Record<string, unknown>).then((reply) => {
        if (reply !== null && !event.sender.isDestroyed()) event.sender.send(CHECK_CHANNELS.push, JSON.stringify(reply))
      })
    })
  }

  private checkSession(): Session {
    if (this.session !== null) return this.session
    const s = sessions.fromPartition(CHECK_PARTITION)
    serveMiniAppsIn(s, this.deps.filesOf, this.deps.font)
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    this.session = s
    return s
  }

  /** One check at a time (a 16 GB computer: four offscreen pages are enough at once). */
  check(app: MiniAppRow): Promise<MiniAppCheck> {
    const run = this.queue.then(() => this.run(app))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async run(app: MiniAppRow): Promise<MiniAppCheck> {
    const host = this.deps.host()
    if (host === null) throw new Error('Mini-apps are not running.')
    const dir = join(this.deps.outDir, app.id)
    mkdirSync(dir, { recursive: true })
    const issues: string[] = []
    const shots: string[] = []
    const s = this.checkSession()
    for (const look of CHECK_LOOKS) {
      const label = `${look.width} ${look.theme}`
      const win = new BrowserWindow({
        show: false,
        width: look.width,
        height: look.height,
        useContentSize: true,
        webPreferences: { partition: CHECK_PARTITION, preload: this.deps.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true, session: s, spellcheck: false },
      })
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      guardFrames(win, s, this.deps.log)
      const sessionId = host.openSession(app.id, (message) => {
        if (!win.isDestroyed()) win.webContents.send(CHECK_CHANNELS.push, JSON.stringify(message))
      }, 'check')
      if (sessionId === null) {
        win.destroy()
        throw new Error('The app is not loaded.')
      }
      this.byContents.set(win.webContents.id, sessionId)
      try {
        await win.loadURL(`miniapp://${app.id}/index.html?theme=${look.theme}&accent=${encodeURIComponent(this.deps.accent())}`)
        await new Promise((resolve) => setTimeout(resolve, this.deps.settleMs ?? 1500))
        const seen = (await win.webContents.executeJavaScript(
          `({sw:document.documentElement.scrollWidth,w:window.innerWidth,text:(document.body&&document.body.innerText||'').trim().length,els:document.body?document.body.querySelectorAll('*').length:0,theme:document.documentElement.getAttribute('data-theme'),bg:getComputedStyle(document.body).backgroundColor})`,
        )) as { sw: number; w: number; text: number; els: number; theme: string; bg: string }
        if (seen.sw > seen.w + 2) issues.push(`${label}: the page scrolls sideways (${seen.sw}px wide in a ${seen.w}px window); wrap or stack it, put wide tables in .scroll-x`)
        if (seen.text === 0 && seen.els < 3) issues.push(`${label}: the page is empty`)
        if (seen.theme !== look.theme) issues.push(`${label}: the theme did not apply (data-theme is ${seen.theme})`)
        const image = await win.webContents.capturePage()
        const file = join(dir, `v${app.version}-${look.width}-${look.theme}.png`)
        writeFileSync(file, image.toPNG())
        shots.push(file)
        const report = host.sessionReport(sessionId)
        if (report !== null) {
          for (const error of report.errors) issues.push(`${label}: script error: ${error}`)
          for (const refused of report.refused) if (!/Not run during the check/.test(refused)) issues.push(`${label}: refused: ${refused}`)
        }
      } catch (error) {
        issues.push(`${label}: did not open: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        host.closeSession(sessionId)
        this.byContents.delete(win.webContents.id)
        win.destroy()
      }
    }
    // The same finding in each look is one line.
    const unique = [...new Set(issues)]
    return { version: app.version, at: Date.now(), ok: unique.length === 0, issues: unique.slice(0, 20), shots }
  }
}

function guardFrames(win: BrowserWindow, s: Session, log: CheckDeps['log']): void {
  // The check window's top frame IS the app: it goes nowhere else either.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('miniapp://')) {
      event.preventDefault()
      log('Mini-app check: navigation stopped', { to: url.slice(0, 120) })
    }
  })
  if (!guarded.has(s)) {
    guarded.add(s)
    // Everything that is not miniapp:// is refused in the check session, whoever asks.
    s.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('miniapp://') && !details.url.startsWith('data:') && !details.url.startsWith('devtools:') }))
  }
}

const guarded = new WeakSet<Session>()
