/**
 * Keeps HIS keyboard where it was while the agent acts in its browser (11 Nov 2026).
 *
 * The agent's pages are <webview>s inside the app window. Input reaches them by the debugger (cdp.ts), never by a real
 * pointer or key, but Chromium can still move keyboard focus INTO the guest when a debugger click lands in it (the
 * page's own mousedown focuses a field, or `el.focus()` in a page script). If he was typing in the chat message box of
 * the same window, his next keys then went into the agent's page instead. Two defences, in this order:
 *
 *   1. prevention: `Emulation.setFocusEmulationEnabled` on every agent tab (browser.ts prepare): the page believes it has
 *      focus, so it never asks the browser for any;
 *   2. this: if the app window's own page (the chat) had the keyboard before an action and no longer has it after, give
 *      it back (webContents.focus() on the window's own page, then the element that had it). It only ever acts when
 *      the app window already is the window he is in, so it cannot bring the app forward either.
 */
export interface FocusProbe {
  /** Is the app window the window he is using now (the operating system's foreground)? */
  appFocused(): boolean
  /** Does the app window's OWN page (not a guest) have the keyboard? */
  hostFocused(): boolean
  /** Remembers which element of the app's page has focus (the message box). */
  saveActive(): Promise<void>
  /** Gives the keyboard back to the app's page and that element. */
  restoreHost(): Promise<void>
}

/** Call before an agent action; call the answer after it. Resolves true when the keyboard had to be given back. */
export async function keepFocus(probe: FocusProbe): Promise<() => Promise<boolean>> {
  let had = false
  try {
    had = probe.appFocused() && probe.hostFocused()
    if (had) await probe.saveActive()
  } catch {
    had = false
  }
  return async () => {
    if (!had) return false
    try {
      if (!probe.appFocused() || probe.hostFocused()) return false
      await probe.restoreHost()
      return true
    } catch {
      return false
    }
  }
}

/** Runs in the app window's page: remember the active element, and put focus back on it. */
export const SAVE_ACTIVE_JS = `(() => { const a = document.activeElement; globalThis.__agentKept = a && a !== document.body && a.tagName !== 'WEBVIEW' ? a : null; return true; })()`
export const RESTORE_ACTIVE_JS = `(() => { const el = globalThis.__agentKept; globalThis.__agentKept = null; if (el && el.isConnected && typeof el.focus === 'function') { el.focus({ preventScroll: true }); return true; } return false; })()`
