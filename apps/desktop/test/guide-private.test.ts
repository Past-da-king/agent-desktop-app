/**
 * Guides hidden from screen sharing (10 Nov 2026): the in-app browser's ring drawn in an overlay window instead of
 * in the page.
 *   - the life cycle with fakes: an overlay is made only when his setting is on and the system can hide a window,
 *     drawn at the screen rectangle the geometry gives, hidden whenever it must not show, gone on every end path;
 *   - the setting: default, live switch, and that agents need his yes to change it;
 *   - in a real Chromium: a page in report mode paints NOTHING of the guide (its pixels are the same as with no
 *     guide), says where its target is as it scrolls, switches drawing live, and a frame's place inside the top page
 *     is right across a cross-site frame; the overlay page draws the ring exactly on the rectangle it is given.
 */
import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

import { DEFAULT_SETTINGS } from '@agent/core'
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runGuide, type GuideFrame, type GuideHost, type GuideSurfaceStep } from '../src/main/browser/guide'
import { evaluateIn, FrameSessions, type GuideLink } from '../src/main/browser/guide-host'
import { guideModeScript, guideShowScript, parseReport, type GuideReport } from '../src/main/browser/guide-page'
import { parseView, PrivateGuide, viewWatchScript, type PrivateOverlay, type ViewInfo, type WindowInfo } from '../src/main/browser/guide-private'
import type { OverlayShow, OverlayState } from '../src/main/overlay/guide-overlay'
import { overlayHtml, overlaySetScript, OVERLAY_EVENT, OVERLAY_READ_SCRIPT, RING_PAD } from '../src/main/overlay/overlay-page'
import { SettingsStore } from '../src/main/settings'
import { SETTINGS_NEED_APPROVAL } from '../src/main/tools/app-control'
import { ACCENTS, brandLook } from '../src/shared/brand'
import { recordingSurface } from './helpers/outside-surface'

class FakeOverlay implements PrivateOverlay {
  shows: OverlayShow[] = []
  hides = 0
  destroyed = 0
  shown: OverlayShow | null = null
  show(spec: OverlayShow): void { this.shows.push(spec); this.shown = spec }
  hide(): void { this.hides++; this.shown = null }
  destroyAll(): void { this.destroyed++; this.shown = null }
  state(): OverlayState { return { shown: this.shown !== null, displayId: 1, rect: this.shown?.rect ?? null, protected: true, windows: 1 } }
}

const VIEW: ViewInfo = { found: true, front: true, backstage: false, covered: false, view: { x: 300, y: 80, width: 1000, height: 700 }, clip: { x: 300, y: 80, width: 1000, height: 700 } }
const WINDOW: WindowInfo = { content: { x: 40, y: 25 }, zoom: 1, visible: true }
const TOP: GuideFrame = { key: '|top', url: 'https://example.test/', top: true }
const look = brandLook({ theme: 'light', accent: 'teal' })

function setup(over: { on?: boolean; flightSettleMs?: number; frameBox?: () => Promise<{ x: number; y: number; width: number; height: number; pageWidth: number } | null> } = {}): {
  guide: PrivateGuide
  made: FakeOverlay[]
  state: { on: boolean; view: ViewInfo | null; window: WindowInfo | null }
  acts: string[]
  step: (frame?: GuideFrame, token?: string) => GuideSurfaceStep
} {
  const made: FakeOverlay[] = []
  const state = { on: over.on ?? true, view: { ...VIEW } as ViewInfo | null, window: { ...WINDOW } as WindowInfo | null }
  const acts: string[] = []
  const guide = new PrivateGuide({
    outside: () => state.on,
    overlay: () => {
      const overlay = new FakeOverlay()
      made.push(overlay)
      return overlay
    },
    owner: { name: 'app window' },
    view: () => state.view,
    window: () => state.window,
    look: () => look,
    frameBox: over.frameBox ?? (async () => null),
    frameEveryMs: 10,
    flightSettleMs: over.flightSettleMs ?? 0,
  })
  const step = (frame: GuideFrame = TOP, token = 'g1-1'): GuideSurfaceStep => ({ token, frame, label: 'Click Save', n: 2, total: 3, act: (outcome) => acts.push(outcome) })
  return { guide, made, state, acts, step }
}

const told = (y = 50, token = 'g1-1'): GuideReport => ({ token, shown: true, box: { x: 100, y, width: 200, height: 40 }, tag: { x: 100, y: y + 50, width: 230, height: 42 }, vw: 1000, vh: 700 })

describe('private guide: when the overlay exists and where it draws', () => {
  it('makes no overlay while the setting is off or the system cannot hide a window', () => {
    const { guide, made, step } = setup({ on: false })
    expect(guide.outside()).toBe(false)
    guide.begin(step())
    guide.report(told())
    guide.refresh()
    guide.end('g1-1')
    guide.dispose()
    expect(made.length).toBe(0)
  })

  it('draws the ring at the element\'s screen rectangle, clipped to the page\'s visible area, with the step\'s label', () => {
    const { guide, made, acts, step } = setup()
    guide.begin(step())
    // Nothing is made before the page says where the target is.
    expect(made.length).toBe(0)
    guide.report(told())
    expect(made.length).toBe(1)
    const shown = made[0]!.shown!
    // window content 40,25 + view 300,80 + target 100,50
    expect(shown.rect).toEqual({ x: 440, y: 155, width: 200, height: 40 })
    expect(shown.area).toEqual({ x: 340, y: 105, width: 1000, height: 700 })
    expect(shown.clip).toEqual({ x: 340, y: 105, width: 1000, height: 700 })
    expect(shown.labelAt).toEqual({ x: 440, y: 205, width: 230 })
    expect(shown).toMatchObject({ label: 'Click Save', step: 2, of: 3, scale: 1, look })
    expect((shown.owner as { name: string }).name).toBe('app window')
    shown.onAct?.('done')
    expect(acts).toEqual(['done'])
    // A report for another step is not this step's.
    guide.report(told(300, 'other'))
    expect(made[0]!.shown!.rect.y).toBe(155)
  })

  it('follows a scroll and a window move, and hides whenever it must not show', () => {
    const { guide, made, state, step } = setup()
    guide.begin(step())
    guide.report(told())
    const overlay = made[0]!
    guide.report(told(250))
    expect(overlay.shown!.rect.y).toBe(355)
    state.window = { ...WINDOW, content: { x: -1800, y: -150 } }
    guide.refresh()
    expect(overlay.shown!.rect).toEqual({ x: -1400, y: 180, width: 200, height: 40 })
    state.window = { ...WINDOW }
    guide.refresh()

    const hiddenBy: Array<[string, () => void, () => void]> = [
      ['scrolled out of the page', () => guide.report(told(-200)), () => guide.report(told())],
      ['the page says the target is gone', () => guide.report({ token: 'g1-1', shown: false }), () => guide.report(told())],
      ['another tab in front', () => { state.view = { ...VIEW, front: false } }, () => { state.view = { ...VIEW } }],
      ['the page parked behind the app', () => { state.view = { ...VIEW, backstage: true } }, () => { state.view = { ...VIEW } }],
      ['something of the app over the page', () => { state.view = { ...VIEW, covered: true } }, () => { state.view = { ...VIEW } }],
      ['the view gone', () => { state.view = { ...VIEW, found: false } }, () => { state.view = { ...VIEW } }],
      ['no visible part', () => { state.view = { ...VIEW, clip: { x: 0, y: 0, width: 0, height: 0 } } }, () => { state.view = { ...VIEW } }],
      ['the window minimised or hidden', () => { state.window = { ...WINDOW, visible: false } }, () => { state.window = { ...WINDOW } }],
      ['the window closed', () => { state.window = null }, () => { state.window = { ...WINDOW } }],
      ['his setting switched off', () => { state.on = false }, () => { state.on = true }],
    ]
    for (const [why, hide, back] of hiddenBy) {
      hide()
      guide.refresh()
      expect(overlay.shown, why).toBeNull()
      back()
      guide.refresh()
      expect(overlay.shown, `back after: ${why}`).not.toBeNull()
    }
    // A panel beside the page takes its right 300 px: the ring may only be drawn in what is left.
    state.view = { ...VIEW, clip: { x: 300, y: 80, width: 700, height: 700 } }
    guide.refresh()
    expect(overlay.shown!.area).toEqual({ x: 340, y: 105, width: 700, height: 700 })
    expect(made.length).toBe(1)
  })

  it('draws nothing while a fast scroll is in flight, and is back on the target when it comes to rest', async () => {
    const { guide, made, step } = setup({ flightSettleMs: 40 })
    guide.begin(step())
    guide.report(told(400))
    const overlay = made[0]!
    expect(overlay.shown!.rect.y).toBe(505)
    // A slow move (under FLIGHT_PX a report) is followed as it goes.
    guide.report(told(390))
    expect(overlay.shown!.rect.y).toBe(495)
    // A jump: the ring would be drawn a frame behind the element, so it is not drawn at all until the page rests.
    guide.report(told(300))
    expect(overlay.shown).toBeNull()
    guide.report(told(295))
    expect(overlay.shown).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 25))
    guide.report(told(290))
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(overlay.shown, 'a move keeps it in flight').toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(overlay.shown!.rect.y).toBe(395)
    // The step ending mid flight leaves nothing to come back.
    guide.report(told(100))
    expect(overlay.shown).toBeNull()
    guide.end('g1-1')
    await new Promise((resolve) => setTimeout(resolve, 70))
    expect(overlay.shown).toBeNull()
    guide.dispose()
  })

  it('is gone on every end path: step end, dispose, and nothing is drawn after', () => {
    const { guide, made, step } = setup()
    guide.begin(step())
    guide.report(told())
    const overlay = made[0]!
    guide.end('some other step')
    expect(overlay.shown).not.toBeNull()
    guide.end('g1-1')
    expect(overlay.shown).toBeNull()
    // The next step draws in the same overlay.
    guide.begin(step(TOP, 'g1-2'))
    guide.report(told(50, 'g1-2'))
    expect(overlay.shown).not.toBeNull()
    expect(made.length).toBe(1)
    // The guide ends with a ring still up (tab closed, run ended, a newer guide): the window is destroyed.
    guide.dispose()
    expect(overlay.destroyed).toBe(1)
    expect(overlay.shown).toBeNull()
    expect(guide.outside()).toBe(false)
    guide.begin(step(TOP, 'g1-3'))
    guide.report(told(50, 'g1-3'))
    guide.refresh()
    expect(made.length).toBe(1)
    expect(overlay.shown).toBeNull()
  })

  it('a target inside a frame: the frame\'s place is added, kept fresh, and the ring is clipped to the frame', async () => {
    let box = { x: 200, y: 400, width: 400, height: 160, pageWidth: 1000 }
    const { guide, made, step } = setup({ frameBox: async () => ({ ...box }) })
    const inFrame: GuideFrame = { key: 'sid|f1', url: 'https://other.test/frame', top: false }
    guide.begin(step(inFrame))
    guide.report({ token: 'g1-1', shown: true, box: { x: 30, y: 30, width: 90, height: 24 }, tag: { x: 30, y: 64, width: 200, height: 42 }, vw: 400, vh: 160 })
    await expect.poll(() => made[0]?.shown?.rect ?? null).toEqual({ x: 40 + 300 + 200 + 30, y: 25 + 80 + 400 + 30, width: 90, height: 24 })
    expect(made[0]!.shown!.clip).toEqual({ x: 540, y: 505, width: 400, height: 160 })
    expect(made[0]!.shown!.area).toEqual({ x: 340, y: 105, width: 1000, height: 700 })
    // The top page scrolled: the frame moved, the frame's own page said nothing new.
    box = { ...box, y: 300 }
    await expect.poll(() => made[0]!.shown?.rect.y).toBe(25 + 80 + 300 + 30)
    guide.dispose()
  })

  it('reads the view from the app window\'s own markers (fails if the browser card renames them)', () => {
    const host = readFileSync(join(__dirname, '../src/renderer/shell/BrowserHost.tsx'), 'utf8')
    expect(host).toContain("wrap.className = 'br-page'")
    expect(host).toContain("wrap.dataset['tab'] = id")
    expect(host).toContain("classList.toggle('on', front)")
    expect(host).toContain('br-host ${place}')
    expect(host).toContain("'backstage'")
    const script = viewWatchScript('tab-3', '', 800)
    expect(script).toContain('.br-page[data-tab=')
    expect(script).toContain('"tab-3"')
    expect(parseView('{"found":true,"front":true,"backstage":false,"covered":false,"view":{"x":1,"y":2,"width":3,"height":4},"clip":{"x":1,"y":2,"width":3,"height":4}}')).toEqual({ found: true, front: true, backstage: false, covered: false, view: { x: 1, y: 2, width: 3, height: 4 }, clip: { x: 1, y: 2, width: 3, height: 4 } })
    expect(parseView('{"found":false}')?.found).toBe(false)
    expect(parseView('nope')).toBeNull()
  })

  it('the browser wires it: its own overlay per guide, gone with the guide, switched live (source wiring)', () => {
    const src = readFileSync(join(__dirname, '../src/main/browser/browser.ts'), 'utf8')
    expect(src).toContain('const privately = this.privateGuide(tab, sessions)')
    expect(src).toMatch(/finally \{[\s\S]{0,400}privately\?\.stop\(\)/)
    expect(src).toContain('guideModeScript(outside)')
    expect(src).toContain('surface.dispose()')
    const index = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8')
    expect(index).toContain('guidesUseOverlay(settings.get().hideGuidesFromCapture, privacy.exclusion)')
    expect(index).toContain("changed.includes('hideGuidesFromCapture') || changed.includes('hideChatFromCapture')")
    expect(index).toContain('void agentBrowser?.refreshGuidePrivacy()')
    expect(index).toContain("capturePrivacy?.register(win, 'main')")
  })
})

describe('the two settings', () => {
  it('hide guides is on by default, hide the chat is off, both switch live and only he lowers them', () => {
    expect(DEFAULT_SETTINGS.hideGuidesFromCapture).toBe(true)
    expect(DEFAULT_SETTINGS.hideChatFromCapture).toBe(false)
    const dir = mkdtempSync(join(tmpdir(), 'private-guides-'))
    try {
      const settings = new SettingsStore(join(dir, 'settings.json'))
      expect(settings.get().hideGuidesFromCapture).toBe(true)
      const seen: boolean[] = []
      settings.onChange((next) => seen.push(next.hideGuidesFromCapture))
      settings.save({ hideGuidesFromCapture: false })
      settings.save({ hideGuidesFromCapture: 'yes' as never })
      expect(settings.get().hideGuidesFromCapture).toBe(false)
      settings.save({ hideGuidesFromCapture: true, hideChatFromCapture: true })
      expect(seen).toEqual([false, false, true])
      // Kept across a restart.
      expect(new SettingsStore(join(dir, 'settings.json')).get()).toMatchObject({ hideGuidesFromCapture: true, hideChatFromCapture: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(SETTINGS_NEED_APPROVAL.has('hideGuidesFromCapture')).toBe(true)
    expect(SETTINGS_NEED_APPROVAL.has('hideChatFromCapture')).toBe(true)
  })
})

// ---- in a real Chromium ------------------------------------------------------------------------------------------

function findChrome(): string | null {
  const env = process.env.CHROME_PATH
  if (env !== undefined && env !== '' && existsSync(env)) return env
  const base = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(base)) return null
  for (const dir of readdirSync(base).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
    const path = join(base, dir, 'chrome-linux64/chrome')
    if (existsSync(path)) return path
  }
  return null
}
const chrome = findChrome()

const PAGE = `<!doctype html><title>Private</title><body style="margin:0;background:white">
<button id="go" style="margin:60px 40px;width:160px;height:36px">Save changes</button>
<div style="height:1500px"></div></body>`
let portB = 0
const FRAMED = (): string => `<!doctype html><title>Framed</title><body style="margin:0">
<div style="height:90px"></div>
<iframe id="cross" src="http://localhost:${portB}/frame" style="margin-left:70px;width:400px;height:160px;border:5px solid gray;padding:3px"></iframe>
<div style="height:1500px"></div></body>`
const FRAME = `<!doctype html><body style="margin:0"><button id="fb" style="margin:30px;width:120px;height:30px">Inside frame</button><script>document.getElementById('fb').addEventListener('click', (e) => { document.body.dataset.hit = e.clientX + ',' + e.clientY; });</script></body>`

/** The app's debugger link from Playwright sessions, cross-site frames included, with binding calls passed on. */
async function linkFor(page: Page): Promise<GuideLink & { refresh(): Promise<void> }> {
  const main = await page.context().newCDPSession(page)
  const sessions = new Map<string, CDPSession>()
  const listeners = new Set<(method: string, params: Record<string, unknown>, sessionId?: string) => void>()
  const emit = (method: string, params: Record<string, unknown>, sid?: string): void => {
    for (const listener of listeners) listener(method, params, sid)
  }
  const wire = (session: CDPSession, sid?: string): void => {
    for (const method of ['Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Page.frameNavigated', 'Runtime.bindingCalled'] as const) {
      session.on(method, (params: unknown) => emit(method, params as Record<string, unknown>, sid))
    }
  }
  wire(main)
  await main.send('Page.enable')
  await main.send('Runtime.enable')
  const refresh = async (): Promise<void> => {
    for (const f of page.frames()) {
      if (f === page.mainFrame() || f.isDetached()) continue
      let session: CDPSession
      try {
        session = await page.context().newCDPSession(f)
      } catch {
        continue
      }
      const tree = (await session.send('Page.getFrameTree')) as { frameTree: { frame: { id: string; url: string } } }
      const targetId = tree.frameTree.frame.id
      if (sessions.has(targetId)) {
        await session.detach().catch(() => undefined)
        continue
      }
      sessions.set(targetId, session)
      wire(session, targetId)
      await session.send('Page.enable')
      await session.send('Runtime.enable')
      emit('Target.attachedToTarget', { sessionId: targetId, targetInfo: { type: 'iframe', targetId, url: tree.frameTree.frame.url } })
    }
  }
  return {
    send: (method, params = {}, sid) => {
      if (method === 'Target.setAutoAttach') return Promise.resolve({})
      const session = sid === undefined ? main : sessions.get(sid)
      if (session === undefined) return Promise.reject(new Error('No session'))
      return session.send(method as 'Runtime.evaluate', params as never)
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    refresh,
  }
}

async function hostFor(page: Page): Promise<{ host: GuideHost; frames: FrameSessions }> {
  const link = await linkFor(page)
  const frames = new FrameSessions(link)
  await frames.start()
  const host: GuideHost = {
    frames: async () => {
      await link.refresh()
      return frames.frames()
    },
    evaluate: (key, code) => evaluateIn(frames, key, code),
    page: async () => ({ url: page.url(), title: await page.title().catch(() => ''), dialogs: [], text: '' }),
    onNavigate: () => () => undefined,
    onReport: (listener) => frames.onReport(listener),
    loading: () => false,
    ready: async () => undefined,
  }
  return { host, frames }
}

;(chrome === null ? describe.skip : describe)('private guide in a real Chromium', () => {
  let browser: Browser
  let serverA: Server
  let serverB: Server
  let A = ''

  const serve = (handler: (path: string) => string | null): Promise<{ server: Server; port: number }> =>
    new Promise((resolve) => {
      const server = createServer((req, res) => {
        const body = handler((req.url ?? '/').split('?')[0] ?? '/')
        res.writeHead(body === null ? 404 : 200, { 'content-type': 'text/html' })
        res.end(body ?? 'nope')
      })
      server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }))
    })

  beforeAll(async () => {
    const b = await serve((path) => (path === '/frame' ? FRAME : null))
    serverB = b.server
    portB = b.port
    const a = await serve((path) => (path === '/page' ? PAGE : path === '/framed' ? FRAMED() : null))
    serverA = a.server
    A = `http://127.0.0.1:${a.port}`
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox', '--site-per-process'] })
  })

  afterAll(async () => {
    await browser?.close()
    serverA?.close()
    serverB?.close()
  })

  it('paints nothing of the guide in the page, says where the target is as it scrolls, and switches drawing live', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    await page.goto(`${A}/page`)
    const { host, frames } = await hostFor(page)
    const clean = await page.screenshot()
    const surface = recordingSurface()
    const run = runGuide(host, [{ target: { name: 'Save changes', role: 'button' }, label: 'Click Save changes' }], { timeoutMs: 20_000, surface, look: brandLook({ accent: 'ember' }) })
    await expect.poll(() => surface.last()?.shown ?? false, { timeout: 5000 }).toBe(true)
    const el = (await page.locator('#go').boundingBox())!
    expect(surface.last()!.box).toEqual({ x: el.x, y: el.y, width: el.width, height: el.height })
    // What a screen share of the page would send: pixel for pixel the page with no guide at all.
    await page.mouse.move(850, 550)
    expect((await page.screenshot()).equals(clean)).toBe(true)

    // He scrolls: the page tells the new place at once (pushed, never polled for: well under the ask interval's 4x).
    const before = surface.reports.length
    await page.mouse.wheel(0, 30)
    await expect.poll(() => surface.last()?.box?.y, { timeout: 2000 }).toBe(el.y - 30)
    expect(surface.reports.length).toBeGreaterThan(before)

    await page.evaluate(() => scrollTo(0, 0))
    await page.waitForTimeout(150)
    expect((await page.screenshot()).equals(clean)).toBe(true)
    // His setting switched off while the ring shows: the page draws it itself now (the same check goes red).
    const top = (await host.frames())[0]!
    await evaluateIn(frames, top.key, guideModeScript(false))
    await page.waitForTimeout(150)
    expect((await page.screenshot()).equals(clean)).toBe(false)
    // And back on: nothing painted again.
    await evaluateIn(frames, top.key, guideModeScript(true))
    await page.waitForTimeout(150)
    expect((await page.screenshot()).equals(clean)).toBe(true)

    // His real click on the element still ends the step, exactly as before.
    await page.mouse.click(el.x + 10, el.y + 10)
    const result = await run
    expect(result.outcome).toBe('clicked')
    expect(surface.ended).toEqual(surface.begun.map((step) => step.token))
    await page.close()
  })

  it('knows where a cross-site frame is inside the top page, and follows the top page scrolling', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
    await page.goto(`${A}/framed`)
    await page.frameLocator('#cross').locator('#fb').waitFor()
    const { host, frames } = await hostFor(page)
    const all = await host.frames()
    const cross = all.find((frame) => !frame.top)!
    expect(cross.url).toContain(`localhost:${portB}`)
    // margin-left 70 + border 5 + padding 3; the block above is 90 tall, + border + padding.
    expect(await frames.frameBox(cross.key)).toEqual({ x: 78, y: 98, width: 400, height: 160 })
    await page.evaluate(() => scrollTo(0, 40))
    expect(await frames.frameBox(cross.key)).toEqual({ x: 78, y: 58, width: 400, height: 160 })
    // The button's place on the page = the frame's place + its place in the frame.
    const surface = recordingSurface()
    const run = runGuide(host, [{ target: { name: 'Inside frame' }, label: 'Click inside the frame' }], { timeoutMs: 15_000, surface })
    await expect.poll(() => surface.last()?.shown ?? false, { timeout: 5000 }).toBe(true)
    const inFrame = surface.last()!.box!
    expect(inFrame).toEqual({ x: 30, y: 30, width: 120, height: 30 })
    expect(surface.current()!.frame.key).toBe(cross.key)
    // The button's place on the page = the frame's place + its place in the frame. Proven by a real click one pixel
    // inside its far corner as worked out that way: the frame gets it there, at its own 149,59.
    await page.mouse.click(78 + inFrame.x + inFrame.width - 1, 58 + inFrame.y + inFrame.height - 1)
    expect((await run).outcome).toBe('clicked')
    expect(await page.frameLocator('#cross').locator('body').getAttribute('data-hit')).toBe('149,59')
    await page.close()
  })

  it('the overlay page draws the ring exactly on the rectangle it is given, scaled and clipped, in the chosen accent', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
    const lines: string[] = []
    page.on('console', (message) => lines.push(message.text()))
    const violet = brandLook({ theme: 'light', accent: 'violet' })
    await page.setContent(overlayHtml(violet))
    await expect.poll(() => lines.some((line) => line === `${OVERLAY_EVENT}{"type":"ready"}`)).toBe(true)
    type Read = { shown: boolean; ring: { x: number; y: number; width: number; height: number } | null; tag: { x: number; y: number; width: number; height: number } | null; ok: { x: number; y: number; width: number; height: number } | null; label: string; n: string }
    const read = (): Promise<Read> => page.evaluate(OVERLAY_READ_SCRIPT) as Promise<Read>
    expect((await read()).shown).toBe(false)

    // k = 1: the ring is the target grown by the pad on every side.
    await page.evaluate(overlaySetScript({ clip: { x: 0, y: 0, width: 800, height: 500 }, ring: { x: 200, y: 120, width: 160, height: 36 }, k: 1, tag: { x: 200, y: 170, width: 240 }, n: '2/3', label: 'Click Save changes' }))
    let now = await read()
    expect(now.ring).toEqual({ x: 200 - RING_PAD, y: 120 - RING_PAD, width: 160 + RING_PAD * 2, height: 36 + RING_PAD * 2 })
    expect(now.tag).toMatchObject({ x: 200, y: 170, width: 240 })
    expect([now.label, now.n]).toEqual(['Click Save changes', '2/3'])
    const colour = await page.evaluate(() => getComputedStyle(document.querySelector('.ring')!).borderTopColor)
    const hex = ACCENTS.find((a) => a.id === 'violet')!.light![0]
    expect(colour).toBe(`rgb(${Number.parseInt(hex.slice(1, 3), 16)}, ${Number.parseInt(hex.slice(3, 5), 16)}, ${Number.parseInt(hex.slice(5, 7), 16)})`)

    // A page shown at 125%, inside a clip that starts at 50,40: the pad and the label scale with it.
    await page.evaluate(overlaySetScript({ clip: { x: 50, y: 40, width: 600, height: 300 }, ring: { x: 250, y: 140, width: 200, height: 50 }, k: 1.25, tag: null, n: '', label: 'Type the name' }))
    now = await read()
    expect(now.ring).toEqual({ x: 250 - RING_PAD * 1.25, y: 140 - RING_PAD * 1.25, width: 200 + RING_PAD * 2.5, height: 50 + RING_PAD * 2.5 })
    // No place given: the label is put beside the ring, inside the clip, never on it.
    const t = now.tag!
    expect(t.x >= 50 && t.y >= 40 && t.x + t.width <= 650 && t.y + t.height <= 340).toBe(true)
    expect(t.x < 450 && t.x + t.width > 250 && t.y < 190 && t.y + t.height > 140).toBe(false)

    // Half out of the clip: what is outside is cut off (the clip box hides it), and nothing at all once it is null.
    await page.evaluate(overlaySetScript({ clip: { x: 50, y: 40, width: 600, height: 300 }, ring: { x: 20, y: 140, width: 100, height: 50 }, k: 1, tag: null, n: '', label: 'Cut' }))
    const clipBox = await page.evaluate(() => { const c = document.querySelector('.clip')!; return [getComputedStyle(c).overflow, c.getBoundingClientRect().left] })
    expect(clipBox).toEqual(['hidden', 50])
    await page.evaluate(overlaySetScript(null))
    expect((await read()).shown).toBe(false)

    // The pointer over a button is told (so the window takes the click); a real click says which button.
    await page.evaluate(overlaySetScript({ clip: { x: 0, y: 0, width: 800, height: 500 }, ring: { x: 200, y: 120, width: 160, height: 36 }, k: 1, tag: { x: 200, y: 170 }, n: '', label: 'Click it' }))
    const ok = (await read()).ok!
    await page.mouse.move(ok.x + ok.width / 2, ok.y + ok.height / 2)
    await expect.poll(() => lines.includes(`${OVERLAY_EVENT}{"type":"hover","on":true}`)).toBe(true)
    await page.mouse.click(ok.x + ok.width / 2, ok.y + ok.height / 2)
    await expect.poll(() => lines.includes(`${OVERLAY_EVENT}{"type":"act","outcome":"done"}`)).toBe(true)
    await page.mouse.move(10, 10)
    await expect.poll(() => lines.includes(`${OVERLAY_EVENT}{"type":"hover","on":false}`)).toBe(true)
    // A real press is said once, though both its release and its click arrive.
    expect(lines.filter((line) => line.includes('"act"')).length).toBe(1)

    // Windows hands this window the release of a real press without the press, so no click is made: the release
    // alone, on a button the pointer came to with no button held, is the press. Said once.
    const cdp = await page.context().newCDPSession(page)
    const skip = (await read()).skip!
    const at = { x: skip.x + skip.width / 2, y: skip.y + skip.height / 2 }
    const count = (): number => lines.filter((line) => line.includes('"act"')).length
    await page.waitForTimeout(450)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 })
    await expect.poll(() => lines.includes(`${OVERLAY_EVENT}{"type":"act","outcome":"skipped"}`)).toBe(true)
    await page.waitForTimeout(150)
    expect(count()).toBe(2)
    // A drag that began elsewhere (in the page underneath) and is let go on a button is not a press.
    await page.waitForTimeout(450)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 10, buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 20, y: 20, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, button: 'left', buttons: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 })
    await page.waitForTimeout(150)
    expect(count()).toBe(2)
    // A release of another button is not a press either.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y, buttons: 0 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'right', buttons: 0, clickCount: 1 })
    await page.waitForTimeout(150)
    expect(count()).toBe(2)
    await cdp.detach()
    // A script's click is not his.
    const acts = lines.filter((line) => line.includes('"act"')).length
    await page.evaluate(() => (document.querySelector('.skip') as HTMLButtonElement).click())
    await page.waitForTimeout(100)
    expect(lines.filter((line) => line.includes('"act"')).length).toBe(acts)
    await page.close()
  })

  it('reads where the view is in the app window: clipped by its card, free of it when shown full size, covered, parked', async () => {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } })
    await page.setContent(`<body style="margin:0"><div class="win">
<div class="panel" style="position:absolute;left:0;top:0;width:380px;height:500px;overflow:hidden">
 <div class="br-view" style="position:relative;margin:100px 0 0 20px;width:340px;height:250px;overflow:hidden">
  <div class="br-host card" id="host"><div class="br-page on" data-tab="tab-1" style="width:1000px;height:600px"><webview style="display:block;width:1000px;height:600px"></webview></div></div>
 </div>
</div>
<div id="cover" hidden style="position:fixed;left:0;top:0;width:100%;height:100%"></div></div></body>`)
    const read = async (prev = ''): Promise<{ text: string; view: ReturnType<typeof parseView> }> => {
      const text = (await page.evaluate(viewWatchScript('tab-1', prev, 800))) as string
      return { text, view: parseView(text) }
    }
    // In its card: the page is 1000 wide, the card shows 340 x 250 of it.
    const card = await read()
    expect(card.view).toEqual({ found: true, front: true, backstage: false, covered: false, view: { x: 20, y: 100, width: 1000, height: 600 }, clip: { x: 20, y: 100, width: 340, height: 250 } })
    // Shown full size (a fixed box over the window): the card no longer clips it; only the window's edge does.
    const waiting = read(card.text)
    await page.waitForTimeout(100)
    const at = Date.now()
    await page.evaluate(() => { const host = document.getElementById('host')!; host.className = 'br-host full'; host.style.cssText = 'position:fixed;left:400px;top:50px;width:300px;height:200px' })
    const full = await waiting
    // Heard in the frame it changed, not at the end of the wait.
    expect(Date.now() - at).toBeLessThan(500)
    expect(full.view).toMatchObject({ front: true, backstage: false, view: { x: 400, y: 50, width: 1000, height: 600 }, clip: { x: 400, y: 50, width: 400, height: 450 } })
    // Something of the app over it, another tab in front, parked behind the app, another tab's id.
    await page.evaluate(() => { document.getElementById('cover')!.hidden = false })
    expect((await read()).view?.covered).toBe(true)
    await page.evaluate(() => { document.getElementById('cover')!.hidden = true; document.querySelector('.br-page')!.classList.remove('on'); document.getElementById('host')!.classList.add('backstage') })
    expect((await read()).view).toMatchObject({ found: true, front: false, backstage: true, covered: false })
    expect(parseView(await page.evaluate(viewWatchScript('tab-9', '', 100)))?.found).toBe(false)
    await page.close()
  })

  it('report mode is asked for only when drawing outside; the plain script is untouched', () => {
    const base = { token: 't', query: { name: 'Go' }, mode: 'exact' as const, pick: 0, label: 'Click Go', step: 1, total: 1 }
    expect(guideShowScript(base)).not.toContain('"report":true')
    expect(guideShowScript({ ...base, report: true })).toContain('"report":true')
    expect(parseReport('{"token":"t","shown":true,"box":{"x":1,"y":2,"width":3,"height":4},"vw":10,"vh":20}')).toEqual({ token: 't', shown: true, box: { x: 1, y: 2, width: 3, height: 4 }, vw: 10, vh: 20 })
    expect(parseReport('{"token":"t","shown":true}')).toEqual({ token: 't', shown: false })
    expect(parseReport('{"shown":true}')).toBeNull()
    expect(parseReport('junk')).toBeNull()
  })
})
