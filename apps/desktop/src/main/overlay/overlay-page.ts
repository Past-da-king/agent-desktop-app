/**
 * The page inside the guide overlay window (10 Nov 2026): the ring and the label, drawn exactly as the in-page guide
 * draws them (the same guideStyle from the app's brand tokens, so the two cannot drift apart), at the place the main
 * process gives. Plain strings: the window loads the document, the main process pushes each new state with
 * executeJavaScript, and the page answers through console.debug lines with a prefix (no preload, no Node, no
 * network; the window is sandboxed).
 *
 * All positions arrive in the window's own coordinates (DIPs). `k` is how many DIPs one drawing pixel is, so a ring
 * over a zoomed or scaled-down page keeps the proportions it has when it is drawn in the page.
 */
import { guideStyle } from '../browser/guide-page'
import type { BrandLook } from '../../shared/brand'

/** The start of every console line the page sends to the main process. */
export const OVERLAY_EVENT = '__agent_overlay:'

export interface OverlayPageState {
  /** Where drawing is allowed, window coordinates. */
  clip: { x: number; y: number; width: number; height: number }
  /** The target (unpadded), window coordinates. Null hides the ring and the label. */
  ring: { x: number; y: number; width: number; height: number } | null
  /** DIPs per drawing pixel. */
  k: number
  /** The label's top-left corner (and width), window coordinates. Null: the page picks a free spot beside the ring. */
  tag: { x: number; y: number; width?: number } | null
  /** "2/5", or '' for a single step. */
  n: string
  label: string
}

/** Space between the target and the ring, in drawing pixels (the in-page guide uses the same). */
export const RING_PAD = 4

const BASE_CSS =
  'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;cursor:default}' +
  '.clip{position:fixed;overflow:hidden;pointer-events:none;left:0;top:0;width:0;height:0}' +
  '.scale{position:absolute;left:0;top:0;transform-origin:0 0}' +
  '.ring,.tag{position:absolute}' +
  '.tag{max-width:380px;pointer-events:none}' +
  '.tag button{pointer-events:auto}' +
  '[hidden]{display:none !important}'

const SCRIPT = `
(() => {
  const send = (event) => { try { console.debug(${JSON.stringify(OVERLAY_EVENT)} + JSON.stringify(event)); } catch (e) { /* closing */ } };
  const clip = document.querySelector('.clip');
  const scale = document.querySelector('.scale');
  const ring = document.querySelector('.ring');
  const tag = document.querySelector('.tag');
  const PAD = ${RING_PAD};
  let state = null;
  let hover = false;
  let mouse = null;
  const overButton = () => {
    if (!mouse || !state || !state.ring) return false;
    const el = document.elementFromPoint(mouse.x, mouse.y);
    return !!(el && el.closest && el.closest('button'));
  };
  const check = () => { const now = overButton(); if (now !== hover) { hover = now; send({ type: 'hover', on: now }); } };
  const hits = (a, b) => a.x < b.x + b.w + 4 && a.x + a.w > b.x - 4 && a.y < b.y + b.h + 4 && a.y + a.h > b.y - 4;
  const draw = () => {
    const s = state;
    if (!s || !s.ring || !(s.clip.width > 0) || !(s.clip.height > 0)) { clip.hidden = true; check(); return; }
    clip.hidden = false;
    const k = s.k > 0 ? s.k : 1;
    clip.style.left = s.clip.x + 'px'; clip.style.top = s.clip.y + 'px';
    clip.style.width = s.clip.width + 'px'; clip.style.height = s.clip.height + 'px';
    scale.style.transform = 'scale(' + k + ')';
    // Everything below is in drawing pixels, measured from the clip's corner.
    const r = { x: (s.ring.x - s.clip.x) / k, y: (s.ring.y - s.clip.y) / k, w: s.ring.width / k, h: s.ring.height / k };
    const cw = s.clip.width / k, ch = s.clip.height / k;
    ring.style.left = (r.x - PAD) + 'px'; ring.style.top = (r.y - PAD) + 'px';
    ring.style.width = (r.w + PAD * 2) + 'px'; ring.style.height = (r.h + PAD * 2) + 'px';
    tag.querySelector('.n').textContent = s.n || '';
    tag.querySelector('.t').textContent = s.label || '';
    tag.style.width = s.tag && s.tag.width > 0 ? (s.tag.width / k) + 'px' : '';
    let spot = s.tag ? { x: (s.tag.x - s.clip.x) / k, y: (s.tag.y - s.clip.y) / k } : null;
    if (!spot) {
      // No place given: beside the ring, never on it, inside the clip.
      const w = tag.offsetWidth, h = tag.offsetHeight, gap = 10;
      const cx = (x) => Math.max(8, Math.min(cw - w - 8, x));
      const cy = (y) => Math.max(8, Math.min(ch - h - 8, y));
      const mid = cy(r.y + r.h / 2 - h / 2);
      const tries = [
        { x: cx(r.x), y: r.y + r.h + gap }, { x: r.x + r.w + gap, y: mid }, { x: cx(r.x), y: r.y - gap - h }, { x: r.x - gap - w, y: mid },
        { x: cx(r.x + r.w - w), y: r.y + r.h + gap }, { x: cx(r.x + r.w - w), y: r.y - gap - h },
      ];
      spot = tries.find((t) => t.x >= 4 && t.y >= 4 && t.x + w <= cw - 4 && t.y + h <= ch - 4 && !hits({ x: t.x, y: t.y, w, h }, r)) || null;
      if (!spot) {
        const corners = [{ x: 8, y: 8 }, { x: cw - w - 8, y: 8 }, { x: 8, y: ch - h - 8 }, { x: cw - w - 8, y: ch - h - 8 }];
        const free = corners.filter((c) => !hits({ x: c.x, y: c.y, w, h }, r));
        const mx = r.x + r.w / 2, my = r.y + r.h / 2;
        spot = (free.length > 0 ? free : corners).sort((a, b) => Math.hypot(b.x - mx, b.y - my) - Math.hypot(a.x - mx, a.y - my))[0];
      }
    }
    tag.style.transform = 'translate(' + spot.x + 'px,' + spot.y + 'px)';
    check();
  };
  // What is really on the glass, in window coordinates: what a check reads from outside.
  const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; };
  globalThis.__overlay = {
    set: (next) => { state = next; draw(); },
    style: (css) => { const st = document.getElementById('look'); if (st) st.textContent = css; draw(); },
    read: () => ({ shown: !clip.hidden, ring: clip.hidden ? null : box(ring), tag: clip.hidden ? null : box(tag), ok: clip.hidden ? null : box(tag.querySelector('.ok')), skip: clip.hidden ? null : box(tag.querySelector('.skip')), label: tag.querySelector('.t').textContent, n: tag.querySelector('.n').textContent, hover }),
  };
  // The window lets the mouse through and only forwards its moves: over one of the two buttons the main process
  // makes the window take clicks, and gives them back to what is underneath the moment the pointer leaves.
  addEventListener('mousemove', (e) => { mouse = { x: e.clientX, y: e.clientY }; check(); }, true);
  document.addEventListener('mouseleave', () => { mouse = null; check(); }, true);
  tag.querySelector('.ok').addEventListener('click', (e) => { if (e.isTrusted) send({ type: 'act', outcome: 'done' }); });
  tag.querySelector('.skip').addEventListener('click', (e) => { if (e.isTrusted) send({ type: 'act', outcome: 'skipped' }); });
  send({ type: 'ready' });
})();
`

/** The overlay window's whole document. */
export function overlayHtml(look: BrandLook): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8"><title>Guide</title>' +
    // The look first, the overlay's own few rules after it, so they win where both speak (position, pointer-events).
    `<style id="look">${guideStyle(look)}</style><style>${BASE_CSS}</style></head>` +
    '<body><div class="clip" hidden><div class="scale"><div class="ring"></div>' +
    '<div class="tag" role="status" aria-live="polite"><span class="n"></span><span class="t"></span><button class="ok" type="button">I did it</button><button class="skip" type="button">Skip</button></div>' +
    `</div></div><script>${SCRIPT}</script></body></html>`
  )
}

export function overlaySetScript(state: OverlayPageState | null): string {
  return `globalThis.__overlay && globalThis.__overlay.set(${JSON.stringify(state)})`
}

export function overlayStyleScript(look: BrandLook): string {
  return `globalThis.__overlay && globalThis.__overlay.style(${JSON.stringify(guideStyle(look))})`
}

export const OVERLAY_READ_SCRIPT = 'globalThis.__overlay ? globalThis.__overlay.read() : null'

/** One console line of the overlay page, or null when the line is something else. */
export function parseOverlayEvent(line: string): { type: 'ready' } | { type: 'hover'; on: boolean } | { type: 'act'; outcome: 'done' | 'skipped' } | null {
  if (!line.startsWith(OVERLAY_EVENT)) return null
  try {
    const raw = JSON.parse(line.slice(OVERLAY_EVENT.length)) as Record<string, unknown>
    if (raw['type'] === 'ready') return { type: 'ready' }
    if (raw['type'] === 'hover') return { type: 'hover', on: raw['on'] === true }
    if (raw['type'] === 'act' && (raw['outcome'] === 'done' || raw['outcome'] === 'skipped')) return { type: 'act', outcome: raw['outcome'] }
  } catch {
    return null
  }
  return null
}
