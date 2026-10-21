/**
 * The global Quick Ask shortcut and the little window it opens (PLAN.md M8).
 *
 * `HotkeyBinder` holds the register/re-register logic and only talks to an injected shortcut
 * registry, so it can be tested with a fake. `QuickAskWindow` is the real frameless 640x180 window:
 * always on top, centred, closed by a click elsewhere, by Esc, or by asking it to hide.
 */
import { join } from 'node:path'

import { BrowserWindow, nativeTheme, screen } from 'electron'

import { EVENTS } from '../shared/channels'

export const QUICK_ASK_WIDTH = 640
export const QUICK_ASK_HEIGHT = 180
export const QUICK_ASK_ROUTE = '#/quick-window'

/** Where the quick chat box opens: centred across the screen the mouse is on, a little above the middle. */
export function quickAskPosition(workArea: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.round(workArea.x + (workArea.width - QUICK_ASK_WIDTH) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height * 0.3 - QUICK_ASK_HEIGHT / 2)),
  }
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
}

export class QuickAskWindow {
  private window: BrowserWindow | null = null

  constructor(private readonly options: QuickAskOptions) {}

  show(): void {
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) {
      this.place(existing)
      existing.show()
      existing.setAlwaysOnTop(true, 'floating')
      existing.focus()
      existing.webContents.send(EVENTS.quickAsk)
      return
    }

    const window = new BrowserWindow({
      width: QUICK_ASK_WIDTH,
      height: QUICK_ASK_HEIGHT,
      frame: false,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#131218' : '#FAF8F4',
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    })

    this.window = window
    window.setAlwaysOnTop(true, 'floating')
    this.place(window)

    window.once('ready-to-show', () => {
      window.show()
      window.setAlwaysOnTop(true, 'floating')
      window.focus()
      window.webContents.send(EVENTS.quickAsk)
    })
    window.on('blur', () => {
      // Some window managers move focus for a moment when the dictation pill appears; the box stays for that.
      if (this.options.keepOpen?.() === true) return
      this.hide()
    })
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

  /** Over whatever is in front, on the screen the person is looking at (the one with the mouse). */
  private place(window: BrowserWindow): void {
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const { x, y } = quickAskPosition(display.workArea)
      window.setBounds({ x, y, width: QUICK_ASK_WIDTH, height: QUICK_ASK_HEIGHT })
    } catch {
      window.center()
    }
  }

  hide(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    window.hide()
  }

  isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed() && this.window.isVisible()
  }

  destroy(): void {
    const window = this.window
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
