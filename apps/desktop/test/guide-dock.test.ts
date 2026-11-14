/**
 * The guide overlay and the browser workspace together (10 Nov 2026): with the chat docked beside the page (or under
 * it), the ring may only be drawn on the page area that is left, it follows the dock being dragged, the slim bar and
 * full-screen browser mode, and it is gone when the browser view closes.
 *   - with fakes: the overlay rectangle for the layouts measured in the real app (window 1280x820);
 *   - in a real Chromium: the app window's own layout, read by the same script the app runs (viewWatchScript).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { chromium, type Browser } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { GuideFrame, GuideSurfaceStep } from '../src/main/browser/guide'
import type { GuideReport } from '../src/main/browser/guide-page'
import { parseView, PrivateGuide, viewWatchScript, type PrivateOverlay, type ViewInfo, type WindowInfo } from '../src/main/browser/guide-private'
import type { OverlayShow, OverlayState } from '../src/main/overlay/guide-overlay'
import { brandLook } from '../src/shared/brand'

class FakeOverlay implements PrivateOverlay {
  shown: OverlayShow | null = null
  destroyed = 0
  show(spec: OverlayShow): void { this.shown = spec }
  hide(): void { this.shown = null }
  destroyAll(): void { this.destroyed++; this.shown = null }
  state(): OverlayState { return { shown: this.shown !== null, displayId: 1, rect: this.shown?.rect ?? null, protected: true, windows: 1 } }
}

const TOP: GuideFrame = { key: '|top', url: 'https://example.test/', top: true }
const box = (x: number, y: number, width: number, height: number): { x: number; y: number; width: number; height: number } => ({ x, y, width, height })
const viewAt = (x: number, y: number, width: number, height: number): ViewInfo => ({ found: true, front: true, backstage: false, covered: false, view: box(x, y, width, height), clip: box(x, y, width, height) })

// The page area in the app window, as measured in the built app at 1280x820 (proof-0.2.124/workspace/real-app).
const CHAT_FOLDED = viewAt(0, 106, 1280, 714)
const DOCK_OPEN = viewAt(0, 106, 880, 714) // the chat takes the right 400
const DOCK_DRAGGED = viewAt(0, 106, 560, 714) // dragged to its widest, 720
const FULL_SCREEN_DOCK = viewAt(0, 42, 880, 778) // no top bar, the toolbar only
const FULL_SCREEN = viewAt(0, 42, 1280, 778)
const DOCK_BELOW = viewAt(0, 114, 390, 380) // a 390 wide window: the chat is under the page

function setup(first: ViewInfo): { guide: PrivateGuide; overlay: () => FakeOverlay | null; state: { view: ViewInfo | null; window: WindowInfo } } {
  let made: FakeOverlay | null = null
  const state = { view: first as ViewInfo | null, window: { content: { x: 100, y: 60 }, zoom: 1, visible: true } as WindowInfo }
  const guide = new PrivateGuide({
    outside: () => true,
    overlay: () => (made = new FakeOverlay()),
    owner: {},
    view: () => state.view,
    window: () => state.window,
    look: () => brandLook({ theme: 'light', accent: 'teal' }),
    frameBox: async () => null,
    flightSettleMs: 0,
  })
  return { guide, overlay: () => made, state }
}

const step: GuideSurfaceStep = { token: 't', frame: TOP, label: 'Click Check out', n: 1, total: 1, act: () => undefined }
/** A button 120x36 at page x, y, in a page as wide as its view. */
const told = (x: number, y: number, vw: number, vh: number): GuideReport => ({ token: 't', shown: true, box: box(x, y, 120, 36), tag: box(x, y + 46, 200, 40), vw, vh })

describe('guide overlay with the chat docked', () => {
  it('covers only the page area that is left beside the dock, and rings the element where it is on the screen', () => {
    const { guide, overlay, state } = setup(DOCK_OPEN)
    guide.begin(step)
    guide.report(told(40, 200, 880, 714))
    const shown = overlay()!.shown!
    // window content 100,60 + page area 0,106 + element 40,200
    expect(shown.rect).toEqual(box(140, 366, 120, 36))
    expect(shown.area).toEqual(box(100, 166, 880, 714))
    expect(shown.clip).toEqual(shown.area)
    // Nothing of the overlay reaches into the chat: its right edge is the dock's left edge (window x 880).
    expect(shown.area!.x + shown.area!.width).toBe(100 + 880)
    expect(state.view).toBe(DOCK_OPEN)
  })

  it('follows the dock being dragged, folded and opened, and the page reflowing with it', () => {
    const { guide, overlay, state } = setup(DOCK_OPEN)
    guide.begin(step)
    guide.report(told(700, 200, 880, 714))
    expect(overlay()!.shown!.rect).toEqual(box(800, 366, 120, 36))
    // Dragged wider: the page area is 560 wide now and the page has not yet said where its button went. Until it
    // does, the ring is drawn by the one measured scale, so it stays inside the page area and never on the chat.
    state.view = DOCK_DRAGGED
    guide.refresh()
    const between = overlay()!.shown!
    expect(between.area).toEqual(box(100, 166, 560, 714))
    expect(between.rect.x + between.rect.width).toBeLessThanOrEqual(100 + 560)
    // The page reflowed and reports again: the ring is back, inside the narrower area.
    guide.report(told(400, 200, 560, 714))
    expect(overlay()!.shown!.rect).toEqual(box(500, 366, 120, 36))
    expect(overlay()!.shown!.area).toEqual(box(100, 166, 560, 714))
    // Folded away: the page has the whole width.
    state.view = CHAT_FOLDED
    guide.report(told(1100, 200, 1280, 714))
    expect(overlay()!.shown!.area).toEqual(box(100, 166, 1280, 714))
    expect(overlay()!.shown!.rect).toEqual(box(1200, 366, 120, 36))
  })

  it('a page drawn narrower than it thinks it is (a reflow not yet reported) keeps the ring inside the page area', () => {
    const { guide, overlay, state } = setup(DOCK_OPEN)
    guide.begin(step)
    // The page still says it is 1280 wide while its view is 880: drawn by the one measured scale, never past the dock.
    guide.report(told(1100, 200, 1280, 714))
    const shown = overlay()!.shown!
    expect(shown.scale).toBeCloseTo(880 / 1280, 6)
    expect(shown.rect.x + shown.rect.width).toBeLessThanOrEqual(100 + 880)
    expect(state.view).toBe(DOCK_OPEN)
  })

  it('follows full-screen browser mode and the slim bar: the page area starts higher and the ring moves with it', () => {
    const { guide, overlay, state } = setup(DOCK_OPEN)
    guide.begin(step)
    guide.report(told(40, 200, 880, 714))
    expect(overlay()!.shown!.rect.y).toBe(60 + 106 + 200)
    // Full screen: the window itself moves to the screen's corner and the top bar goes.
    state.window = { content: { x: 0, y: 0 }, zoom: 1, visible: true }
    state.view = FULL_SCREEN_DOCK
    guide.report(told(40, 200, 880, 778))
    expect(overlay()!.shown!.rect).toEqual(box(40, 242, 120, 36))
    expect(overlay()!.shown!.area).toEqual(box(0, 42, 880, 778))
    state.view = FULL_SCREEN
    guide.report(told(40, 200, 1280, 778))
    expect(overlay()!.shown!.area).toEqual(box(0, 42, 1280, 778))
  })

  it('with the chat under the page (a narrow window) the overlay stops at the chat\'s top edge', () => {
    const { guide, overlay } = setup(DOCK_BELOW)
    guide.begin(step)
    guide.report(told(20, 100, 390, 380))
    expect(overlay()!.shown!.area).toEqual(box(100, 174, 390, 380))
    // An element the page has below its visible part (behind the chat) is not ringed.
    guide.report(told(20, 400, 390, 380))
    expect(overlay()!.shown).toBeNull()
  })

  it('is hidden when the browser view closes and the page is parked, and destroyed when the guide ends', () => {
    const { guide, overlay, state } = setup(DOCK_OPEN)
    guide.begin(step)
    guide.report(told(40, 200, 880, 714))
    expect(overlay()!.shown).not.toBeNull()
    state.view = { ...DOCK_OPEN, backstage: true }
    guide.refresh()
    expect(overlay()!.shown).toBeNull()
    state.view = { ...DOCK_OPEN, found: false }
    guide.refresh()
    expect(overlay()!.shown).toBeNull()
    guide.dispose()
    expect(overlay()!.destroyed).toBe(1)
  })

  it('the workspace keeps the names this relies on', () => {
    const panel = readFileSync(join(__dirname, '../src/renderer/shell/Panel.tsx'), 'utf8')
    expect(panel).toContain('className="br-stage-view"')
    expect(panel).toContain('className="br-dock"')
    const css = readFileSync(join(__dirname, '../src/renderer/styles/workspace.css'), 'utf8')
    expect(css).toContain('body.dock-dragging .br-host{pointer-events:none!important}')
  })
})

// ---- the app window's layout in a real Chromium ---------------------------------------------------------------------

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

/**
 * The browser view as the app lays it out: the stage is a grid of the page column and the dock, and the host follows
 * the page area. As in the app, the host is a child of the side panel's small card (clipped, in a parked panel) and
 * is taken out of it with position fixed: the card must not be mistaken for what clips the page.
 */
const WINDOW_HTML = `<!doctype html><body style="margin:0">
<style>
.bar{height:30px}
.br-stage{display:grid;height:calc(100vh - 30px);grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr)}
.br-stage.dock-side{grid-template-columns:minmax(0,1fr) var(--dock-w,400px)}
.br-stage.dock-below{grid-template-rows:minmax(0,1fr) minmax(220px,46%)}
.br-stage-main{display:grid;grid-template-rows:76px minmax(0,1fr);min-width:0;min-height:0}
.br-stage-view{position:relative;min-height:0;overflow:hidden}
.br-dock{position:relative;min-width:0;min-height:0;overflow:hidden}
.br-host{position:fixed;overflow:hidden;z-index:30}
.br-page{position:absolute;inset:0;display:none}.br-page.on{display:block}
webview{display:block;width:100%;height:100%}
body.dock-dragging .br-host{pointer-events:none!important}
</style>
<div class="bar"></div>
<div class="br-stage dock-side"><div class="br-stage-main"><div class="chrome"></div><div class="br-stage-view"></div></div><aside class="br-dock"></aside></div>
<aside class="panel-w" style="position:absolute;left:0;top:0;width:380px;height:100%;overflow:hidden;visibility:hidden"><div class="br-view" style="position:relative;margin:208px 20px 0;width:338px;height:342px;overflow:hidden">
<div class="br-host full" style="visibility:visible"><div class="br-page on" data-tab="tab-1"><webview></webview></div></div></div></aside>
<script>
const follow = () => { const r = document.querySelector('.br-stage-view').getBoundingClientRect(); const h = document.querySelector('.br-host'); h.style.left = r.left + 'px'; h.style.top = r.top + 'px'; h.style.width = r.width + 'px'; h.style.height = r.height + 'px'; };
new ResizeObserver(follow).observe(document.querySelector('.br-stage-view')); follow();
</script></body>`

;(chrome === null ? describe.skip : describe)('guide overlay with the chat docked, in a real Chromium', () => {
  let browser: Browser
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chrome ?? undefined, args: ['--no-sandbox'] })
  })
  afterAll(async () => {
    await browser?.close()
  })

  it('reads the page area that is left: beside the dock, after a drag, under no dock, above a dock below, and covered while dragging', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    await page.setContent(WINDOW_HTML)
    const read = async (): Promise<ViewInfo> => parseView(await page.evaluate(viewWatchScript('tab-1', '', 60)))!
    let view = await read()
    expect(view).toMatchObject({ found: true, front: true, backstage: false, covered: false })
    expect(view.clip).toEqual({ x: 0, y: 106, width: 880, height: 714 })
    expect(view.view).toEqual(view.clip)

    await page.evaluate(() => document.querySelector<HTMLElement>('.br-stage')!.style.setProperty('--dock-w', '720px'))
    await page.waitForFunction(() => document.querySelector('.br-host')!.getBoundingClientRect().width === 560)
    view = await read()
    expect(view.clip).toEqual({ x: 0, y: 106, width: 560, height: 714 })

    // While the handle is dragged the page takes no pointer: the app is "over" it, and the ring waits.
    await page.evaluate(() => document.body.classList.add('dock-dragging'))
    expect((await read()).covered).toBe(true)
    await page.evaluate(() => document.body.classList.remove('dock-dragging'))
    expect((await read()).covered).toBe(false)

    await page.evaluate(() => { document.querySelector('.br-stage')!.className = 'br-stage'; document.querySelector('.br-dock')!.remove() })
    await page.waitForFunction(() => document.querySelector('.br-host')!.getBoundingClientRect().width === 1280)
    expect((await read()).clip).toEqual({ x: 0, y: 106, width: 1280, height: 714 })
    await page.close()

    const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } })
    await narrow.setContent(WINDOW_HTML.replace('br-stage dock-side', 'br-stage dock-below'))
    const below = parseView(await narrow.evaluate(viewWatchScript('tab-1', '', 60)))!
    const dockTop = await narrow.evaluate(() => document.querySelector('.br-dock')!.getBoundingClientRect().top)
    expect(below.clip.x).toBe(0)
    expect(below.clip.width).toBe(390)
    expect(below.clip.y + below.clip.height).toBe(dockTop)
    await narrow.close()
  })
})
