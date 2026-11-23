/**
 * The window a plan sign-in page opens in: the app's own, private, never the computer's default browser.
 *
 * The default browser is usually already signed in as ONE ChatGPT or Claude account, so a second account signed in from
 * it comes out as the first. Every sign-in gets a window of its own on an in-memory session partition (no \`persist:\`
 * prefix, a new name each time): no cookies from any earlier sign-in, none kept afterwards.
 */
import type { BrowserWindow as ElectronBrowserWindow } from 'electron'

export interface SignInWindowDeps {
  BrowserWindow: typeof ElectronBrowserWindow
}

export interface SignInWindows {
  /** Opens the address in a fresh private window. False (nothing opened) unless it is an https address. */
  open(url: string, account: string): boolean
}

function httpsOnly(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

export function createSignInWindows(deps: SignInWindowDeps): SignInWindows {
  let count = 0
  const open = new Map<string, ElectronBrowserWindow>()
  return {
    open(url, account) {
      if (!httpsOnly(url)) return false
      // One sign-in window per account: a new attempt replaces the old one (and its session).
      const previous = open.get(account)
      if (previous !== undefined && !previous.isDestroyed()) previous.close()
      count += 1
      const partition = `signin-${account.replace(/[^A-Za-z0-9_-]/g, '_') || 'x'}-${Date.now().toString(36)}-${count}`
      const win = new deps.BrowserWindow({
        width: 520,
        height: 780,
        title: 'Sign in',
        autoHideMenuBar: true,
        webPreferences: { partition, contextIsolation: true, nodeIntegration: false, sandbox: true },
      })
      // Sign-in pages open their provider pop-ups (Google, Microsoft) in the same private session.
      win.webContents.setWindowOpenHandler(({ url: next }) => (httpsOnly(next) ? { action: 'allow' } : { action: 'deny' }))
      open.set(account, win)
      void win.loadURL(url).catch(() => undefined)
      return true
    },
  }
}
