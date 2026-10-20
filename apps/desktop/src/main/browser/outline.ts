/**
 * The page helpers the browser tools use. They are plain JavaScript strings so the same code runs
 * inside the browser page (through `executeJavaScriptInIsolatedWorld`) and in the Playwright tests,
 * with no DOM library in the main process and no debugger protocol.
 *
 * The page keeps a small registry of the elements it numbered in the last outline, so
 * `browser_click(index)` and `browser_type(index)` refer to exactly what the model saw.
 */

export const PAGE_WORLD_ID = 1099

export interface OutlineElement {
  index: number
  kind: string
  label: string
  extra: string
}

export interface OutlineResult {
  url: string
  title: string
  elements: OutlineElement[]
  headings: string[]
  note: string
}

export interface ReadTarget {
  index?: number
  selector?: string
}

export interface ReadResult {
  ok: boolean
  text: string
  label: string
  reason: string
}

export interface ActionScriptResult {
  ok: boolean
  label: string
  reason: string
}

const PRELUDE = `
const KEY = '__agentBrowserPage';
const store = globalThis[KEY] || (globalThis[KEY] = { refs: [] });
const clean = (value) => String(value == null ? '' : value).replace(/\\s+/g, ' ').trim();
const visible = (el) => {
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};
const labelOf = (el) => {
  const aria = el.getAttribute('aria-label');
  if (aria && clean(aria) !== '') return clean(aria);
  const labelled = el.getAttribute('aria-labelledby');
  if (labelled) {
    const text = labelled.split(/\\s+/).map((id) => {
      const node = document.getElementById(id);
      return node ? (node.innerText || node.textContent || '') : '';
    }).join(' ');
    if (clean(text) !== '') return clean(text);
  }
  if (el.labels && el.labels.length > 0) return clean(el.labels[0].innerText || el.labels[0].textContent);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder && clean(placeholder) !== '') return clean(placeholder);
  const text = clean(el.innerText || el.textContent);
  if (text !== '') return text;
  const title = el.getAttribute('title');
  if (title && clean(title) !== '') return clean(title);
  return el.tagName.toLowerCase();
};
const fillField = (el, value) => {
  el.focus();
  if (el.isContentEditable) {
    el.textContent = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor && descriptor.set) descriptor.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
const blockerNote = () => {
  const text = ((document.body && document.body.innerText) || '').replace(/\\s+/g, ' ').toLowerCase();
  if (/captcha|recaptcha|hcaptcha|are you a robot|verify (that )?you are (a )?human|not a robot/.test(text)) {
    return 'This page has a captcha. A person may need to take over.';
  }
  if (/two-factor|two factor|verification code|authenticator|security code/.test(text)
      && document.querySelector('input[type=password],input[autocomplete="one-time-code"],input[inputmode="numeric"]')) {
    return 'This page is asking for a sign-in or verification code. A person may need to take over.';
  }
  if (document.querySelector('input[type=password]')) {
    return 'This page has a sign-in form. A person may need to take over if the details are not yours to use.';
  }
  return '';
};
`

export function outlineScript(): string {
  return `(() => {
${PRELUDE}
store.refs = [];
const elements = [];
const seen = new Set();
const nodes = document.querySelectorAll('a[href],button,input,textarea,select,summary,[contenteditable="true"],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[role="combobox"],[onclick]');
for (const el of nodes) {
  if (seen.has(el)) continue;
  seen.add(el);
  if (el.tagName === 'INPUT' && el.type === 'hidden') continue;
  if (!visible(el)) continue;

  const index = elements.length;
  store.refs[index] = el;
  const tag = el.tagName.toLowerCase();
  let kind = tag;
  if (tag === 'a') kind = 'link';
  else if (tag === 'button') kind = 'button';
  else if (tag === 'input') kind = 'input[' + (el.type || 'text') + ']';
  else if (tag === 'textarea') kind = 'textbox';
  else if (tag === 'select') kind = 'select';
  else if (el.getAttribute('role')) kind = el.getAttribute('role');

  let extra = '';
  if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') extra += ' (disabled)';
  if (el.type === 'checkbox' || el.type === 'radio') extra += el.checked ? ' (checked)' : ' (unchecked)';
  if (tag === 'input' && el.type !== 'password' && el.type !== 'file' && el.value) {
    extra += ' = "' + clean(el.value).slice(0, 60) + '"';
  }
  if (tag === 'select' && el.selectedOptions && el.selectedOptions[0]) {
    extra += ' selected "' + clean(el.selectedOptions[0].textContent).slice(0, 60) + '"';
  }
  if (tag === 'a') {
    const href = el.getAttribute('href') || '';
    if (href !== '' && href.charAt(0) !== '#') extra += ' -> ' + href.slice(0, 120);
  }

  elements.push({ index, kind, label: labelOf(el).slice(0, 90), extra });
  if (elements.length >= 120) break;
}

const headings = [];
for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
  if (!visible(el)) continue;
  const text = clean(el.innerText || el.textContent);
  if (text !== '') headings.push(text.slice(0, 100));
  if (headings.length >= 20) break;
}

return { url: location.href, title: document.title, elements, headings, note: blockerNote() };
})()`
}

export function readScript(target: ReadTarget = {}): string {
  const index = target.index === undefined ? 'null' : String(Math.floor(target.index))
  const selector = JSON.stringify(target.selector ?? '')
  return `(() => {
${PRELUDE}
const index = ${index};
const selector = ${selector};
const readable = (value) => String(value == null ? '' : value)
  .replace(/\\r/g, '')
  .replace(/[ \\t]+/g, ' ')
  .replace(/\\n{3,}/g, '\\n\\n')
  .trim()
  .slice(0, 8000);
const textOf = (el) => {
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
  if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) return el.selectedOptions[0].textContent || '';
  return el.innerText || el.textContent || '';
};
if (index !== null) {
  const el = store.refs[index];
  if (!el) return { ok: false, text: '', label: '', reason: 'That number is not on the current outline. Look at the page again first.' };
  return { ok: true, text: readable(textOf(el)), label: labelOf(el).slice(0, 90), reason: '' };
}
if (selector !== '') {
  let el;
  try {
    el = document.querySelector(selector);
  } catch (error) {
    return { ok: false, text: '', label: '', reason: 'That selector is not valid.' };
  }
  if (!el) return { ok: false, text: '', label: '', reason: 'Nothing on the page matches that selector.' };
  return { ok: true, text: readable(textOf(el)), label: labelOf(el).slice(0, 90), reason: '' };
}
const body = document.body ? (document.body.innerText || document.body.textContent || '') : '';
return { ok: true, text: readable(body), label: 'The page', reason: '' };
})()`
}

export function clickScript(index: number): string {
  return `(() => {
${PRELUDE}
const el = store.refs[${Math.floor(index)}];
if (!el) return { ok: false, label: '', reason: 'That number is not on the current outline. Look at the page again first.' };
try {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (el.focus) el.focus({ preventScroll: true });
  el.click();
  return { ok: true, label: labelOf(el).slice(0, 90), reason: '' };
} catch (error) {
  return { ok: false, label: '', reason: 'Could not click that element.' };
}
})()`
}

export function typeScript(index: number, text: string): string {
  const value = JSON.stringify(text)
  return `(() => {
${PRELUDE}
let el = store.refs[${Math.floor(index)}];
if (!el) return { ok: false, label: '', reason: 'That number is not on the current outline. Look at the page again first.' };
if (el.tagName === 'INPUT' && el.type === 'file') {
  return { ok: false, label: '', reason: 'That is a file field. Use browser_upload instead.' };
}
if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT' && !el.isContentEditable) {
  const label = el.closest ? el.closest('label') : null;
  const nested = el.querySelector('input:not([type=hidden]),textarea,select')
    || (label ? label.querySelector('input:not([type=hidden]),textarea,select') : null);
  if (!nested) return { ok: false, label: '', reason: 'That element is not a text field.' };
  el = nested;
}
if (el.tagName === 'SELECT') {
  const wanted = ${value}.toLowerCase();
  const options = Array.from(el.options);
  const match = options.find((option) => clean(option.textContent).toLowerCase() === wanted)
    || options.find((option) => clean(option.textContent).toLowerCase().indexOf(wanted) !== -1);
  if (!match) return { ok: false, label: '', reason: 'That option is not in the list.' };
  el.value = match.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
} else {
  fillField(el, ${value});
}
return { ok: true, label: labelOf(el).slice(0, 90), reason: '' };
})()`
}

export function scrollScript(dy: number): string {
  return `(() => {
window.scrollBy(0, ${Math.round(dy)});
return { ok: true };
})()`
}

export function waitForScript(text: string, selector: string, timeoutMs: number): string {
  const wanted = JSON.stringify(text)
  const query = JSON.stringify(selector)
  const limit = Math.max(0, Math.floor(timeoutMs))
  return `(async () => {
${PRELUDE}
const wanted = ${wanted};
const selector = ${query};
if (wanted === '' && selector === '') return { ok: false, reason: 'Pass some text or a selector.' };
if (selector !== '') {
  try {
    if (document.querySelector(selector)) return { ok: true };
  } catch (error) {
    return { ok: false, reason: 'That selector is not valid.' };
  }
}
const deadline = Date.now() + ${limit};
for (;;) {
  if (selector !== '') {
    try {
      if (document.querySelector(selector)) return { ok: true };
    } catch (error) {
      return { ok: false, reason: 'That selector is not valid.' };
    }
  }
  if (wanted !== '') {
    const body = ((document.body && document.body.innerText) || '');
    if (body.indexOf(wanted) !== -1) return { ok: true };
  }
  if (Date.now() >= deadline) return { ok: false };
  await new Promise((resolve) => setTimeout(resolve, 250));
}
})()`
}

export function uploadScript(
  index: number,
  file: { name: string; type: string; base64: string },
): string {
  const payload = JSON.stringify(file)
  return `(() => {
${PRELUDE}
const file = ${payload};
let el = store.refs[${Math.floor(index)}] || null;
if (!el) return { ok: false, label: '', reason: 'That number is not on the current outline. Look at the page again first.' };
let input = null;
if (el.tagName === 'INPUT' && el.type === 'file') input = el;
if (!input && el.closest) {
  const form = el.closest('form');
  input = form ? form.querySelector('input[type=file]') : null;
}
if (!input) {
  const label = el.closest ? el.closest('label') : null;
  input = label ? label.querySelector('input[type=file]') : null;
}
if (!input) input = document.querySelector('input[type=file]');
if (!input) return { ok: false, label: '', reason: 'I could not find a file field on this page.' };
let transfer;
try {
  const bytes = Uint8Array.from(atob(file.base64), (ch) => ch.charCodeAt(0));
  const blob = new File([bytes], file.name, { type: file.type || 'application/octet-stream' });
  transfer = new DataTransfer();
  transfer.items.add(blob);
} catch (error) {
  return { ok: false, label: '', reason: 'I could not read that file.' };
}
try {
  Object.defineProperty(input, 'files', { value: transfer.files, configurable: true });
} catch (error) {
  try {
    input.files = transfer.files;
  } catch (second) {
    return { ok: false, label: '', reason: 'This file field will not accept an automated upload.' };
  }
}
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
return { ok: true, label: file.name, reason: '' };
})()`
}

export function parseOutline(value: unknown): OutlineResult {
  const raw = objectOf(value)
  const elements: OutlineElement[] = []
  if (Array.isArray(raw.elements)) {
    raw.elements.forEach((entry, position) => {
      const item = objectOf(entry)
      elements.push({
        index: numberField(item.index, position),
        kind: stringField(item.kind),
        label: stringField(item.label),
        extra: stringField(item.extra),
      })
    })
  }
  const headings = Array.isArray(raw.headings)
    ? raw.headings.filter((item): item is string => typeof item === 'string')
    : []
  return {
    url: stringField(raw.url),
    title: stringField(raw.title),
    elements,
    headings,
    note: stringField(raw.note),
  }
}

export function parseRead(value: unknown): ReadResult {
  const raw = objectOf(value)
  return {
    ok: raw.ok === true,
    text: stringField(raw.text),
    label: stringField(raw.label),
    reason: stringField(raw.reason),
  }
}

export function parseAction(value: unknown): ActionScriptResult {
  const raw = objectOf(value)
  return {
    ok: raw.ok === true,
    label: stringField(raw.label),
    reason: stringField(raw.reason),
  }
}

/** The compact text the model sees. */
export function formatOutline(result: OutlineResult, downloads: string[] = []): string {
  const lines: string[] = []
  lines.push(`URL: ${result.url === '' ? '(none)' : result.url}`)
  lines.push(`Title: ${result.title === '' ? '(untitled)' : result.title}`)
  lines.push('')
  lines.push('Interactive:')
  if (result.elements.length === 0) {
    lines.push('(none found)')
  } else {
    for (const element of result.elements) {
      const extra = element.extra === '' ? '' : ` ${element.extra}`
      lines.push(`[${element.index}] ${element.kind} "${element.label}"${extra}`)
    }
  }
  if (result.headings.length > 0) {
    lines.push('')
    lines.push('Headings:')
    for (const heading of result.headings) lines.push(`- ${heading}`)
  }
  if (result.note !== '') {
    lines.push('')
    lines.push(`NOTE: ${result.note}`)
  }
  if (downloads.length > 0) {
    lines.push('')
    lines.push('Files downloaded:')
    for (const path of downloads) lines.push(`- ${path}`)
  }
  return lines.join('\n')
}

function objectOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
