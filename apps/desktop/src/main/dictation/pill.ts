/**
 * The dictation pill's window: small, transparent, always on top, near the bottom centre of the screen the
 * mouse is on. It can never take focus (focusable: false, shown inactive), so the app being typed into keeps
 * the keyboard. It also holds the microphone, so it must keep running while hidden and start audio without
 * a click.
 */
import { BrowserWindow, screen } from 'electron'

import type { DictationCommand, DictationView } from '@agent/core'

import { EVENTS } from '../../shared/channels'
import type { PillLike } from './controller'
import { safeSend } from '../alive'

export const PILL_WIDTH = 520
export const PILL_HEIGHT = 84
export const PILL_ROUTE = '#/dictation'
const BOTTOM_GAP = 28

export interface PillOptions {
  preloadPath: string
  rendererFile: string
  devUrl?: string
}

/** Where the pill goes: centred along the bottom of the work area (above the taskbar). */
export function pillBounds(workArea: { x: number; y: number; width: number; height: number }): { x: number; y: number; width: number; height: number } {
  // A screen narrower than the pill gets a narrower pill (its page centres itself), never one hanging off the side.
  const width = Math.min(PILL_WIDTH, Math.max(0, Math.floor(workArea.width)))
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + Math.max(0, workArea.height - PILL_HEIGHT - BOTTOM_GAP)),
    width,
    height: PILL_HEIGHT,
  }
}

export class PillWindow implements PillLike {
  private window: BrowserWindow | null = null
  private loaded = false
  private wantVisible = false
  private pendingView: DictationView | null = null
  private pendingCommand: DictationCommand | null = null

  constructor(private readonly options: PillOptions) {}

  /** Starts the window hidden so the first dictation does not wait for it to load. */
  prepare(): void {
    this.ensure()
  }

  isPill(id: number): boolean {
    const window = this.window
    return window !== null && !window.isDestroyed() && window.webContents.id === id
  }

  show(): void {
    this.wantVisible = true
    const window = this.ensure()
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    window.setBounds(pillBounds(display.workArea))
    if (this.loaded) {
      window.showInactive()
      window.setAlwaysOnTop(true, 'screen-saver')
    }
  }

  /** A screen was unplugged or changed size: a showing pill moves back onto a screen that exists. */
  refit(): void {
    const window = this.window
    if (!this.wantVisible || window === null || window.isDestroyed()) return
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      window.setBounds(pillBounds(display.workArea))
    } catch {
      // Screen information can be missing for a moment while displays change; the next show places it.
    }
  }

  hide(): void {
    this.wantVisible = false
    const window = this.window
    if (window !== null && !window.isDestroyed()) window.hide()
  }

  view(view: DictationView): void {
    this.pendingView = view
    this.send(EVENTS.dictationView, view)
  }

  command(command: DictationCommand): void {
    // The microphone lives here even when the pill does not show (a dictation into the app's own window), so the
    // window must exist, hidden, for a start to reach it; a command sent before it loads waits for rendererReady.
    if (command.type === 'start') this.ensure()
    this.pendingCommand = command
    this.send(EVENTS.dictationCommand, command)
  }

  /** The pill's page is listening: give it the current view and command, and show it if it should be showing. */
  rendererReady(): void {
    this.loaded = true
    if (this.pendingView !== null) this.send(EVENTS.dictationView, this.pendingView)
    if (this.pendingCommand !== null) this.send(EVENTS.dictationCommand, this.pendingCommand)
    if (this.wantVisible) this.show()
  }

  destroy(): void {
    const window = this.window
    this.window = null
    if (window !== null && !window.isDestroyed()) window.destroy()
  }

  private send(channel: string, payload: unknown): void {
    const window = this.window
    if (!this.loaded) return
    safeSend(window, channel, payload)
  }

  private ensure(): BrowserWindow {
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) return existing
    this.loaded = false
    const window = new BrowserWindow({
      width: PILL_WIDTH,
      height: PILL_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        // The microphone keeps running while the window is hidden or behind others.
        backgroundThrottling: false,
        // The pill is never clicked before it listens, so audio must start without a gesture.
        autoplayPolicy: 'no-user-gesture-required',
      },
    })
    this.window = window
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
        this.loaded = false
      }
    })
    window.webContents.on('render-process-gone', () => {
      if (this.window === window) {
        this.window = null
        this.loaded = false
      }
    })
    if (this.options.devUrl !== undefined && this.options.devUrl !== '') {
      void window.loadURL(`${this.options.devUrl}${PILL_ROUTE}`)
    } else {
      void window.loadFile(this.options.rendererFile, { hash: '/dictation' })
    }
    return window
  }
}
