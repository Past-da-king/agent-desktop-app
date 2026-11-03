/**
 * agent-media:// wired into the window's own session (media/serve.ts does the answering).
 *
 * The scheme is registered before the app is ready, as Electron requires, and it is privileged the same way miniapp://
 * is: standard, secure, streaming, no service workers, never bypassing a page's Content-Security-Policy. Only the
 * window's session gets it, so a web page in the agent's browser cannot reach this computer's files.
 */
import { protocol, type Session } from 'electron'

import { MEDIA_SCHEME, type ShownFile } from './shown'
import { serveShown, type MediaLookup } from './serve'

/** Must run before the app is ready (index.ts, at load). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, allowServiceWorkers: false, bypassCSP: false, stream: true } },
  ])
}

/** Answer every agent-media:// request in this session. Looking at a file costs nothing until it is asked for. */
export function serveMediaIn(session: Session, lookup: (token: string) => ShownFile | null): void {
  const asking: MediaLookup = (token) => lookup(token)
  session.protocol.handle(MEDIA_SCHEME, (request) => serveShown(request, asking))
}
