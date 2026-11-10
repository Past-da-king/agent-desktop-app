/**
 * The browser guide drawn privately (10 Nov 2026): the in-app browser's side of the guide overlay. The page script
 * reports where its target is (guide-page.ts report mode); this turns each report into a rectangle on the SCREEN
 * (guide-geometry.ts) and has the overlay window draw the ring there (overlay/guide-overlay.ts), so a screen share of
 * the page shows no ring while he still sees it.
 *
 * It draws only when all of this holds, and hides the moment one stops holding: his setting is on and this computer
 * can hide a window from capture; the page says the target is there; the page's own view is on screen, in front
 * (this tab, not parked, nothing of the app over it) and has a visible part; the app window is shown and not
 * minimised. The overlay is a child of the app window covering exactly the view's visible part, so it never draws
 * over the app's own toolbar or a panel beside the page, and never floats over another app.
 *
 * Free of Electron (the browser hands in the window's facts), so the whole life cycle is tested with fakes.
 */
import type { BrandLook } from '../../shared/brand'
import type { OverlayShow, OverlayState } from '../overlay/guide-overlay'
import { isEmpty, type Rect } from '../overlay/rect'
import type { GuideFrame, GuideSurface, GuideSurfaceStep } from './guide'
import { guideGeometry, pageToScreen } from './guide-geometry'
import type { GuideReport } from './guide-page'

/** Where the page's view (its <webview>) is in the app window, in the window's own CSS px. */
export interface ViewInfo {
  /** The view element exists in the window. */
  found: boolean
  /** It is the tab in front. */
  front: boolean
  /** Parked behind the app (panel hidden or scrolled away): on screen for painting only, not for him. */
  backstage: boolean
  /** Something of the app (a dialog, a menu) is drawn over it. */
  covered: boolean
  view: Rect
  /** The part of it not clipped away by its card, the panel's scroll area or the window's edge. */
  clip: Rect
}

export interface WindowInfo {
  /** The window's content area on the screen, DIPs. */
  content: { x: number; y: number }
  /** The window's own zoom factor. */
  zoom: number
  /** Shown and not minimised. */
  visible: boolean
}

/** The overlay, as this uses it (overlay/guide-overlay.ts GuideOverlay). */
export interface PrivateOverlay {
  show(spec: OverlayShow): void
  hide(): void
  destroyAll(): void
  state(): OverlayState
}

export interface PrivateGuideDeps {
  /** His setting, and whether this computer can hide a window from capture, read live. */
  outside: () => boolean
  /** Makes the overlay. Called only when something is first drawn outside the page, never before. */
  overlay: () => PrivateOverlay
  /** The app window (the overlay's owner). */
  owner: object
  view: () => ViewInfo | null
  window: () => WindowInfo | null
  look: () => BrandLook
  /** A frame's viewport inside the top page's (CSS px), and the top page's width. Null: cannot be known now. */
  frameBox: (frame: GuideFrame) => Promise<(Rect & { pageWidth: number }) | null>
  /** How often a target inside a frame has its frame's place read again (the frame moves when its page scrolls). */
  frameEveryMs?: number
  /** How long after the target last moved in a fast scroll the ring is drawn again. Default FLIGHT_SETTLE_MS; 0: it is never hidden for a scroll. */
  flightSettleMs?: number
}

export const FRAME_EVERY_MS = 60
/**
 * A fast scroll: the page says where its target is a frame after it moved, so a ring that follows a target jumping
 * this far (page px) between two reports would be drawn visibly behind it. While such a scroll is in flight nothing
 * is drawn; the ring is back, on the target, this long after the target last moved.
 */
export const FLIGHT_PX = 24
export const FLIGHT_SETTLE_MS = 90

export class PrivateGuide implements GuideSurface {
  private overlay: PrivateOverlay | null = null
  private step: GuideSurfaceStep | null = null
  private last: GuideReport | null = null
  private box: (Rect & { pageWidth: number }) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private reading = false
  private disposed = false
  private flight: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: PrivateGuideDeps) {}

  outside(): boolean {
    return !this.disposed && this.deps.outside()
  }

  begin(step: GuideSurfaceStep): void {
    this.stopFrame()
    this.land()
    this.step = step
    this.last = null
    this.box = null
    if (!step.frame.top) {
      // A target inside a frame: the frame's own place is read now and kept fresh while the step shows.
      void this.readFrame()
      this.timer = setInterval(() => void this.readFrame(), this.deps.frameEveryMs ?? FRAME_EVERY_MS)
      this.timer.unref?.()
    }
    this.draw()
  }

  report(report: GuideReport): void {
    if (this.step === null || report.token !== this.step.token) return
    const before = this.last
    this.last = report
    const a = before !== null && before.shown ? before.box : undefined
    const b = report.shown ? report.box : undefined
    const moved = a !== undefined && b !== undefined ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) : 0
    // In flight already: any further move keeps it so. Not yet: only a jump starts one.
    const settle = this.deps.flightSettleMs ?? FLIGHT_SETTLE_MS
    if (settle > 0 && (moved >= FLIGHT_PX || (this.flight !== null && moved > 0))) {
      if (this.flight !== null) clearTimeout(this.flight)
      this.flight = setTimeout(() => {
        this.flight = null
        this.draw()
      }, settle)
      this.flight.unref?.()
    }
    this.draw()
  }

  private land(): void {
    if (this.flight !== null) clearTimeout(this.flight)
    this.flight = null
  }

  end(token: string): void {
    if (this.step === null || this.step.token !== token) return
    this.stopFrame()
    this.land()
    this.step = null
    this.last = null
    this.box = null
    this.overlay?.hide()
  }

  /** Something outside the page changed (the view moved, the window moved or hid, his setting or his theme). */
  refresh(): void {
    this.draw()
  }

  /** The guide is over, whatever ended it: nothing stays on the screen. */
  dispose(): void {
    this.disposed = true
    this.stopFrame()
    this.land()
    this.step = null
    this.last = null
    const overlay = this.overlay
    this.overlay = null
    overlay?.destroyAll()
  }

  /** What is on the screen now (for a check). */
  state(): OverlayState | null {
    return this.overlay?.state() ?? null
  }

  private stopFrame(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private async readFrame(): Promise<void> {
    const step = this.step
    if (step === null || this.reading || !this.outside()) return
    this.reading = true
    try {
      const box = await this.deps.frameBox(step.frame).catch(() => null)
      if (this.step !== step) return
      const before = this.box
      this.box = box
      if (JSON.stringify(before) !== JSON.stringify(box)) this.draw()
    } finally {
      this.reading = false
    }
  }

  private draw(): void {
    const spec = this.wanted()
    if (spec === null) {
      this.overlay?.hide()
      return
    }
    if (this.overlay === null) this.overlay = this.deps.overlay()
    this.overlay.show(spec)
  }

  private wanted(): OverlayShow | null {
    const step = this.step
    const report = this.last
    if (this.disposed || step === null || report === null || !report.shown || report.box === undefined) return null
    if (this.flight !== null) return null
    if (!this.deps.outside()) return null
    const view = this.deps.view()
    const win = this.deps.window()
    if (view === null || win === null || !win.visible) return null
    if (!view.found || !view.front || view.backstage || view.covered || isEmpty(view.clip)) return null
    let frame: Rect
    let pageWidth: number
    if (step.frame.top) {
      if (report.vw === undefined || report.vh === undefined) return null
      frame = { x: 0, y: 0, width: report.vw, height: report.vh }
      pageWidth = report.vw
    } else {
      if (this.box === null) return null
      frame = { x: this.box.x, y: this.box.y, width: this.box.width, height: this.box.height }
      pageWidth = this.box.pageWidth
    }
    const g = guideGeometry({ target: report.box, frame, pageWidth, view: view.view, viewClip: view.clip, windowZoom: win.zoom, content: win.content })
    if (g === null || !g.visible) return null
    const tag = report.tag === undefined ? null : pageToScreen(report.tag, g.origin, g.k)
    return {
      rect: g.target,
      label: step.label,
      step: step.n,
      of: step.total,
      look: this.deps.look(),
      owner: this.deps.owner,
      area: g.viewClip,
      clip: g.clip,
      labelAt: tag === null ? null : { x: tag.x, y: tag.y, width: tag.width },
      scale: g.k,
      onAct: step.act,
    }
  }
}

/**
 * Runs in the APP WINDOW (not in the page): where the tab's <webview> is, what clips it, and whether it is the page
 * in front with nothing of the app over it. Resolves when that differs from `prev` (so the main process hears of a
 * move in the frame it happens), or after `waitMs` at the latest. Reads the DOM only; changes nothing.
 * The visible part follows the page wherever the workspace puts it: beside or above a docked chat, under the slim
 * bar, in full-screen browser mode, or in the side panel's card.
 * The markers it relies on are the browser card's own (renderer/shell/BrowserHost.tsx): `.br-page[data-tab]`,
 * `.br-host`, the classes `on` and `backstage`; test/guide-private.test.ts fails if they are renamed.
 */
export function viewWatchScript(tabId: string, prev: string, waitMs: number): string {
  return `new Promise((resolve) => {
  const read = (deep) => {
    const wrap = document.querySelector('.br-page[data-tab=' + JSON.stringify(${JSON.stringify(tabId)}) + ']');
    const view = wrap ? wrap.querySelector('webview') : null;
    if (!wrap || !view) return JSON.stringify({ found: false });
    const host = wrap.closest('.br-host');
    const r = view.getBoundingClientRect();
    let left = Math.max(0, r.left), top = Math.max(0, r.top), right = Math.min(innerWidth, r.right), bottom = Math.min(innerHeight, r.bottom);
    // An ancestor clips only what it contains. A box taken out of the flow (the page in browser view is position
    // fixed, though it is a child of the side panel's small card) is not clipped by the ancestors it escapes: a fixed
    // box by none up to one that holds fixed boxes, an absolute box by none up to its positioned ancestor.
    const holdsFixed = (s) => s.transform !== 'none' || s.perspective !== 'none' || s.filter !== 'none' || (s.backdropFilter || 'none') !== 'none' || /paint|layout|strict|content/.test(s.contain || '') || /transform|perspective|filter/.test(s.willChange || '') || (s.containerType || 'normal') !== 'normal';
    const out = (s) => (s.position === 'fixed' ? 'fixed' : s.position === 'absolute' ? 'absolute' : '');
    let free = out(getComputedStyle(view));
    for (let p = view.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (free === 'fixed' && !holdsFixed(s)) continue;
      if (free === 'absolute' && s.position === 'static' && !holdsFixed(s)) continue;
      free = out(s);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const b = p.getBoundingClientRect();
      left = Math.max(left, b.left + p.clientLeft); top = Math.max(top, b.top + p.clientTop);
      right = Math.min(right, b.left + p.clientLeft + p.clientWidth); bottom = Math.min(bottom, b.top + p.clientTop + p.clientHeight);
    }
    const clip = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
    let covered = false;
    if (deep && host && clip.width > 8 && clip.height > 8) {
      for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.1, 0.5, 0.9]) {
        const el = document.elementFromPoint(clip.x + clip.width * fx, clip.y + clip.height * fy);
        if (el && !host.contains(el)) covered = true;
      }
    }
    return JSON.stringify({ found: true, front: wrap.classList.contains('on'), backstage: !!(host && host.classList.contains('backstage')), covered, view: { x: r.left, y: r.top, width: r.width, height: r.height }, clip });
  };
  const prev = ${JSON.stringify(prev)};
  let done = false;
  let n = 0;
  let covered = /"covered":true/.test(prev);
  const finish = (text) => { if (done) return; done = true; clearTimeout(timer); resolve(text); };
  const timer = setTimeout(() => finish(read(true)), ${Math.max(50, Math.floor(waitMs))});
  const tick = () => {
    if (done) return;
    // What covers the view is looked for a few times a second; where the view is, every frame.
    const deep = n++ % 8 === 0;
    let now = read(deep);
    if (!deep && covered) now = now.replace('"covered":false', '"covered":true');
    else if (deep) covered = /"covered":true/.test(now);
    if (now !== prev) finish(now); else requestAnimationFrame(tick);
  };
  tick();
})`
}

export function parseView(value: unknown): ViewInfo | null {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const rect = (v: unknown): Rect => {
    const r = (v !== null && typeof v === 'object' ? v : {}) as Record<string, unknown>
    const n = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    return { x: n(r['x']), y: n(r['y']), width: n(r['width']), height: n(r['height']) }
  }
  return { found: o['found'] === true, front: o['front'] === true, backstage: o['backstage'] === true, covered: o['covered'] === true, view: rect(o['view']), clip: rect(o['clip']) }
}
