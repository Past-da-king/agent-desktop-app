/**
 * The agent's pages are <webview>s inside the browser card. These hold the two halves together: the renderer
 * places the page with the same maths the main process uses for its emulation, and only locked-down
 * <webview>s for tabs the browser is waiting for may attach.
 */
import type { WebPreferences } from 'electron'
import { describe, expect, it } from 'vitest'

import { guardWebview, isEmbeddedGuest } from '../src/main/browser/embed'
import { emulationCommands, fitView, presetView, resolveView, shapedView, type ViewSpec } from '../src/main/browser/emulation'
import { pageSize, placePage } from '../src/shared/page-place'

const engine = { chromeVersion: '152.0.7977.167', platform: 'win32' }

function views(): ViewSpec[] {
  return [
    presetView('desktop'),
    presetView('tablet'),
    presetView('phone'),
    presetView('fit'),
    resolveView(presetView('desktop'), { width: 1440, height: 900 }),
    resolveView(presetView('desktop'), { width: 1024, height: 768 }),
    resolveView(presetView('desktop'), { zoom: 0.8 }),
    resolveView(presetView('phone'), { width: 412, height: 915 }),
  ]
}

const boxes = [
  { width: 338, height: 376 },
  { width: 470, height: 480 },
  { width: 1917, height: 950 },
  { width: 1440, height: 745 },
  { width: 1200, height: 640 },
  { width: 320, height: 240 },
  { width: 2560, height: 1300 },
]

describe('placing the page in its card', () => {
  it('lays the page out exactly as the main process emulates it, for every view and box', () => {
    for (const view of views()) {
      for (const box of boxes) {
        const slot = { x: 0, y: 0, ...box }
        const shaped = shapedView(view, slot)
        const fit = fitView(slot, shaped)
        const placed = placePage(box, view)
        expect(placed, `${view.mode} in ${box.width}x${box.height}`).not.toBeNull()
        if (placed === null) continue
        if (view.mode === 'fit') {
          expect(placed).toEqual({ left: 0, top: 0, width: box.width, height: box.height, scale: 1 })
          continue
        }
        expect([placed.width, placed.height]).toEqual([shaped.width, shaped.height])
        expect(placed.scale).toBeCloseTo(fit.scale, 10)
        expect([placed.left, placed.top]).toEqual([fit.bounds.x, fit.bounds.y])
      }
    }
  })

  it('fills the panel card with a desktop page, edge to edge', () => {
    const placed = placePage({ width: 338, height: 376 }, presetView('desktop'))!
    expect(placed.width).toBe(1440)
    expect(placed.left).toBe(0)
    expect(placed.top).toBe(0)
    expect(Math.round(placed.width * placed.scale)).toBe(338)
    expect(Math.abs(placed.height * placed.scale - 376)).toBeLessThanOrEqual(1)
  })

  it('shows a phone page whole and centred, never scaled up', () => {
    const placed = placePage({ width: 338, height: 376 }, presetView('phone'))!
    expect([placed.width, placed.height]).toEqual([390, 844])
    expect(placed.scale).toBeCloseTo(376 / 844, 6)
    expect(placed.top).toBe(0)
    expect(placed.left).toBe(Math.floor((338 - Math.round(390 * placed.scale)) / 2))
    expect(placePage({ width: 2000, height: 2000 }, presetView('phone'))!.scale).toBe(1)
  })

  it('draws a desktop page 1:1 in the full-size view', () => {
    expect(placePage({ width: 1440, height: 745 }, presetView('desktop'))).toEqual({ left: 0, top: 0, width: 1440, height: 745, scale: 1 })
    expect(pageSize({ width: 1917, height: 950 }, presetView('desktop'))).toEqual({ width: 1917, height: 950 })
  })

  it('places nothing in an empty box', () => {
    expect(placePage({ width: 0, height: 300 }, presetView('desktop'))).toBeNull()
    expect(placePage({ width: 300, height: 0 }, presetView('phone'))).toBeNull()
  })
})

describe('the emulation of an embedded page', () => {
  it('leaves the size to the <webview> and draws at 1, keeping the device', () => {
    const phone = presetView('phone')
    const slot = { x: 0, y: 0, width: 338, height: 376 }
    const metrics = emulationCommands(phone, engine, fitView(slot, phone), true).find((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    expect(metrics?.params).toMatchObject({ width: 0, height: 0, deviceScaleFactor: 3, mobile: true, scale: 1, screenWidth: 390, screenHeight: 844 })
    const offscreen = emulationCommands(phone, engine, { bounds: slot, scale: 1 }).find((c) => c.method === 'Emulation.setDeviceMetricsOverride')
    expect(offscreen?.params).toMatchObject({ width: 390, height: 844, scale: 1 })
  })

  it('asks for languages as a plain list (Chromium adds the q-values once)', () => {
    const ua = emulationCommands(presetView('desktop'), engine, { bounds: { x: 0, y: 0, width: 1, height: 1 }, scale: 1 }).find((c) => c.method === 'Emulation.setUserAgentOverride')
    expect(ua?.params['acceptLanguage']).toBe('en-US,en')
  })
})

describe('which <webview> may attach', () => {
  const waiting = (partition: string): boolean => partition === 'persist:agent-browser'

  it('locks a wanted one down whatever the page asked for', () => {
    const prefs = { preload: '/tmp/evil.js', nodeIntegration: true, contextIsolation: false, sandbox: false, webviewTag: true, webSecurity: false } as WebPreferences
    const params: Record<string, string> = { partition: 'persist:agent-browser', src: 'about:blank', allowpopups: 'true' }
    expect(guardWebview(prefs, params, waiting)).toBe(true)
    expect(prefs.preload).toBeUndefined()
    expect(prefs).toMatchObject({ nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webviewTag: false, webSecurity: true, partition: 'persist:agent-browser' })
    expect((params as Record<string, unknown>)['allowpopups']).toBe(false)
  })

  it('refuses a partition no tab is waiting for, and any first address but a blank page', () => {
    expect(guardWebview({} as WebPreferences, { partition: 'persist:other', src: 'about:blank' }, waiting)).toBe(false)
    expect(guardWebview({} as WebPreferences, { partition: '', src: 'about:blank' }, waiting)).toBe(false)
    expect(guardWebview({} as WebPreferences, { src: 'about:blank' }, waiting)).toBe(false)
    expect(guardWebview({} as WebPreferences, { partition: 'persist:agent-browser', src: 'https://example.com/' }, waiting)).toBe(false)
    expect(guardWebview({} as WebPreferences, { partition: 'persist:agent-browser', src: 'file:///etc/passwd' }, waiting)).toBe(false)
    expect(guardWebview({} as WebPreferences, { partition: 'persist:agent-browser', src: '' }, waiting)).toBe(true)
  })

  it('adopts only a live webview of this window in the expected session', () => {
    const session = {}
    const guest = (over: Partial<{ type: string; host: number | null; session: unknown; destroyed: boolean }> = {}) => ({
      id: 7,
      isDestroyed: () => over.destroyed ?? false,
      getType: () => over.type ?? 'webview',
      hostWebContents: over.host === null ? null : { id: over.host ?? 1 },
      session: 'session' in over ? over.session : session,
    })
    expect(isEmbeddedGuest(guest(), 1, session)).toBe(true)
    expect(isEmbeddedGuest(guest({ type: 'window' }), 1, session)).toBe(false)
    expect(isEmbeddedGuest(guest({ host: 2 }), 1, session)).toBe(false)
    expect(isEmbeddedGuest(guest({ host: null }), 1, session)).toBe(false)
    expect(isEmbeddedGuest(guest({ session: {} }), 1, session)).toBe(false)
    expect(isEmbeddedGuest(guest({ destroyed: true }), 1, session)).toBe(false)
    expect(isEmbeddedGuest(undefined, 1, session)).toBe(false)
  })
})
