/**
 * The agent cursor's real windows (11 Nov 2026): what agent-cursor.ts draws on. Transparent, frameless, never
 * focusable (`focusable:false`, shown with showInactive), never in the taskbar, and `setIgnoreMouseEvents(true)` for
 * good: it takes no click and no key, ever. Registered with capture-privacy.ts as 'guide', so it is left out of screen
 * sharing whenever hideGuidesFromCapture says so.
 *
 *   - with an owner (the in-app browser): a child of the app window, so it stays just above that window, never above
 *     other apps, and hides and minimises with it;
 *   - without one (a window of another program): always on top at the screen-saver level, one per display.
 */
import { BrowserWindow, screen } from 'electron'

import type { BrandLook } from '../../shared/brand'
import type { CapturePrivacy } from '../capture-privacy'
import { AgentCursors, type CursorHost, type CursorSurface, type CursorPageState } from './agent-cursor'
import { cursorHtml, cursorSetScript, cursorStyleScript, parseCursorEvent } from './agent-cursor-page'
import type { Rect } from './rect'

export interface AgentCursorOptions {
  privacy?: CapturePrivacy | null
  look: () => BrandLook
  /** The setting agentCursor, read live. */
  enabled: () => boolean
}

function makeSurface(privacy: CapturePrivacy | null, look: BrandLook, owner: BrowserWindow | undefined): CursorSurface {
  const win = new BrowserWindow({
    width: 16,
    height: 16,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    thickFrame: false,
    roundedCorners: false,
    ...(owner === undefined ? { alwaysOnTop: true } : { parent: owner }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
      partition: 'agent-cursor',
    },
  })
  if (owner === undefined) win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.removeMenu()
  privacy?.register(win, 'guide')

  let ready = false
  let pending: CursorPageState | null | undefined
  let pendingLook: BrandLook | undefined
  const run = (code: string): void => {
    if (win.isDestroyed()) return
    void win.webContents.executeJavaScript(code).catch(() => undefined)
  }
  win.webContents.on('console-message', (event: unknown, _level?: unknown, legacy?: unknown) => {
    const message = (event as { message?: unknown }).message
    const parsed = parseCursorEvent(typeof message === 'string' ? message : typeof legacy === 'string' ? legacy : '')
    if (parsed === null) return
    ready = true
    if (pendingLook !== undefined) run(cursorStyleScript(pendingLook))
    if (pending !== undefined) run(cursorSetScript(pending))
    pendingLook = undefined
    pending = undefined
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cursorHtml(look))}`).catch(() => undefined)

  return {
    setBounds(bounds: Rect): Rect {
      if (win.isDestroyed()) return bounds
      win.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) })
      return win.getContentBounds()
    },
    show(): void {
      if (!win.isDestroyed()) win.showInactive()
    },
    hide(): void {
      if (!win.isDestroyed()) win.hide()
    },
    destroy(): void {
      if (!win.isDestroyed()) win.destroy()
    },
    push(state: CursorPageState | null): void {
      if (ready) run(cursorSetScript(state))
      else pending = state
    },
    restyle(next: BrandLook): void {
      if (ready) run(cursorStyleScript(next))
      else pendingLook = next
    },
    isProtected: () => privacy !== null && privacy.protects(win),
    isDestroyed: () => win.isDestroyed(),
  }
}

export function electronCursorHost(privacy: CapturePrivacy | null): CursorHost {
  return {
    displays: () => screen.getAllDisplays().map((display) => ({ id: display.id, bounds: display.bounds })),
    createSurface: ({ look, owner }) => makeSurface(privacy, look, owner instanceof BrowserWindow && !owner.isDestroyed() ? owner : undefined),
  }
}

/** The agent cursors of this computer (API: agent-cursor.ts). One object for the whole app. */
export function createAgentCursors(options: AgentCursorOptions): AgentCursors {
  return new AgentCursors(electronCursorHost(options.privacy ?? null), { enabled: options.enabled, look: options.look })
}
