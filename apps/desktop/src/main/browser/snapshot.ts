/**
 * The accessibility-style snapshot and the element resolver, as plain JavaScript strings that run in
 * the page's isolated world (the same world as ./outline.ts, so the numbered registry is shared and
 * browser_click(index) keeps working on the new numbers).
 *
 * A page outline agents can act on: numbered elements with role, name and state; open shadow roots
 * and same-origin frames are walked; a cross-origin frame is reported with its rectangle so the agent
 * can act on it by coordinates. Acting resolves the target LIVE by name at act time (numbers go stale
 * the moment a page re-renders), waits for it to be visible, enabled and still, scrolls it into view,
 * and checks what is actually under its centre, so a click swallowed by an overlay is reported instead
 * of claimed.
 */

export interface SnapshotOptions {
  filter?: string
  /** Also number unlabelled clickable things: div[aria-label], [tabindex], cursor:pointer. */
  deep?: boolean
  limit?: number
}

export interface SnapshotElement {
  index: number
  role: string
  name: string
  state: string
  href: string
  frame: string
}

export interface SnapshotResult {
  url: string
  title: string
  elements: SnapshotElement[]
  headings: string[]
  dialogs: string[]
  frames: string[]
  total: number
  note: string
  focused: string
}

export interface TargetQuery {
  index?: number
  name?: string
  role?: string
  /** 1-based pick among several exact matches. */
  nth?: number
}

export interface Resolved {
  ok: boolean
  reason: string
  /** Centre of the element in top-level viewport CSS pixels. */
  x: number
  y: number
  label: string
  role: string
  tag: string
  editable: boolean
  checked: boolean | null
  covered: string
  candidates: string[]
}

const PRELUDE = `
const KEY = '__agentBrowserPage';
const store = globalThis[KEY] || (globalThis[KEY] = { refs: [] });
const clean = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();
const IMPLICIT = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', SUMMARY: 'button', OPTION: 'option', DETAILS: 'group', IMG: 'img', H1: 'heading', H2: 'heading', H3: 'heading', DIALOG: 'dialog' };
const INPUT_ROLE = { checkbox: 'checkbox', radio: 'radio', range: 'slider', button: 'button', submit: 'button', reset: 'button', image: 'button', search: 'searchbox', email: 'textbox', tel: 'textbox', url: 'textbox', text: 'textbox', password: 'textbox', number: 'spinbutton', file: 'button' };
const roleOf = (el) => {
  const explicit = clean(el.getAttribute('role')).split(' ')[0];
  if (explicit) return explicit;
  if (el.tagName === 'INPUT') return INPUT_ROLE[(el.type || 'text').toLowerCase()] || 'textbox';
  if (el.tagName === 'A' && !el.hasAttribute('href')) return 'generic';
  if (el.isContentEditable) return 'textbox';
  return IMPLICIT[el.tagName] || 'generic';
};
const textIn = (node) => clean(node ? (node.innerText || node.textContent || '') : '');
const nameOf = (el) => {
  const doc = el.ownerDocument;
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const t = clean(labelled.split(/\\s+/).map((id) => textIn(doc.getElementById(id))).join(' '));
    if (t) return t;
  }
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  if (el.labels && el.labels.length > 0) { const t = textIn(el.labels[0]); if (t) return t; }
  if (el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type) && el.value) return clean(el.value);
  if (el.tagName === 'IMG') { const alt = clean(el.getAttribute('alt')); if (alt) return alt; }
  const placeholder = clean(el.getAttribute('placeholder'));
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') {
    const t = textIn(el);
    if (t) return t.slice(0, 120);
    const img = el.querySelector && el.querySelector('img[alt],svg[aria-label],[aria-label]');
    if (img) { const a = clean(img.getAttribute('alt') || img.getAttribute('aria-label')); if (a) return a; }
  }
  if (placeholder) return placeholder;
  const title = clean(el.getAttribute('title'));
  if (title) return title;
  if (el.name) return clean(el.name);
  if (el.id) return clean(el.id);
  return '';
};
const visible = (el) => {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const view = el.ownerDocument.defaultView;
  const style = view.getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
  if (el.closest('[aria-hidden="true"],[inert]')) return false;
  return true;
};
const disabledOf = (el) => el.disabled === true || el.getAttribute('aria-disabled') === 'true' || !!el.closest('fieldset[disabled]');
const stateOf = (el) => {
  const parts = [];
  if (disabledOf(el)) parts.push('disabled');
  const ac = el.getAttribute('aria-checked');
  if (el.type === 'checkbox' || el.type === 'radio') parts.push(el.checked ? 'checked' : 'unchecked');
  else if (ac === 'true' || ac === 'false' || ac === 'mixed') parts.push(ac === 'true' ? 'checked' : ac === 'mixed' ? 'mixed' : 'unchecked');
  const ex = el.getAttribute('aria-expanded'); if (ex === 'true') parts.push('expanded'); else if (ex === 'false') parts.push('collapsed');
  if (el.getAttribute('aria-selected') === 'true') parts.push('selected');
  if (el.getAttribute('aria-pressed') === 'true') parts.push('pressed');
  if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') parts.push('current');
  if (el.required || el.getAttribute('aria-required') === 'true') parts.push('required');
  if (el.readOnly) parts.push('readonly');
  if (el.ownerDocument.activeElement === el) parts.push('focused');
  if (el.getAttribute('aria-invalid') === 'true') parts.push('invalid');
  if (el.tagName === 'INPUT' && el.type !== 'password' && el.type !== 'file' && el.type !== 'checkbox' && el.type !== 'radio' && el.value) parts.push('value="' + clean(el.value).slice(0, 60) + '"');
  if (el.tagName === 'INPUT' && el.type === 'password' && el.value) parts.push('value=(hidden, ' + el.value.length + ' chars)');
  if (el.tagName === 'TEXTAREA' && el.value) parts.push('value="' + clean(el.value).slice(0, 60) + '"');
  if (el.isContentEditable && el.tagName !== 'INPUT') { const t = textIn(el); if (t) parts.push('value="' + t.slice(0, 60) + '"'); }
  if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) parts.push('value="' + clean(el.selectedOptions[0].textContent).slice(0, 60) + '"');
  return parts.join(' ');
};
const INTERACTIVE = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=""],[contenteditable="true"],[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[role=slider],[role=spinbutton],[role=treeitem],[onclick]';
const DEEP = '[aria-label],[tabindex]:not([tabindex="-1"]),[data-testid],[jsaction]';
// Every element reachable from the top document: open shadow roots and same-origin frames included.
const collect = (deep) => {
  const out = [];
  const frames = [];
  const seen = new Set();
  const visit = (root, ox, oy, frameName, depth) => {
    if (depth > 6) return;
    let nodes;
    try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
    for (const el of nodes) {
      if (el.shadowRoot) visit(el.shadowRoot, ox, oy, frameName, depth + 1);
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        let doc = null;
        try { doc = el.contentDocument; } catch (e) { doc = null; }
        const label = clean(el.getAttribute('title') || el.getAttribute('name') || '') || (function(){ try { return new URL(el.src).host; } catch (e) { return 'frame'; } })();
        if (doc && doc.documentElement) {
          visit(doc, ox + r.left + el.clientLeft, oy + r.top + el.clientTop, label, depth + 1);
        } else {
          frames.push(label + ' at x=' + Math.round(ox + r.left) + ' y=' + Math.round(oy + r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
        }
        continue;
      }
      if (seen.has(el)) continue;
      let wanted = false;
      try { wanted = el.matches(INTERACTIVE) || (deep && el.matches(DEEP)); } catch (e) { wanted = false; }
      if (!wanted && deep && el.childElementCount <= 3) {
        try {
          const view = el.ownerDocument.defaultView;
          if (view.getComputedStyle(el).cursor === 'pointer' && !(el.parentElement && view.getComputedStyle(el.parentElement).cursor === 'pointer')) wanted = true;
        } catch (e) { wanted = false; }
      }
      if (!wanted) continue;
      seen.add(el);
      out.push({ el, ox, oy, frame: frameName });
    }
  };
  visit(document, 0, 0, '', 0);
  return { out, frames };
};
const centreOf = (entry) => {
  const r = entry.el.getBoundingClientRect();
  return { x: entry.ox + r.left + r.width / 2, y: entry.oy + r.top + r.height / 2 };
};
`

export function snapshotScript(options: SnapshotOptions = {}): string {
  const filter = JSON.stringify((options.filter ?? '').toLowerCase())
  const deep = options.deep === true ? 'true' : 'false'
  const limit = Math.max(10, Math.min(400, Math.floor(options.limit ?? 150)))
  return `(() => {
${PRELUDE}
const filter = ${filter};
const deep = ${deep};
const { out, frames } = collect(deep);
store.refs = [];
store.offsets = [];
const elements = [];
let total = 0;
for (const entry of out) {
  const el = entry.el;
  if (!visible(el)) continue;
  const role = roleOf(el);
  const name = nameOf(el);
  if (deep && role === 'generic' && name === '') continue;
  const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
  if (filter !== '' && (name + ' ' + role + ' ' + href).toLowerCase().indexOf(filter) === -1) continue;
  total++;
  if (elements.length >= ${limit}) continue;
  const index = elements.length;
  store.refs[index] = el;
  store.offsets[index] = { ox: entry.ox, oy: entry.oy };
  elements.push({ index, role, name: name.slice(0, 100), state: stateOf(el), href: href.charAt(0) === '#' ? '' : href.slice(0, 120), frame: entry.frame });
}
const headings = [];
for (const h of document.querySelectorAll('h1,h2,h3')) {
  if (!visible(h)) continue;
  const t = textIn(h); if (t) headings.push(h.tagName.toLowerCase() + ' ' + t.slice(0, 100));
  if (headings.length >= 15) break;
}
const dialogs = [];
for (const d of document.querySelectorAll('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) {
  if (!visible(d)) continue;
  dialogs.push((nameOf(d) || textIn(d).slice(0, 80) || 'untitled').slice(0, 100));
  if (dialogs.length >= 4) break;
}
const text = clean(document.body ? document.body.innerText : '').toLowerCase();
let note = '';
if (/captcha|are you a robot|verify (that )?you are (a )?human|not a robot/.test(text)) note = 'This page has a captcha. A person may need to take over (browser_handoff).';
else if (document.querySelector('input[type=password]')) note = 'This page has a sign-in form. If the Vault has the login (vault_list), sign in with vault_login without seeing it; otherwise hand over (browser_handoff).';
const active = document.activeElement;
const focused = active && active !== document.body ? (roleOf(active) + ' "' + nameOf(active).slice(0, 60) + '"') : '';
return { url: location.href, title: document.title, elements, headings, dialogs, frames: frames.slice(0, 8), total, note, focused };
})()`
}

/**
 * Finds the target, waits for it to be actionable, scrolls it into view and measures it.
 * `prepare` false only measures (for read-only checks).
 */
export function resolveScript(query: TargetQuery, timeoutMs = 4000): string {
  const q = JSON.stringify({
    index: query.index ?? null,
    name: query.name ?? '',
    role: (query.role ?? '').toLowerCase(),
    nth: query.nth ?? 0,
  })
  return `(async () => {
${PRELUDE}
const q = ${q};
const fail = (reason, candidates) => ({ ok: false, reason, x: 0, y: 0, label: '', role: '', tag: '', editable: false, checked: null, covered: '', candidates: candidates || [] });
const norm = (s) => clean(s).toLowerCase();
const describe = (entry) => roleOf(entry.el) + ' "' + nameOf(entry.el).slice(0, 70) + '"';
let entry = null;
if (q.index !== null) {
  const el = store.refs[q.index];
  if (!el || !el.isConnected) return fail('Number ' + q.index + ' is not on the page any more (it re-rendered). Act by name instead, or take a new snapshot.');
  const off = (store.offsets && store.offsets[q.index]) || { ox: 0, oy: 0 };
  entry = { el, ox: off.ox, oy: off.oy, frame: '' };
} else {
  const wanted = norm(q.name);
  if (wanted === '') return fail('Pass the name of the element, or its number.');
  const deadline = Date.now() + ${Math.max(0, Math.floor(timeoutMs))};
  for (;;) {
    const all = collect(true).out.filter((e) => visible(e.el));
    const roleOk = (e) => q.role === '' || roleOf(e.el) === q.role || (q.role === 'textbox' && roleOf(e.el) === 'searchbox');
    const exact = all.filter((e) => roleOk(e) && norm(nameOf(e.el)) === wanted);
    const partial = all.filter((e) => roleOk(e) && norm(nameOf(e.el)).indexOf(wanted) !== -1);
    let pool = exact.length > 0 ? exact : partial;
    // Interactive things beat a generic wrapper with the same text.
    if (pool.length > 1) { const real = pool.filter((e) => roleOf(e.el) !== 'generic'); if (real.length > 0) pool = real; }
    if (pool.length > 1) { const enabled = pool.filter((e) => !disabledOf(e.el)); if (enabled.length > 0) pool = enabled; }
    if (pool.length === 1 || (pool.length > 1 && q.nth > 0)) {
      entry = pool[Math.min(pool.length, Math.max(1, q.nth || 1)) - 1];
      break;
    }
    if (pool.length > 1) {
      return fail('Several elements match "' + q.name + '". Use the full name, add role, or pass nth (1 = first).', pool.slice(0, 8).map(describe));
    }
    if (Date.now() >= deadline) {
      const words = wanted.split(/\\s+/).filter((w) => w.length > 2);
      const near = all.filter((e) => { const n = norm(nameOf(e.el)); return words.some((w) => n.indexOf(w) !== -1); }).slice(0, 8).map(describe);
      return fail('Nothing on the page is called "' + q.name + '"' + (q.role ? ' with role ' + q.role : '') + '.', near);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}
const el = entry.el;
// Wait until it is visible, enabled and has stopped moving.
const deadline2 = Date.now() + ${Math.max(0, Math.floor(timeoutMs))};
try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { el.scrollIntoView(); }
let last = null;
for (;;) {
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const r = el.getBoundingClientRect();
  const still = last && Math.abs(last.left - r.left) < 1 && Math.abs(last.top - r.top) < 1 && Math.abs(last.width - r.width) < 1;
  last = r;
  if (still && visible(el) && !disabledOf(el)) break;
  if (Date.now() >= deadline2) {
    if (!visible(el)) return fail(describe(entry) + ' is not visible.');
    if (disabledOf(el)) return fail(describe(entry) + ' is disabled.');
    break;
  }
}
// Frame offsets may have moved with the scroll; measure the frame chain again for same-origin frames.
let ox = 0, oy = 0;
let win = el.ownerDocument.defaultView;
while (win && win.frameElement) {
  const fr = win.frameElement.getBoundingClientRect();
  ox += fr.left + win.frameElement.clientLeft; oy += fr.top + win.frameElement.clientTop;
  win = win.parent;
}
const rect = el.getBoundingClientRect();
const lx = rect.left + Math.min(rect.width / 2, Math.max(1, rect.width - 2));
const ly = rect.top + Math.min(rect.height / 2, Math.max(1, rect.height - 2));
let covered = '';
const hit = el.ownerDocument.elementFromPoint(lx, ly);
if (hit && hit !== el && !el.contains(hit) && !(hit.contains && hit.contains(el)) && !(el.labels && Array.from(el.labels).some((l) => l.contains(hit)))) {
  const tag = hit.tagName.toLowerCase();
  const id = hit.id ? '#' + hit.id : '';
  const cls = typeof hit.className === 'string' && hit.className.trim() ? '.' + hit.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
  covered = tag + id + cls + (nameOf(hit) ? ' "' + nameOf(hit).slice(0, 50) + '"' : '');
}
const role = roleOf(el);
const editable = el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset|file|image|range|color)$/i.test(el.type));
let checked = null;
if (el.type === 'checkbox' || el.type === 'radio') checked = !!el.checked;
else if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-checked') === 'false') checked = el.getAttribute('aria-checked') === 'true';
store.target = el;
return { ok: true, reason: '', x: ox + lx, y: oy + ly, label: describe(entry), role, tag: el.tagName.toLowerCase(), editable, checked, covered, candidates: [] };
})()`
}

/** Selects what is already in the resolved field so typed text replaces it. */
export function selectFieldScript(): string {
  return `(() => {
const store = globalThis.__agentBrowserPage || {};
let el = store.target;
if (!el) return { ok: false, reason: 'No field is chosen.' };
if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) {
  const inner = el.querySelector && el.querySelector('input:not([type=hidden]),textarea,[contenteditable=""],[contenteditable="true"]');
  if (inner) { el = inner; store.target = inner; }
}
try { el.focus({ preventScroll: true }); } catch (e) { /* not focusable */ }
if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
  try { el.select(); } catch (e) { try { el.setSelectionRange(0, String(el.value || '').length); } catch (e2) { /* email fields */ } }
} else if (el.isContentEditable) {
  const doc = el.ownerDocument;
  const range = doc.createRange(); range.selectNodeContents(el);
  const sel = doc.defaultView.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}
const active = el.ownerDocument.activeElement;
return { ok: active === el || el.contains(active), reason: active === el || el.contains(active) ? '' : 'The field would not take focus.' };
})()`
}

/** Reads back what the resolved field holds now. */
export function fieldValueScript(): string {
  return `(() => {
const el = (globalThis.__agentBrowserPage || {}).target;
if (!el || !el.isConnected) return { ok: false, value: '' };
if (el.tagName === 'INPUT' && el.type === 'password') return { ok: true, value: '(hidden, ' + String(el.value || '').length + ' characters)' };
if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return { ok: true, value: String(el.value || '') };
if (el.tagName === 'SELECT') return { ok: true, value: el.selectedOptions && el.selectedOptions[0] ? String(el.selectedOptions[0].textContent || '').trim() : '' };
return { ok: true, value: String(el.innerText || el.textContent || '').trim() };
})()`
}

/** Picks an option of the resolved <select> by its text or value (native popups cannot be clicked). */
export function selectOptionScript(option: string): string {
  return `(() => {
const el = (globalThis.__agentBrowserPage || {}).target;
if (!el || el.tagName !== 'SELECT') return { ok: false, reason: 'That is not a dropdown list. Click it and pick the option by name instead.' };
const wanted = ${JSON.stringify(option.trim().toLowerCase())};
const opts = Array.from(el.options);
const text = (o) => String(o.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase();
const match = opts.find((o) => text(o) === wanted || o.value.toLowerCase() === wanted) || opts.find((o) => text(o).indexOf(wanted) !== -1);
if (!match) return { ok: false, reason: 'That option is not in the list. It has: ' + opts.slice(0, 15).map((o) => String(o.textContent || '').trim()).join(', ') };
const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
if (setter && setter.set) setter.set.call(el, match.value); else el.value = match.value;
el.dispatchEvent(new Event('input', { bubbles: true }));
el.dispatchEvent(new Event('change', { bubbles: true }));
return { ok: true, reason: '', value: String(match.textContent || '').trim() };
})()`
}

/** The text a site profile check reads: status-free, visible text only. */
export function pageTextScript(): string {
  return `(() => ({ title: document.title, text: String(document.body ? document.body.innerText || '' : '').slice(0, 4000) }))()`
}

/**
 * Wraps the agent's code for the page's MAIN world, so it sees the page's own globals and framework
 * state (React props, Vue instances, player APIs). `log()` collects lines that come back with the
 * result and also land in window.__agentLog, so a long fire-and-forget script can be polled.
 */
export function evalWrapper(code: string, asExpression: boolean): string {
  const body = asExpression ? `return (${code}\n);` : code
  return `(async () => {
const __lines = [];
window.__agentLog = window.__agentLog || [];
const __t0 = Date.now();
const log = (...parts) => {
  const line = ((Date.now() - __t0) / 1000).toFixed(1) + 's ' + parts.map((p) => { try { return typeof p === 'string' ? p : JSON.stringify(p); } catch (e) { return String(p); } }).join(' ');
  __lines.push(line); window.__agentLog.push(line); if (window.__agentLog.length > 500) window.__agentLog.splice(0, 100);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
const waitFor = async (fn, ms, every) => { const end = Date.now() + (ms || 10000); for (;;) { let v = null; try { v = await fn(); } catch (e) { v = null; } if (v) return v; if (Date.now() > end) return null; await sleep(every || 250); } };
const setValue = (el, value) => { const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value'); if (d && d.set) d.set.call(el, String(value)); else el.value = String(value); ['input', 'change'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true }))); return el.value; };
try {
  const __value = await (async () => {
${body}
  })();
  let out;
  try { out = __value === undefined ? undefined : JSON.parse(JSON.stringify(__value, (k, v) => (v instanceof Node ? '<' + v.nodeName.toLowerCase() + '>' : v))); } catch (e) { out = String(__value); }
  return { ok: true, value: out, log: __lines, error: '' };
} catch (error) {
  return { ok: false, value: null, log: __lines, error: String(error && error.stack ? error.stack : error).slice(0, 2000) };
}
})()`
}

// ---- parsing and formatting -------------------------------------------------------------------------

export function parseSnapshot(value: unknown): SnapshotResult {
  const raw = objectOf(value)
  const elements: SnapshotElement[] = []
  if (Array.isArray(raw['elements'])) {
    raw['elements'].forEach((entry, position) => {
      const item = objectOf(entry)
      elements.push({
        index: typeof item['index'] === 'number' ? item['index'] : position,
        role: str(item['role']),
        name: str(item['name']),
        state: str(item['state']),
        href: str(item['href']),
        frame: str(item['frame']),
      })
    })
  }
  return {
    url: str(raw['url']),
    title: str(raw['title']),
    elements,
    headings: strings(raw['headings']),
    dialogs: strings(raw['dialogs']),
    frames: strings(raw['frames']),
    total: typeof raw['total'] === 'number' ? raw['total'] : elements.length,
    note: str(raw['note']),
    focused: str(raw['focused']),
  }
}

export function parseResolved(value: unknown): Resolved {
  const raw = objectOf(value)
  const checked = raw['checked']
  return {
    ok: raw['ok'] === true,
    reason: str(raw['reason']),
    x: typeof raw['x'] === 'number' ? raw['x'] : 0,
    y: typeof raw['y'] === 'number' ? raw['y'] : 0,
    label: str(raw['label']),
    role: str(raw['role']),
    tag: str(raw['tag']),
    editable: raw['editable'] === true,
    checked: typeof checked === 'boolean' ? checked : null,
    covered: str(raw['covered']),
    candidates: strings(raw['candidates']),
  }
}

export interface ViewLine {
  label: string
  innerWidth?: number
  innerHeight?: number
}

export function formatSnapshot(result: SnapshotResult, extra: { view?: string; filter?: string; downloads?: string[]; notes?: string } = {}): string {
  const lines: string[] = []
  if (extra.notes !== undefined && extra.notes.trim() !== '') lines.push(extra.notes.trim(), '')
  lines.push(`URL: ${result.url === '' ? '(none)' : result.url}`)
  lines.push(`Title: ${result.title === '' ? '(untitled)' : result.title}`)
  if (extra.view !== undefined && extra.view !== '') lines.push(`View: ${extra.view}`)
  if (result.focused !== '') lines.push(`Focused: ${result.focused}`)
  if (result.dialogs.length > 0) lines.push(`Open dialog: ${result.dialogs.join(' | ')}`)
  lines.push('')
  const filtered = extra.filter !== undefined && extra.filter !== '' ? ` matching "${extra.filter}"` : ''
  lines.push(`Elements${filtered} (act by name; numbers go stale when the page changes):`)
  if (result.elements.length === 0) lines.push('(none found)')
  for (const element of result.elements) {
    const state = element.state === '' ? '' : ` ${element.state}`
    const href = element.href === '' ? '' : ` -> ${element.href}`
    const frame = element.frame === '' ? '' : ` [in frame ${element.frame}]`
    lines.push(`[${element.index}] ${element.role} "${element.name}"${state}${href}${frame}`)
  }
  if (result.total > result.elements.length) {
    lines.push(`... ${result.total - result.elements.length} more. Use filter to narrow it down.`)
  }
  if (result.headings.length > 0) {
    lines.push('', 'Headings:')
    for (const heading of result.headings) lines.push(`- ${heading}`)
  }
  if (result.frames.length > 0) {
    lines.push('', 'Cross-origin frames (cannot be read; look with browser_look and act at:{x,y}):')
    for (const frame of result.frames) lines.push(`- ${frame}`)
  }
  if (result.note !== '') lines.push('', `NOTE: ${result.note}`)
  if (extra.downloads !== undefined && extra.downloads.length > 0) {
    lines.push('', 'Files downloaded:')
    for (const path of extra.downloads) lines.push(`- ${path}`)
  }
  return lines.join('\n')
}

/** Whether the agent's code reads as one expression (then its value is returned) or as statements. */
export function looksLikeExpression(code: string, compiles: (source: string) => boolean): boolean {
  const trimmed = code.trim().replace(/;+\s*$/, '')
  if (trimmed === '') return false
  if (/^(const|let|var|if|for|while|function|class|return|try|throw|switch|do)\b/.test(trimmed)) return false
  return compiles(`(async () => (${trimmed}\n))`)
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}
