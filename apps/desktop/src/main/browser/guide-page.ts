/**
 * Guided click-through, the part that runs inside the page (26 Oct 2026). Plain JavaScript strings, run in the guide's
 * own isolated world of ONE frame (guide-host.ts finds every frame, cross-site ones too, and runs these in each), so a
 * site's own scripts and CSS can neither see nor break them, and they can be tested in a real Chromium.
 *
 *   - guideFindScript: what in this frame matches a target (by accessible name and role, as browser_act resolves it,
 *     by a CSS selector, or by a pick mark the snapshot's number left on the element);
 *   - guideShowScript: draws the ring and a small label beside the ONE element, follows it on scroll, resize and
 *     re-layout, finds it again live when the page re-renders, and resolves the moment the person acts: a trusted
 *     click on it, typing in it, or the label's own I did it / Skip. Nothing is clicked for him, nothing is
 *     prevented or stopped: his events reach the page exactly as in a normal browser. The overlay is
 *     pointer-events:none (only the label's two buttons take clicks, and the label never sits over the target), in a
 *     closed shadow root, in the top layer, at the highest z-index;
 *   - guideClearScript: takes every overlay and listener of the guide out of this frame.
 */
import { PAGE_PRELUDE } from './snapshot'

/** The guide's own isolated world (Page.createIsolatedWorld worldName). */
export const GUIDE_WORLD = '__agent_guide_world'
/** The attribute the overlay host carries; also how a snapshot number is handed over (data-agent-guide-pick). */
export const GUIDE_ATTR = 'data-agent-guide'
export const PICK_ATTR = 'data-agent-guide-pick'

export interface GuideQuery {
  name?: string
  role?: string
  /** 1-based pick among several matches, across every frame (the host turns it into a pick inside one frame). */
  nth?: number
  selector?: string
}

export interface GuideShowSpec {
  token: string
  query: GuideQuery
  /** Which pool the host chose: exact name matches or partial ones. */
  mode: 'exact' | 'partial'
  /** 0-based index in this frame's pool. */
  pick: number
  label: string
  step: number
  total: number
  /** Typing in a field counts as done after this long without a keystroke (change, Enter or leaving it count at once). */
  idleMs?: number
  /** A click on the target this recently (before the ring was even drawn) already counts. */
  earlyMs?: number
  /** Clipboard fill: the value is on his clipboard, so his paste into the field ends the step at once. */
  paste?: boolean
  /** A plain value he is pasting: the field coming to hold it ends the step too (never set for a sensitive one). */
  expect?: string
  /** A sensitive value goes in this field: what it holds is never read back out of the page. */
  secret?: boolean
}

export interface FrameMatches {
  exact: number
  partial: number
  /** role "name" of each candidate, exact ones first. */
  items: string[]
}

export interface ShowResult {
  outcome: 'clicked' | 'typed' | 'done' | 'skipped' | 'cancelled' | 'lost'
  /** Date.now() in the page when he acted. */
  at: number
  target: string
  role: string
  name: string
  /** What the field holds now (typed steps; never a password). */
  value?: string
  secret?: boolean
  /** His click landed before the ring was drawn (a fast hand right after the last step). */
  early?: boolean
  /** He pasted into the field (clipboard fill). */
  pasted?: boolean
  /** The element the ring was on, in this frame's viewport. */
  box?: { x: number; y: number; width: number; height: number }
}

/** Finding: the element pool for a query in this frame's own document (open shadow roots too, never child frames). */
const FIND = `
const guideMatches = (q) => {
  const norm = (s) => clean(s).toLowerCase();
  const own = (pointer) => {
    const out = [];
    const visit = (root, depth) => {
      if (depth > 6) return;
      let nodes; try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
      for (const el of nodes) {
        if (el.shadowRoot) visit(el.shadowRoot, depth + 1);
        if (el.hasAttribute && el.hasAttribute('${GUIDE_ATTR}')) continue;
        let wanted = false;
        try { wanted = el.matches(INTERACTIVE) || el.matches(DEEP); } catch (e) { wanted = false; }
        if (!wanted && pointer && el.childElementCount <= 3) {
          try { const v = el.ownerDocument.defaultView; if (v.getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && v.getComputedStyle(el.parentElement).cursor === 'pointer')) wanted = true; } catch (e) { wanted = false; }
        }
        if (wanted) out.push(el);
      }
    };
    visit(document, 0);
    return out.filter((el) => visible(el));
  };
  const pickMark = q.selector && q.selector.indexOf('${PICK_ATTR}') !== -1;
  if (q.selector) {
    let list = [];
    try { list = Array.from(document.querySelectorAll(q.selector)); } catch (e) { return { exact: [], partial: [], bad: 'That CSS selector does not parse.' }; }
    // A snapshot number marks an element that is there even if it is not "interactive".
    list = list.filter((el) => pickMark || visible(el));
    return { exact: list, partial: [] };
  }
  const wanted = norm(q.name || '');
  if (wanted === '') return { exact: [], partial: [], bad: 'Pass the name of the element.' };
  const role = (q.role || '').toLowerCase();
  const roleOk = (el) => role === '' || roleOf(el) === role || (role === 'textbox' && roleOf(el) === 'searchbox');
  const sift = (pool) => {
    if (pool.length > 1) { const real = pool.filter((el) => roleOf(el) !== 'generic'); if (real.length > 0) pool = real; }
    if (pool.length > 1) { const on = pool.filter((el) => !disabledOf(el)); if (on.length > 0) pool = on; }
    return pool;
  };
  let all = own(false);
  let exact = all.filter((el) => roleOk(el) && norm(nameOf(el)) === wanted);
  let partial = all.filter((el) => roleOk(el) && norm(nameOf(el)).indexOf(wanted) !== -1);
  if (exact.length === 0 && partial.length === 0) {
    all = own(true);
    exact = all.filter((el) => roleOk(el) && norm(nameOf(el)) === wanted);
    partial = all.filter((el) => roleOk(el) && norm(nameOf(el)).indexOf(wanted) !== -1);
  }
  return { exact: sift(exact), partial: sift(partial) };
};
const describeEl = (el) => roleOf(el) + ' "' + nameOf(el).slice(0, 70) + '"';
`

/** What in this frame matches the target. */
export function guideFindScript(query: GuideQuery): string {
  return `(() => {
${PAGE_PRELUDE}
${FIND}
const m = guideMatches(${JSON.stringify(query)});
if (m.bad) return { exact: 0, partial: 0, items: [], bad: m.bad };
return { exact: m.exact.length, partial: m.partial.length, items: m.exact.concat(m.partial).slice(0, 8).map(describeEl) };
})()`
}

/** Draws the highlight on the chosen element and resolves when the person acts (or the guide is ended). */
export function guideShowScript(spec: GuideShowSpec): string {
  return `(async () => {
${PAGE_PRELUDE}
${FIND}
const spec = ${JSON.stringify({ idleMs: 2000, earlyMs: 1500, ...spec })};
const G = globalThis.__agentGuide || (globalThis.__agentGuide = { sessions: {}, recent: [], recorder: false });
const poolOf = () => { const m = guideMatches(spec.query); return spec.mode === 'partial' ? (m.partial || []) : (m.exact || []); };
let el = poolOf()[spec.pick] || poolOf()[0] || null;
if (!el) return { outcome: 'lost', at: Date.now(), target: '', role: '', name: '' };
const editableOf = (e) => e.isContentEditable || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT' || (e.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(e.type || ''));
const field = editableOf(el);
const inTarget = (path) => path.indexOf(el) !== -1 || path.some((n) => n && n.tagName === 'LABEL' && n.control === el);
// Every trusted click of his in this frame is remembered for a moment, so a click that lands while the next ring is
// still being drawn (he is quick) is not lost.
if (!G.recorder) {
  G.recorder = true;
  addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const path = e.composedPath().filter((n) => n && n.nodeType === 1 && !(n.hasAttribute && n.hasAttribute('${GUIDE_ATTR}')));
    G.recent.push({ t: Date.now(), path });
    if (G.recent.length > 6) G.recent.shift();
  }, true);
}
const result = (outcome, extra) => {
  const r = el.getBoundingClientRect();
  const out = { outcome, at: Date.now(), target: describeEl(el), role: roleOf(el), name: nameOf(el).slice(0, 100), box: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) } };
  if (field) {
    const secret = spec.secret === true || (el.tagName === 'INPUT' && /^password$/i.test(el.type || ''));
    if (secret) out.secret = true;
    else out.value = el.tagName === 'SELECT' ? (el.selectedOptions && el.selectedOptions[0] ? clean(el.selectedOptions[0].textContent) : '') : el.isContentEditable ? textIn(el).slice(0, 500) : String(el.value || '').slice(0, 500);
  }
  return Object.assign(out, extra || {});
};
if (!field) {
  const now = Date.now();
  const hit = G.recent.find((c) => now - c.t <= spec.earlyMs && (c.path.indexOf(el) !== -1 || c.path.some((n) => n.tagName === 'LABEL' && n.control === el)));
  if (hit) { G.recent = []; return result('clicked', { early: true, at: hit.t }); }
}
// Out of sight: bring it into view (frames scroll their parents too); a target already on screen is left where it is.
const onScreen = (e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth; };
if (!onScreen(el)) { try { el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }); } catch (e) { el.scrollIntoView(); } }

const host = document.createElement('div');
host.setAttribute('${GUIDE_ATTR}', spec.token);
host.style.cssText = 'all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;display:block;color-scheme:normal';
const topLayer = typeof host.showPopover === 'function';
if (topLayer) host.setAttribute('popover', 'manual');
const root = host.attachShadow({ mode: 'closed' });
root.innerHTML = '<style>'
  + ':host{all:initial}'
  + '.ring{position:fixed;box-sizing:border-box;border:3px solid #ff5a1f;border-radius:9px;pointer-events:none;box-shadow:0 0 0 4px rgba(255,90,31,.28),0 0 18px rgba(255,90,31,.55);animation:gp 1.3s ease-in-out infinite}'
  + '@keyframes gp{50%{box-shadow:0 0 0 9px rgba(255,90,31,.10),0 0 26px rgba(255,90,31,.75)}}'
  + '.tag{position:fixed;left:0;top:0;pointer-events:auto;display:flex;align-items:center;gap:6px;box-sizing:border-box;max-width:min(360px,calc(100vw - 16px));padding:6px 6px 6px 10px;border-radius:11px;background:#1d1b20;color:#fff;font:600 13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);user-select:none}'
  + '.n{opacity:.65;font-weight:500;white-space:nowrap}'
  + '.t{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}'
  + 'button{all:initial;cursor:pointer;box-sizing:border-box;font:600 12px/1 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:7px 9px;border-radius:8px;background:rgba(255,255,255,.14);color:#fff;white-space:nowrap}'
  + 'button.ok{background:#ff5a1f}'
  + 'button:hover{filter:brightness(1.12)}'
  + '</style><div class="ring" part="ring"></div><div class="tag" role="status" aria-live="polite"><span class="n"></span><span class="t"></span><button class="ok" type="button">I did it</button><button class="skip" type="button">Skip</button></div>';
const ring = root.querySelector('.ring');
const tag = root.querySelector('.tag');
root.querySelector('.n').textContent = spec.total > 1 ? (spec.step + '/' + spec.total) : '';
root.querySelector('.t').textContent = spec.label;
const modalOf = (e) => { try { const d = e.closest('dialog'); return d && d.matches(':modal') ? d : null; } catch (er) { return null; } };
let parent = null;
const mount = () => {
  // Inside a modal dialog the rest of the page is inert, so the label lives in the dialog; the top layer keeps it on top.
  const want = modalOf(el) || document.documentElement;
  if (parent !== want || !host.isConnected) { parent = want; want.appendChild(host); }
  if (topLayer) { try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch (e) { /* not a popover-capable spot */ } }
};
mount();
// Something new on top (a dialog, a popover): raise the guide again.
const mo = new MutationObserver((list) => {
  if (list.some((m) => m.target !== host && !(host.contains(m.target)) && (m.type === 'childList' || m.attributeName === 'open' || m.attributeName === 'popover'))) raise = true;
});
let raise = false;
mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'popover', 'aria-modal'] });

let lostSince = 0;
let lastBox = '';
let lastSpot = null;
let lastWhere = '';
let frame = 0;
const intersects = (a, b) => a.left < b.right + 4 && a.right > b.left - 4 && a.top < b.bottom + 4 && a.bottom > b.top - 4;
const place = () => {
  if (!el.isConnected || el.getBoundingClientRect().width === 0) {
    if (!lostSince) lostSince = Date.now();
    if (Date.now() - lostSince > 250) {
      // Re-rendered: find it again live, by its name, as browser_act does.
      const again = poolOf();
      const next = again[spec.pick] || again[0];
      if (next) { el = next; lostSince = 0; }
    }
    if (!el.isConnected || el.getBoundingClientRect().width === 0) { ring.style.display = 'none'; tag.style.visibility = 'hidden'; return; }
  }
  lostSince = 0;
  if (raise || modalOf(el) !== (parent === document.documentElement ? null : parent)) { raise = false; mount(); }
  const r = el.getBoundingClientRect();
  const pad = 4;
  ring.style.display = 'block';
  ring.style.left = (r.left - pad) + 'px'; ring.style.top = (r.top - pad) + 'px';
  ring.style.width = (r.width + pad * 2) + 'px'; ring.style.height = (r.height + pad * 2) + 'px';
  const w = tag.offsetWidth, h = tag.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 10;
  const clampX = (x) => Math.max(8, Math.min(vw - w - 8, x));
  const clampY = (y) => Math.max(8, Math.min(vh - h - 8, y));
  // The label goes where it hides the least: never on the target, and off the page's other controls (a dialog's
  // Confirm beside the field he is typing in) whenever there is a spot that leaves them clear. Worked out again only
  // when the target or the window moved, so following it every frame stays one rect read.
  const where = Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height) + ',' + vw + ',' + vh + ',' + w + ',' + h;
  let spot = lastSpot && lastWhere === where ? lastSpot : null;
  if (!spot) {
    const cy = clampY(r.top + r.height / 2 - h / 2);
    const tries = [
      { x: clampX(r.left), y: r.bottom + gap },
      { x: r.right + gap, y: cy },
      { x: clampX(r.left), y: r.top - gap - h },
      { x: r.left - gap - w, y: cy },
      { x: clampX(r.right - w), y: r.bottom + gap },
      { x: clampX(r.right - w), y: r.top - gap - h },
      { x: clampX(r.left), y: r.bottom + gap + 48 },
      { x: clampX(r.left), y: r.top - gap - h - 48 },
    ];
    const others = [];
    try {
      for (const n of document.querySelectorAll(INTERACTIVE)) {
        if (n === el || n.contains(el) || el.contains(n) || others.length > 400) continue;
        const b = n.getBoundingClientRect();
        if (b.width > 0 && b.height > 0 && b.bottom > 0 && b.top < vh && b.right > 0 && b.left < vw) others.push(b);
      }
    } catch (e) { /* no controls to avoid */ }
    let best = null;
    for (const [i, t] of tries.entries()) {
      const box = { left: t.x, top: t.y, right: t.x + w, bottom: t.y + h };
      if (t.x < 4 || t.y < 4 || box.right > vw - 4 || box.bottom > vh - 4) continue;
      if (intersects(box, r)) continue;
      const hidden = others.filter((o) => box.left < o.right && box.right > o.left && box.top < o.bottom && box.bottom > o.top).length;
      const score = hidden * 100 + i;
      if (!best || score < best.score) best = { score, t };
      if (hidden === 0) break;
    }
    spot = best ? best.t : null;
  }
  if (!spot) {
    // No room beside it (a huge target, a tiny frame): the corner farthest from it, never on it if that can be helped.
    const corners = [{ x: 8, y: 8 }, { x: vw - w - 8, y: 8 }, { x: 8, y: vh - h - 8 }, { x: vw - w - 8, y: vh - h - 8 }];
    const free = corners.filter((c) => !intersects({ left: c.x, top: c.y, right: c.x + w, bottom: c.y + h }, r));
    const cx = r.left + r.width / 2, cyy = r.top + r.height / 2;
    spot = (free.length > 0 ? free : corners).sort((a, b) => Math.hypot(b.x - cx, b.y - cyy) - Math.hypot(a.x - cx, a.y - cyy))[0];
  }
  lastSpot = spot;
  lastWhere = where;
  tag.style.visibility = 'visible';
  tag.style.transform = 'translate(' + Math.round(spot.x) + 'px,' + Math.round(spot.y) + 'px)';
  const box = Math.round(r.left) + ',' + Math.round(r.top) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
  const key = box + '|' + Math.round(spot.x) + ',' + Math.round(spot.y) + ',' + w + ',' + h;
  if (key !== lastBox) {
    // Where the ring, the label and its two buttons are, in this frame's viewport: what a check reads from outside.
    lastBox = key;
    const rect = (n) => { const b = n.getBoundingClientRect(); return Math.round(b.left) + ',' + Math.round(b.top) + ',' + Math.round(b.width) + ',' + Math.round(b.height); };
    host.setAttribute('data-agent-guide-box', box);
    host.setAttribute('data-agent-guide-label', Math.round(spot.x) + ',' + Math.round(spot.y) + ',' + w + ',' + h);
    host.setAttribute('data-agent-guide-buttons', rect(root.querySelector('.ok')) + ';' + rect(root.querySelector('.skip')));
  }
};

return await new Promise((resolve) => {
  let done = false;
  let idle = null;
  let raf = 0;
  let timer = 0;
  const finish = (outcome, extra) => {
    if (done) return;
    done = true;
    const out = result(outcome, extra);
    removeEventListener('click', onClick, true);
    removeEventListener('input', onInput, true);
    removeEventListener('change', onChange, true);
    removeEventListener('keydown', onKey, true);
    removeEventListener('focusout', onBlur, true);
    removeEventListener('scroll', onMove, true);
    removeEventListener('resize', onMove, true);
    if (idle) clearTimeout(idle);
    cancelAnimationFrame(raf);
    clearInterval(timer);
    mo.disconnect();
    try { if (topLayer && host.matches(':popover-open')) host.hidePopover(); } catch (e) { /* gone */ }
    host.remove();
    delete G.sessions[spec.token];
    resolve(out);
  };
  G.sessions[spec.token] = { end: (why) => finish(why || 'cancelled') };
  let typed = false;
  // Listeners only watch: no preventDefault, no stopPropagation, so the page gets every event of his as usual.
  const onClick = (e) => {
    if (!e.isTrusted || done) return;
    const path = e.composedPath();
    if (path.indexOf(host) !== -1) return;
    if (!field && inTarget(path)) { G.recent = []; finish('clicked'); return; }
    // Typed into the field and then clicked on something else: the typing is the step.
    if (field && typed && !inTarget(path)) finish('typed');
  };
  const onInput = (e) => {
    if (!e.isTrusted || done || !inTarget(e.composedPath())) return;
    typed = true;
    // Clipboard fill: his paste is the signal, or the field coming to hold the value he was given.
    const pasted = e.inputType === 'insertFromPaste';
    if (spec.paste && pasted) { finish('typed', { pasted: true }); return; }
    if (typeof spec.expect === 'string' && spec.expect !== '' && String(el.value ?? textIn(el)) === spec.expect) { finish('typed', pasted ? { pasted: true } : {}); return; }
    if (idle) clearTimeout(idle);
    if (el.tagName === 'SELECT') { finish('typed'); return; }
    idle = setTimeout(() => finish('typed'), spec.idleMs);
  };
  const onChange = (e) => { if (!e.isTrusted || done || !field || !inTarget(e.composedPath())) return; finish('typed'); };
  const onKey = (e) => { if (!e.isTrusted || done || !field || e.key !== 'Enter' || !inTarget(e.composedPath())) return; setTimeout(() => finish('typed'), 0); };
  const onBlur = (e) => { if (!done && field && typed && inTarget(e.composedPath())) finish('typed'); };
  const onMove = () => { if (!done) place(); };
  addEventListener('click', onClick, true);
  addEventListener('input', onInput, true);
  addEventListener('change', onChange, true);
  addEventListener('keydown', onKey, true);
  addEventListener('focusout', onBlur, true);
  addEventListener('scroll', onMove, true);
  addEventListener('resize', onMove, true);
  root.querySelector('.ok').addEventListener('click', (e) => { if (e.isTrusted) finish('done'); });
  root.querySelector('.skip').addEventListener('click', (e) => { if (e.isTrusted) finish('skipped'); });
  // Follows the element every frame while the page paints (cheap: one rect read), and on a slow timer while it does not.
  const loop = () => { if (done) return; frame++; place(); raf = requestAnimationFrame(loop); };
  place();
  raf = requestAnimationFrame(loop);
  timer = setInterval(() => { if (!done) place(); }, 400);
});
})()`
}

/** Ends the guide's steps in this frame (one by token, or all) and removes every overlay and pick mark. */
export function guideClearScript(token?: string): string {
  return `(() => {
const G = globalThis.__agentGuide;
let ended = 0;
if (G) for (const key of Object.keys(G.sessions)) { if (${JSON.stringify(token ?? '')} === '' || key === ${JSON.stringify(token ?? '')}) { try { G.sessions[key].end('cancelled'); ended++; } catch (e) { /* already gone */ } } }
for (const h of Array.from(document.querySelectorAll('[${GUIDE_ATTR}]'))) { if (${JSON.stringify(token ?? '')} === '' || h.getAttribute('${GUIDE_ATTR}') === ${JSON.stringify(token ?? '')}) { h.remove(); ended++; } }
for (const p of Array.from(document.querySelectorAll('[${PICK_ATTR}]'))) p.removeAttribute('${PICK_ATTR}');
return ended;
})()`
}

/** Marks the snapshot's element number for the guide (runs in the snapshot's own world of the top frame). */
export function pickMarkScript(index: number, token: string): string {
  return `(() => {
const store = globalThis.__agentBrowserPage || {};
const el = store.refs && store.refs[${Math.floor(index)}];
if (!el || !el.isConnected) return false;
el.setAttribute('${PICK_ATTR}', ${JSON.stringify(token)});
return true;
})()`
}

/** What the person sees: the page's open dialogs (role dialog, alertdialog, open <dialog>). */
export function dialogsScript(): string {
  return `(() => {
${PAGE_PRELUDE}
const out = [];
for (const d of document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) {
  if (!visible(d)) continue;
  out.push((nameOf(d) || textIn(d).slice(0, 80) || 'untitled').slice(0, 100));
  if (out.length >= 4) break;
}
return { url: location.href, title: document.title, dialogs: out, text: textIn(document.body).slice(0, 400) };
})()`
}

export function parseShow(value: unknown): ShowResult {
  const raw = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const outcome = typeof raw['outcome'] === 'string' ? raw['outcome'] : 'lost'
  const box = raw['box'] !== null && typeof raw['box'] === 'object' ? (raw['box'] as ShowResult['box']) : undefined
  return {
    outcome: (['clicked', 'typed', 'done', 'skipped', 'cancelled', 'lost'].includes(outcome) ? outcome : 'lost') as ShowResult['outcome'],
    at: typeof raw['at'] === 'number' ? raw['at'] : Date.now(),
    target: typeof raw['target'] === 'string' ? raw['target'] : '',
    role: typeof raw['role'] === 'string' ? raw['role'] : '',
    name: typeof raw['name'] === 'string' ? raw['name'] : '',
    ...(typeof raw['value'] === 'string' ? { value: raw['value'] } : {}),
    ...(raw['secret'] === true ? { secret: true } : {}),
    ...(raw['early'] === true ? { early: true } : {}),
    ...(raw['pasted'] === true ? { pasted: true } : {}),
    ...(box === undefined ? {} : { box }),
  }
}

export function parseMatches(value: unknown): FrameMatches & { bad?: string } {
  const raw = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    exact: typeof raw['exact'] === 'number' ? raw['exact'] : 0,
    partial: typeof raw['partial'] === 'number' ? raw['partial'] : 0,
    items: Array.isArray(raw['items']) ? raw['items'].filter((x): x is string => typeof x === 'string') : [],
    ...(typeof raw['bad'] === 'string' ? { bad: raw['bad'] } : {}),
  }
}
