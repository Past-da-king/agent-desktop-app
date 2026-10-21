/**
 * The agent's pages live in <webview> tags inside the browser card, so they are drawn with the app and move
 * with it in the same frame (a native view on top of the window always trailed fast scrolls and resizes).
 *
 * The renderer only places the page. Everything else stays here, in the main process:
 *   - a <webview> may only be attached for a tab the browser is waiting for, in exactly that tab's session
 *     partition, starting blank, with no preload, no Node, its own sandbox and context isolation;
 *   - the renderer hands over the guest's webContents id, and the guest must really be a webview of the main
 *     window in the expected session before the browser adopts it.
 *
 * Pure apart from reading the guest's own properties, so it is tested without Electron.
 */
import type { WebPreferences } from 'electron'

/** How long a new tab waits for the renderer's <webview> before it opens offscreen instead. */
export const EMBED_WAIT_MS = 3_000

/**
 * Applies the browser's rules to a <webview> about to attach (Electron's will-attach-webview). Returns false
 * when it must be refused: a partition no waiting tab asked for, or a first address other than a blank page.
 */
export function guardWebview(
  prefs: WebPreferences,
  params: Record<string, string>,
  partitionWanted: (partition: string) => boolean,
): boolean {
  // Whatever the page asked for, the guest gets the same locked-down settings as the old native view.
  delete prefs.preload
  prefs.nodeIntegration = false
  prefs.nodeIntegrationInSubFrames = false
  prefs.nodeIntegrationInWorker = false
  prefs.contextIsolation = true
  prefs.sandbox = true
  prefs.webviewTag = false
  prefs.webSecurity = true
  prefs.allowRunningInsecureContent = false
  prefs.backgroundThrottling = false
  const partition = typeof params['partition'] === 'string' ? params['partition'] : ''
  if (partition === '' || !partitionWanted(partition)) return false
  prefs.partition = partition
  const src = typeof params['src'] === 'string' ? params['src'] : ''
  // The main process loads every address itself (url-policy decides); the tag only ever starts blank.
  if (src !== '' && src !== 'about:blank') return false
  // Popups go through the tab's own window-open handler, never the tag.
  ;(params as Record<string, unknown>)['allowpopups'] = false
  return true
}

/** The parts of a webContents the adoption check reads. */
export interface GuestLike {
  id: number
  isDestroyed(): boolean
  getType(): string
  hostWebContents?: { id: number } | null
  session: unknown
}

/** True when `guest` is a live <webview> of the window `hostId`, in the session the tab expects. */
export function isEmbeddedGuest(guest: GuestLike | null | undefined, hostId: number, expectedSession: unknown): boolean {
  if (guest === null || guest === undefined) return false
  try {
    if (guest.isDestroyed()) return false
    if (guest.getType() !== 'webview') return false
    if (guest.hostWebContents === null || guest.hostWebContents === undefined || guest.hostWebContents.id !== hostId) return false
    return guest.session === expectedSession
  } catch {
    return false
  }
}
