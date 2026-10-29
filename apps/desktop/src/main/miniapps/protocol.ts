/**
 * miniapp://<id>/ : where a mini-app's files are served from (docs/plans/mini-apps.md). Every response carries the
 * frame's own rules (shared/miniapp-kit.ts MINIAPP_CSP: its own files only, no network, no frames, no forms), and the
 * window refuses every request and navigation a mini-app frame makes to anything but its own address. The renderer
 * opens it in <iframe sandbox="allow-scripts"> (no same-origin: no cookies, storage or parent access).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { protocol, type Session, type WebContents } from 'electron'

import { MINIAPP_CSP, MINIAPP_FONTS, serveMiniApp } from '../../shared/miniapp-kit'

export const MINIAPP_SCHEME = 'miniapp'

/** Must run before the app is ready (index.ts, at load). */
export function registerMiniAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MINIAPP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, allowServiceWorkers: false, bypassCSP: false, stream: false } },
  ])
}

/** The app font from the renderer's own build (out/renderer/assets/<name>-<hash>.woff2). */
export function rendererFonts(rendererDir: string): (name: string) => Uint8Array | null {
  const cache = new Map<string, Uint8Array | null>()
  return (name) => {
    if (!(MINIAPP_FONTS as readonly string[]).includes(name)) return null
    if (cache.has(name)) return cache.get(name) ?? null
    let bytes: Uint8Array | null = null
    try {
      const stem = name.replace(/\.woff2$/, '')
      for (const dir of [join(rendererDir, 'assets'), join(rendererDir, 'fonts')]) {
        let found: string | undefined
        try {
          found = readdirSync(dir).find((file) => file.startsWith(stem) && file.endsWith('.woff2'))
        } catch {
          found = undefined
        }
        if (found !== undefined) {
          bytes = readFileSync(join(dir, found))
          break
        }
      }
    } catch {
      bytes = null
    }
    cache.set(name, bytes)
    return bytes
  }
}

/** The app id and path a miniapp:// address names, or null. */
export function parseMiniAppUrl(url: string): { id: string; path: string } | null {
  const m = /^miniapp:\/\/([a-z0-9]{1,40})(\/[^#]*)?/i.exec(url)
  if (m === null) return null
  return { id: (m[1] ?? '').toLowerCase(), path: m[2] ?? '/' }
}

/** Serves every app's files in one session (the window's, the check windows'). */
export function serveMiniAppsIn(session: Session, filesOf: (id: string) => Promise<Record<string, string> | null>, font: (name: string) => Uint8Array | null): void {
  session.protocol.handle(MINIAPP_SCHEME, async (request) => {
    const parsed = parseMiniAppUrl(request.url)
    const headers = {
      'content-security-policy': MINIAPP_CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    }
    if (parsed === null || request.method !== 'GET') return new Response('Not found', { status: 404, headers })
    const files = await filesOf(parsed.id)
    const out = serveMiniApp(files, parsed.path, font)
    return new Response(out.body as BodyInit, { status: out.status, headers: { ...headers, 'content-type': out.type } })
  })
}

/** May a request from a frame at `from` go to `to`? Only within the same app's own address. */
export function frameMayReach(from: string, to: string): boolean {
  const a = parseMiniAppUrl(from)
  if (a === null) return true
  if (to.startsWith('data:') || to === 'about:blank' || to === 'about:srcdoc') return true
  const b = parseMiniAppUrl(to)
  return b !== null && b.id === a.id
}

/**
 * Locks mini-app frames in: a frame on miniapp:// navigates nowhere else, and no request it makes leaves its own
 * address (backing up its CSP). Logs what it stops.
 */
export function guardMiniAppFrames(contents: WebContents, session: Session, log: (message: string, detail?: Record<string, unknown>) => void): void {
  contents.on('will-frame-navigate', (event) => {
    const frame = event.frame
    if (frame === null || frame === undefined || event.isMainFrame) return
    const from = frame.url
    if (parseMiniAppUrl(from) !== null && !frameMayReach(from, event.url)) {
      event.preventDefault()
      log('Mini-app navigation stopped', { from: from.slice(0, 80), to: event.url.slice(0, 120) })
    }
  })
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] }, (details, callback) => {
    const frameUrl = (() => {
      try {
        return details.frame?.url ?? ''
      } catch {
        return ''
      }
    })()
    if (parseMiniAppUrl(frameUrl) !== null || parseMiniAppUrl(details.referrer ?? '') !== null) {
      log('Mini-app request stopped', { from: frameUrl.slice(0, 80), to: details.url.slice(0, 120) })
      callback({ cancel: true })
      return
    }
    callback({})
  })
}
