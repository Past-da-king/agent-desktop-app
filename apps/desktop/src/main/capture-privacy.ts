/**
 * Hiding windows from screen sharing (10 Nov 2026): one small place that turns content protection on or off for the
 * windows it is told about, from the two settings, live. The rule and what the system can really do are in
 * shared/capture-privacy.ts; this file only holds the windows.
 *
 * Content protection is per window. A region of a window (the chat inside the app window) cannot be hidden by
 * itself: something that must be hidden alone needs a window of its own, registered here with its role. Today the
 * chat is drawn in the app window (on its own page, and docked beside the browser), so "hide the chat" hides the app
 * window whole, and the setting's hint says so. If the chat ever gets a window of its own, it registers as 'chat'
 * with `docksMainChat: true`, and from then on "hide the chat" hides that window and leaves the app window alone.
 */
import { release as osRelease } from 'node:os'

import { captureExclusion, shouldProtect, type CaptureExclusion, type CaptureRole, type CaptureSettings } from '../shared/capture-privacy'

/** The part of a BrowserWindow this needs (a fake in tests). */
export interface ProtectableWindow {
  setContentProtection(enable: boolean): void
  isDestroyed(): boolean
  once(event: 'closed', listener: () => void): unknown
}

interface Entry {
  role: CaptureRole
  docksMainChat: boolean
  on: boolean | null
}

export class CapturePrivacy {
  private readonly windows = new Map<ProtectableWindow, Entry>()
  readonly exclusion: CaptureExclusion

  constructor(
    private readonly settings: () => CaptureSettings,
    exclusion: CaptureExclusion = captureExclusion(process.platform, osRelease()),
  ) {
    this.exclusion = exclusion
  }

  /**
   * Keeps this window hidden from capture whenever its role says so. `docksMainChat`: this window IS the main
   * window's chat (a docked chat in its own window), so the app window itself no longer needs hiding.
   */
  register(window: ProtectableWindow, role: CaptureRole, options: { docksMainChat?: boolean } = {}): () => void {
    this.windows.set(window, { role, docksMainChat: options.docksMainChat === true, on: null })
    const forget = (): void => {
      if (!this.windows.delete(window)) return
      // A chat window that goes takes the app window's own rule back with it.
      this.apply()
    }
    try {
      window.once('closed', forget)
    } catch {
      // A window already closing: nothing to keep.
    }
    this.apply()
    return forget
  }

  /** The settings changed, or a window came or went: every window gets what its role says now. */
  apply(): void {
    const settings = this.settings()
    const chatHasOwnWindow = [...this.windows].some(([window, entry]) => entry.docksMainChat && alive(window))
    for (const [window, entry] of this.windows) {
      if (!alive(window)) {
        this.windows.delete(window)
        continue
      }
      // Where the system cannot hide a window, nothing is asked of it: no half measure passes for privacy.
      const want = this.exclusion !== 'none' && shouldProtect(entry.role, settings, { chatHasOwnWindow })
      if (entry.on === want) continue
      try {
        window.setContentProtection(want)
        entry.on = want
      } catch {
        entry.on = null
      }
    }
  }

  /** Is this window hidden from capture now (as far as was asked of the system)? */
  protects(window: ProtectableWindow): boolean {
    return this.windows.get(window)?.on === true
  }
}

function alive(window: ProtectableWindow): boolean {
  try {
    return !window.isDestroyed()
  } catch {
    return false
  }
}
