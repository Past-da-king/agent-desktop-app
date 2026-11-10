/**
 * The guide overlay's real windows (10 Nov 2026): what guide-overlay.ts draws on. One transparent, frameless window
 * that is never focused, never in the taskbar, lets every click through (the mouse is only taken while the pointer is
 * on one of the label's two buttons), and is registered with capture-privacy.ts so it is left out of screen sharing
 * whenever the setting says so and the system can do it.
 *
 *   - with an owner (the in-app browser's guide): a child of that window, so it stays just above it, never above
 *     other apps, and hides and minimises with it;
 *   - without one ("show me how" over any window): always on top at the screen-saver level, one per display.
 *
 * The page inside is a data: document with no preload, no Node and no network (overlay-page.ts).
 */
import { BrowserWindow, screen } from 'electron'

import type { BrandLook } from '../../shared/brand'
import type { CapturePrivacy } from '../capture-privacy'
import { GuideOverlay, type OverlayEvent, type OverlayHost, type OverlaySurface } from './guide-overlay'
import { overlayHtml, overlaySetScript, overlayStyleScript, OVERLAY_READ_SCRIPT, parseOverlayEvent, type OverlayPageState } from './overlay-page'
import type { Rect } from './rect'

export interface OverlayWindowOptions {
  /** Hides every overlay window from screen capture by the setting, live. Without it the windows are not hidden. */
  privacy?: CapturePrivacy | null
}

/** The overlay windows open now, for a proof or a check (never for drawing). */
const open = new Set<BrowserWindow>()

function makeSurface(options: OverlayWindowOptions, look: BrandLook, owner: BrowserWindow | undefined): OverlaySurface {
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
    // No thick frame: a frameless window with one is made a few pixels bigger than asked on a scaled screen.
    thickFrame: false,
    roundedCorners: false,
    ...(owner === undefined ? { alwaysOnTop: true } : { parent: owner }),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      // Follows the target while the app window is in the background too.
      backgroundThrottling: false,
      partition: 'guide-overlay',
    },
  })
  open.add(win)
  if (owner === undefined) win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.removeMenu()
  const privacy = options.privacy ?? null
  privacy?.register(win, 'guide')

  const listeners = new Set<(event: OverlayEvent) => void>()
  let ready = false
  let pending: OverlayPageState | null | undefined
  let pendingLook: BrandLook | undefined
  const run = (code: string): void => {
    if (win.isDestroyed()) return
    void win.webContents.executeJavaScript(code).catch(() => undefined)
  }
  win.webContents.on('console-message', (event: unknown, _level?: unknown, legacy?: unknown) => {
    const message = (event as { message?: unknown }).message
    const parsed = parseOverlayEvent(typeof message === 'string' ? message : typeof legacy === 'string' ? legacy : '')
    if (parsed === null) return
    if (parsed.type === 'ready') {
      ready = true
      if (pendingLook !== undefined) run(overlayStyleScript(pendingLook))
      if (pending !== undefined) run(overlaySetScript(pending))
      pendingLook = undefined
      pending = undefined
    }
    for (const listener of listeners) listener(parsed)
  })
  // It is a drawing, never a browser: it goes nowhere and opens nothing.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.once('closed', () => {
    open.delete(win)
    listeners.clear()
  })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml(look))}`).catch(() => undefined)

  return {
    setBounds(bounds: Rect): Rect {
      if (win.isDestroyed()) return bounds
      win.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)) })
      // What the system really gave (a scaled screen can round): the drawing is placed from this, not from the ask.
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
    push(state: OverlayPageState | null): void {
      if (ready) run(overlaySetScript(state))
      else pending = state
    },
    restyle(next: BrandLook): void {
      if (ready) run(overlayStyleScript(next))
      else pendingLook = next
    },
    setClickable(on: boolean): void {
      if (win.isDestroyed()) return
      if (on) win.setIgnoreMouseEvents(false)
      else win.setIgnoreMouseEvents(true, { forward: true })
    },
    onEvent(listener: (event: OverlayEvent) => void): void {
      listeners.add(listener)
    },
    isProtected: () => privacy !== null && privacy.protects(win),
    isDestroyed: () => win.isDestroyed(),
  }
}

/** The windows and displays of this computer, for a GuideOverlay. */
export function electronOverlayHost(options: OverlayWindowOptions = {}): OverlayHost {
  return {
    displays: () => screen.getAllDisplays().map((display) => ({ id: display.id, bounds: display.bounds, scaleFactor: display.scaleFactor })),
    createSurface: ({ look, owner }) => makeSurface(options, look, owner instanceof BrowserWindow && !owner.isDestroyed() ? owner : undefined),
  }
}

/** A guide overlay on this computer's screens (API: guide-overlay.ts). One per ring: each guide makes its own. */
export function createGuideOverlay(options: OverlayWindowOptions = {}): GuideOverlay {
  return new GuideOverlay(electronOverlayHost(options))
}

/**
 * What every open overlay window really shows, read from the windows themselves: bounds on the screen (DIPs), whether
 * each is visible and hidden from capture, and where its ring and label are drawn. A screen capture cannot see a
 * protected window, which is the point, so a proof reads this instead.
 */
export async function inspectOverlays(privacy: CapturePrivacy | null = null): Promise<Array<{ bounds: Rect; content: Rect; visible: boolean; protected: boolean; page: unknown }>> {
  const out: Array<{ bounds: Rect; content: Rect; visible: boolean; protected: boolean; page: unknown }> = []
  for (const win of open) {
    if (win.isDestroyed()) continue
    const page = (await win.webContents.executeJavaScript(OVERLAY_READ_SCRIPT).catch(() => null)) as unknown
    out.push({ bounds: win.getBounds(), content: win.getContentBounds(), visible: win.isVisible(), protected: privacy !== null && privacy.protects(win), page })
  }
  return out
}

/** A picture of each overlay window's own drawing (PNG), for a proof: the window's own pixels, not the screen's. */
export async function captureOverlays(): Promise<Buffer[]> {
  const out: Buffer[] = []
  for (const win of open) {
    if (win.isDestroyed() || !win.isVisible()) continue
    const image = await win.webContents.capturePage().catch(() => null)
    if (image !== null) out.push(image.toPNG())
  }
  return out
}
