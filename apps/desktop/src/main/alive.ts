/**
 * Electron objects (a window, a page, a page's debugger) end while their events, timers and promises are still
 * in flight: a tab closes as it navigates, a window goes as a send is on its way. Any native call on one that has
 * ended throws "Object has been destroyed". These helpers are the one way main-process code touches such an
 * object from a callback, so a page that went away is skipped, never a crash.
 */

/** Anything Electron can destroy: BrowserWindow, WebContents, WebContentsView's page. */
export interface Destroyable {
  isDestroyed(): boolean
}

interface Sender extends Destroyable {
  send(channel: string, ...args: unknown[]): void
}

interface Window extends Destroyable {
  webContents: Sender
}

/** Logs a skipped call; set once by the app (logger), a no-op until then. */
let report: (what: string, error: unknown) => void = () => undefined

export function onDestroyedSkip(log: (what: string, error: unknown) => void): void {
  report = log
}

/** Still there: not null and not destroyed. Never throws. */
export function alive<T extends Destroyable>(target: T | null | undefined): target is T {
  if (target === null || target === undefined) return false
  try {
    return !target.isDestroyed()
  } catch {
    return false
  }
}

/** The error Electron throws for a native call on an object that has ended. */
export function isDestroyedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return /Object has been destroyed/i.test(message)
}

/**
 * A listener that runs only while `target` is alive, and that treats "Object has been destroyed" from inside it
 * as the page having gone (logged, skipped). Any other error still throws.
 */
export function whileAlive<A extends unknown[]>(target: Destroyable, what: string, listener: (...args: A) => void): (...args: A) => void {
  return (...args: A): void => {
    if (!alive(target)) return
    try {
      listener(...args)
    } catch (error) {
      if (!isDestroyedError(error)) throw error
      report(what, error)
    }
  }
}

/** Runs `fn`, and a destroyed object inside it is a skip (logged), not a throw. Other errors throw. */
export function ifAlive<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn()
  } catch (error) {
    if (!isDestroyedError(error)) throw error
    report(what, error)
    return undefined
  }
}

/** Sends to a window's page if both are still there. True when it was sent. */
export function safeSend(win: Window | null | undefined, channel: string, ...args: unknown[]): boolean {
  if (!alive(win)) return false
  const wc = win.webContents
  if (!alive(wc)) return false
  try {
    wc.send(channel, ...args)
    return true
  } catch (error) {
    if (!isDestroyedError(error)) throw error
    report(`send ${channel}`, error)
    return false
  }
}

/**
 * What the app does with an uncaught exception. A destroyed Electron object is a page or window that closed
 * under a callback: logged and carried on. Anything else gets the crash dialog.
 */
export function uncaughtPolicy(error: unknown): 'log' | 'dialog' {
  return isDestroyedError(error) ? 'log' : 'dialog'
}

export interface UncaughtHooks {
  log: (message: string, fields: Record<string, unknown>) => void
  dialog: () => void
}

/** The process's uncaughtException listener: always logged with its stack, the dialog only for a real fault. */
export function uncaughtHandler(hooks: UncaughtHooks): (error: Error) => void {
  return (error) => {
    const policy = uncaughtPolicy(error)
    hooks.log(policy === 'log' ? 'Uncaught exception from a closed page or window (carried on)' : 'Uncaught exception', {
      message: error?.message,
      stack: error?.stack,
    })
    if (policy === 'dialog') hooks.dialog()
  }
}
