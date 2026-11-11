/**
 * The global Quick Ask shortcut and the little window it opens (PLAN.md M8).
 *
 * `HotkeyBinder` holds the register/re-register logic and only talks to an injected shortcut
 * registry, so it can be tested with a fake. `QuickAskWindow` is the real frameless, see-through 640x180 window
 * that holds the orb and its pill: always on top, closed by a click elsewhere, by Esc, or by asking it to hide.
 * He drags it by the orb anywhere on any screen; it snaps to the edges and centre lines, and opens again where he
 * left it on that screen (11 Nov 2026).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BrowserWindow, ipcMain, screen } from 'electron'

import { CHANNELS, EVENTS } from '../shared/channels'
import { safeSend, whileAlive } from './alive'

export const QUICK_ASK_WIDTH = 640
export const QUICK_ASK_HEIGHT = 180
export const QUICK_ASK_ROUTE = '#/quick-window'
/** The see-through margin around the orb and pill inside the window (room for their shadow). */
export const QUICK_ASK_PAD = 20
/** How close, in pixels, the bar must come to a screen edge or centre line to snap to it. */
export const QUICK_ASK_SNAP = 22
/** The gap the bar keeps from a screen edge it snapped to. */
const EDGE_GAP = 12

interface Area {
  x: number
  y: number
  width: number
  height: number
}

const SIZE = { width: QUICK_ASK_WIDTH, height: QUICK_ASK_HEIGHT }

/** Keep the bar on the screen: the orb and pill inside the work area (the see-through margin may hang over). */
export function quickAskClamp(pos: { x: number; y: number }, area: Area, size = SIZE): { x: number; y: number } {
  const minX = area.x - QUICK_ASK_PAD
  const minY = area.y - QUICK_ASK_PAD
  const maxX = Math.max(minX, area.x + area.width + QUICK_ASK_PAD - size.width)
  const maxY = Math.max(minY, area.y + area.height + QUICK_ASK_PAD - size.height)
  return { x: Math.round(Math.min(Math.max(pos.x, minX), maxX)), y: Math.round(Math.min(Math.max(pos.y, minY), maxY)) }
}

/** Where a dragged bar lands: snapped to the screen's edges and centre lines when it comes close, then kept on screen. */
export function quickAskSnap(pos: { x: number; y: number }, area: Area, size = SIZE): { x: number; y: number } {
  let { x, y } = pos
  const left = area.x + EDGE_GAP - QUICK_ASK_PAD
  const right = area.x + area.width - EDGE_GAP + QUICK_ASK_PAD - size.width
  const top = area.y + EDGE_GAP - QUICK_ASK_PAD
  const bottom = area.y + area.height - EDGE_GAP + QUICK_ASK_PAD - size.height
  const centreX = area.x + (area.width - size.width) / 2
  const centreY = area.y + (area.height - size.height) / 2
  if (Math.abs(x - left) < QUICK_ASK_SNAP) x = left
  else if (Math.abs(x - right) < QUICK_ASK_SNAP) x = right
  else if (Math.abs(x - centreX) < QUICK_ASK_SNAP) x = centreX
  if (Math.abs(y - top) < QUICK_ASK_SNAP) y = top
  else if (Math.abs(y - bottom) < QUICK_ASK_SNAP) y = bottom
  else if (Math.abs(y - centreY) < QUICK_ASK_SNAP) y = centreY
  return quickAskClamp({ x, y }, area, size)
}

/** A saved spot is a fraction of that screen's work area, so it means the same place after a scale or resolution change. */
export interface QuickAskSpot {
  fx: number
  fy: number
}

export function quickAskSpotToPosition(spot: QuickAskSpot, area: Area): { x: number; y: number } {
  return quickAskClamp({ x: area.x + spot.fx * area.width, y: area.y + spot.fy * area.height }, area)
}

export function quickAskPositionToSpot(pos: { x: number; y: number }, area: Area): QuickAskSpot {
  const fx = area.width > 0 ? (pos.x - area.x) / area.width : 0
  const fy = area.height > 0 ? (pos.y - area.y) / area.height : 0
  return { fx: Number(fx.toFixed(4)), fy: Number(fy.toFixed(4)) }
}

function readSpots(file: string | undefined): Record<string, QuickAskSpot> {
  if (file === undefined) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (raw === null || typeof raw !== 'object') return {}
    const out: Record<string, QuickAskSpot> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const spot = value as { fx?: unknown; fy?: unknown }
      if (typeof spot?.fx === 'number' && typeof spot?.fy === 'number' && Number.isFinite(spot.fx) && Number.isFinite(spot.fy)) {
        out[key] = { fx: spot.fx, fy: spot.fy }
      }
    }
    return out
  } catch {
    return {}
  }
}

/** Where the quick chat box opens: centred across the screen the mouse is on, a little above the middle. */
export function quickAskPosition(workArea: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  // Never left of or above the screen, even one narrower or shorter than the box.
  const x = workArea.x + Math.max(0, (workArea.width - QUICK_ASK_WIDTH) / 2)
  const y = workArea.y + Math.max(0, Math.min(workArea.height * 0.3 - QUICK_ASK_HEIGHT / 2, workArea.height - QUICK_ASK_HEIGHT))
  return { x: Math.round(x), y: Math.round(y) }
}

/** The slice of Electron's `globalShortcut` the binder needs. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

export interface HotkeyStatus {
  accelerator: string
  ok: boolean
  message: string
}

export class HotkeyBinder {
  private current: string | null = null

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly onTrigger: () => void,
    private readonly onStatus?: (status: HotkeyStatus) => void,
  ) {}

  currentAccelerator(): string | null {
    return this.current
  }

  /** Point the shortcut at a new accelerator (or none when the setting is empty). */
  apply(raw: string): HotkeyStatus {
    const accelerator = raw.trim()
    this.release()

    if (accelerator === '') {
      const status: HotkeyStatus = {
        accelerator,
        ok: false,
        message: 'Quick Ask has no shortcut. Set one in Settings.',
      }
      this.onStatus?.(status)
      return status
    }

    let ok = false
    try {
      ok = this.registry.register(accelerator, this.onTrigger)
    } catch {
      ok = false
    }

    if (ok) this.current = accelerator
    const status: HotkeyStatus = ok
      ? { accelerator, ok: true, message: `Quick Ask is ready on ${formatAccelerator(accelerator)}.` }
      : {
          accelerator,
          ok: false,
          message: `That shortcut could not be registered. Something else may already be using ${formatAccelerator(accelerator)}. Try another.`,
        }
    this.onStatus?.(status)
    return status
  }

  dispose(): void {
    this.release()
  }

  private release(): void {
    if (this.current === null) return
    try {
      this.registry.unregister(this.current)
    } catch {
      // A shortcut that is already gone cannot be unregistered; that is fine.
    }
    this.current = null
  }
}

/** "CommandOrControl+Shift+Space" reads as "Ctrl+Shift+Space" on Windows and Linux, "Cmd" on a Mac. */
export function formatAccelerator(accelerator: string, platform: NodeJS.Platform = process.platform): string {
  return accelerator
    .split('+')
    .map((part) => {
      const key = part.trim()
      if (key === '') return ''
      if (/^commandorcontrol$/i.test(key)) return platform === 'darwin' ? 'Cmd' : 'Ctrl'
      if (/^cmdorctrl$/i.test(key) || /^control$/i.test(key)) {
        return platform === 'darwin' ? 'Cmd' : 'Ctrl'
      }
      if (/^command$/i.test(key) || /^cmd$/i.test(key)) return 'Cmd'
      if (/^alt$/i.test(key) || /^option$/i.test(key)) return platform === 'darwin' ? 'Option' : 'Alt'
      if (/^shift$/i.test(key)) return 'Shift'
      return key.length === 1 ? key.toUpperCase() : key
    })
    .filter((part) => part !== '')
    .join('+')
}

export interface QuickAskOptions {
  preloadPath: string
  rendererFile: string
  /** The dev server, when running under `electron-vite dev`. */
  devUrl?: string
  /** While true a lost focus does not close the box (a dictation is typing into it). */
  keepOpen?: () => boolean
  /** Told of the box's window when it is made (it shows only the chat: capture-privacy.ts hides it by that setting). */
  onWindow?: (window: BrowserWindow) => void
  /** Where the spots he dragged the bar to are kept, one per screen. Left out: it opens in the default place. */
  spotsFile?: string
}

export class QuickAskWindow {
  private window: BrowserWindow | null = null
  private spots: Record<string, QuickAskSpot>
  private drag: { timer: ReturnType<typeof setInterval>; dx: number; dy: number; until: number } | null = null

  constructor(private readonly options: QuickAskOptions) {
    this.spots = readSpots(options.spotsFile)
    // The orb is dragged by the main process following the real cursor, so the window never lags behind a fast
    // move and a click on the orb that does not move stays a click.
    ipcMain.handle(CHANNELS.window.quickDrag, (event, phase: unknown) => {
      const window = this.window
      if (window === null || window.isDestroyed() || event.sender !== window.webContents) return false
      if (phase === 'start') this.startDrag(window)
      else this.endDrag(window)
      return true
    })
  }

  private startDrag(window: BrowserWindow): void {
    this.stopDragTimer()
    const cursor = screen.getCursorScreenPoint()
    const [wx, wy] = window.getPosition()
    const dx = cursor.x - (wx ?? 0)
    const dy = cursor.y - (wy ?? 0)
    const timer = setInterval(() => {
      if (window.isDestroyed() || !window.isVisible() || Date.now() > (this.drag?.until ?? 0)) {
        this.endDrag(window)
        return
      }
      const point = screen.getCursorScreenPoint()
      const area = screen.getDisplayNearestPoint(point).workArea
      const next = quickAskSnap({ x: point.x - dx, y: point.y - dy }, area)
      window.setPosition(next.x, next.y)
    }, 16)
    // A drag whose end was never heard (the button let go outside every window) stops by itself.
    this.drag = { timer, dx, dy, until: Date.now() + 60_000 }
  }

  private stopDragTimer(): void {
    if (this.drag !== null) clearInterval(this.drag.timer)
    this.drag = null
  }

  private endDrag(window: BrowserWindow): void {
    const was = this.drag !== null
    this.stopDragTimer()
    if (!was || window.isDestroyed()) return
    try {
      const [x, y] = window.getPosition()
      const display = screen.getDisplayMatching(window.getBounds())
      this.spots[String(display.id)] = quickAskPositionToSpot({ x: x ?? 0, y: y ?? 0 }, display.workArea)
      if (this.options.spotsFile !== undefined) writeFileSync(this.options.spotsFile, JSON.stringify(this.spots, null, 2))
    } catch {
      // The spot is only a nicety: the bar opens in the default place next time.
    }
  }

  show(): void {
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) {
      this.place(existing)
      existing.show()
      existing.setAlwaysOnTop(true, 'floating')
      existing.focus()
      safeSend(existing, EVENTS.quickAsk)
      return
    }

    const window = new BrowserWindow({
      width: QUICK_ASK_WIDTH,
      height: QUICK_ASK_HEIGHT,
      frame: false,
      // See-through: only the orb, the pill and the answer bubble show, each with its own shadow.
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })

    this.window = window
    this.options.onWindow?.(window)
    window.setAlwaysOnTop(true, 'floating')
    this.place(window)

    window.once(
      'ready-to-show',
      whileAlive(window, 'quick ask show', () => {
        window.show()
        window.setAlwaysOnTop(true, 'floating')
        window.focus()
        safeSend(window, EVENTS.quickAsk)
      }),
    )
    window.on(
      'blur',
      whileAlive(window, 'quick ask blur', () => {
        // Some window managers move focus for a moment when the dictation pill appears; the box stays for that.
        if (this.options.keepOpen?.() === true) return
        this.hide()
      }),
    )
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })
    window.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') this.hide()
    })

    if (this.options.devUrl !== undefined && this.options.devUrl !== '') {
      void window.loadURL(`${this.options.devUrl}${QUICK_ASK_ROUTE}`)
    } else {
      void window.loadFile(this.options.rendererFile, { hash: '/quick-window' })
    }
  }

  /**
   * Over whatever is in front, on the screen the person is looking at (the one with the mouse): where he last
   * dragged it on that screen, else a little above the middle. Always fully on that screen.
   */
  private place(window: BrowserWindow): void {
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const spot = this.spots[String(display.id)]
      const { x, y } = spot !== undefined ? quickAskSpotToPosition(spot, display.workArea) : quickAskPosition(display.workArea)
      window.setBounds({ x, y, width: QUICK_ASK_WIDTH, height: QUICK_ASK_HEIGHT })
    } catch {
      window.center()
    }
  }

  /** A screen was unplugged or changed size: an open box moves back onto a screen that exists. */
  refit(): void {
    const window = this.window
    if (window === null || window.isDestroyed() || !window.isVisible()) return
    this.place(window)
  }

  hide(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    this.endDrag(window)
    window.hide()
  }

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
  }

  destroy(): void {
    const window = this.window
    this.stopDragTimer()
    ipcMain.removeHandler(CHANNELS.window.quickDrag)
    this.window = null
    if (window !== null && !window.isDestroyed()) window.destroy()
  }
}

/** Electron's own quick window paths, in one place so `index.ts` stays about the app. */
export function quickAskPaths(mainDir: string): { preloadPath: string; rendererFile: string } {
  return {
    preloadPath: join(mainDir, '../preload/index.js'),
    rendererFile: join(mainDir, '../renderer/index.html'),
  }
}
