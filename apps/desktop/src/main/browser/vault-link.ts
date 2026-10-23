/**
 * The line from the Vault into a page (its own debugger, frames included) and the attach that ends with the page.
 * Kept free of Electron's runtime so a test can hand it a page that closes under it.
 *
 * A page's `debugger` is a native property: once the page is destroyed, reading it throws "Object has been
 * destroyed". The detach runs from the page's own 'destroyed' event, so the debugger is taken while the page is
 * alive and every later touch checks the page first. That throw, from a closed tab, was the crash dialog.
 */
import type { Debugger, WebContents } from 'electron'

import type { VaultAttachOptions, VaultLink } from '../vault/browser-vault'
import { alive, ifAlive } from '../alive'

/** The parts of a page's debugger the link uses. */
export type LinkDebugger = Pick<Debugger, 'sendCommand' | 'on' | 'removeListener'>

/** The parts of a page (a WebContents) the link uses. */
export type LinkPage = Pick<WebContents, 'isDestroyed' | 'debugger' | 'once'>

export interface VaultAttacher {
  attach(link: VaultLink, options: VaultAttachOptions): Promise<() => void>
}

const closed = (): Error => new Error('The page has closed.')

export function debuggerLink(wc: LinkPage): VaultLink {
  return {
    // Electron names the page's own session '' in its events, and a command sent to session '' goes nowhere.
    send: (method, params = {}, sessionId) => {
      if (!alive(wc)) return Promise.reject(closed())
      try {
        const dbg = wc.debugger
        return sessionId ? dbg.sendCommand(method, params, sessionId) : dbg.sendCommand(method, params)
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : closed())
      }
    },
    onEvent: (listener) => {
      if (!alive(wc)) return () => undefined
      const dbg = wc.debugger
      const handler = (_event: Electron.Event, method: string, params: Record<string, unknown>, sessionId?: string): void =>
        listener(method, params, sessionId || undefined)
      dbg.on('message', handler)
      return () => {
        ifAlive('vault link detach', () => dbg.removeListener('message', handler))
      }
    },
  }
}

/** Serves the Vault on a page until the page ends; a page that ended while it attached is let go at once. */
export async function attachVaultTo(vault: VaultAttacher, wc: LinkPage, options: VaultAttachOptions): Promise<void> {
  const stop = await vault.attach(debuggerLink(wc), options)
  const end = (): void => {
    ifAlive('vault stop', stop)
  }
  if (!alive(wc)) {
    end()
    return
  }
  wc.once('destroyed', end)
}
