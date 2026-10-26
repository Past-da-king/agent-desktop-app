/**
 * browser_upload: put a file from this computer into a page the way a person choosing it would, and prove it landed.
 *
 * Why not a page script: the browser's own scripts run in an isolated world, and a FileList faked there (the old
 * `Object.defineProperty(input, 'files', ...)`) is seen only by that world. The page's own code (React on LinkedIn and
 * X) read an empty field, and the tool still said "Uploaded" because nothing checked. Here the files are set through
 * the debugger (DOM.setFileInputFiles), which fills the real field and fires input and change as a real selection
 * does, and every route is checked before it may say it worked.
 *
 * Three routes, in order:
 *  1. input: the real <input type=file> for the target (the target itself, a label's control, inside it, the nearest
 *     one around it, through open shadow roots and same-origin frames, or the only one on the page).
 *  2. chooser: no field yet (the page makes one, or calls input.click() / showPicker() from a button): the file
 *     chooser is intercepted for a moment, the target is clicked with a trusted click, and the chooser the page opens
 *     is answered with the files. The native dialog never shows, and interception is off again within seconds.
 *  3. drop: a drop zone with no field: dragenter, dragover and drop carry a DataTransfer with the file's bytes.
 * Then: the field holds the files (names and sizes match) and change fired, or a drop was taken; otherwise an error.
 *
 * Kept free of Electron so the desktop browser, the headless node's browser and the tests share it.
 */
import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'

import { PAGE_PRELUDE, resolveScript } from './snapshot'

/** The parts of a page's debugger this uses (vault-link.ts debuggerLink is one). */
export interface UploadLink {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void
}

export interface UploadHost {
  link: UploadLink
  /** Runs one of the browser's page scripts where the outline's numbered elements live, returning its value. */
  runPage(code: string): Promise<unknown>
  /** A trusted click (real mouse or tap through the debugger) at a point the target resolver measured. */
  click(point: { x: number; y: number }): Promise<boolean>
  /** Requests the page made since a time (epoch ms), from the tab's network log. Optional. */
  requestsSince?(since: number): Array<{ method: string; url: string; type: string; status: number | null }>
  sleep?(ms: number): Promise<void>
}

export interface UploadTarget {
  index?: number
  name?: string
  role?: string
  nth?: number
}

export type UploadRoute = 'input' | 'chooser' | 'drop'

export type UploadOutcome =
  | {
      ok: true
      route: UploadRoute
      /** How the field was found (input route) or what took the drop. */
      how: string
      target: string
      files: Array<{ name: string; size: number }>
      /** The page saw change (and input) fire from the selection itself. */
      changeFired: boolean
      /** change did not fire on its own, so it was sent. */
      dispatched: boolean
      requests: string[]
    }
  | { ok: false; reason: string }

export interface UploadOptions {
  /** How long the page has to open a file chooser after the click. */
  chooserMs?: number
  /** How long to watch for the page sending the file. */
  networkMs?: number
  /** Largest total for a drop (its bytes go into the page). */
  maxDropBytes?: number
}

const WORLD = 'agent-upload'
const DEFAULT_CHOOSER_MS = 2500
const DEFAULT_NETWORK_MS = 2500
const MAX_DROP_BYTES = 25 * 1024 * 1024
const MAX_FILES = 20

interface LocalFile {
  path: string
  name: string
  size: number
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
}

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Checks every path before anything touches the page. A string is the error. */
export function localFiles(paths: string[]): LocalFile[] | string {
  const list = paths.map((path) => path.trim()).filter((path) => path !== '')
  if (list.length === 0) return 'Pass the full path of the file to upload.'
  if (list.length > MAX_FILES) return `That is ${list.length} files; ${MAX_FILES} at most in one upload.`
  const out: LocalFile[] = []
  for (const path of list) {
    let size = 0
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return `${path} is not a file.`
      size = stat.size
    } catch {
      return `There is no file at ${path}. Nothing was uploaded.`
    }
    out.push({ path, name: basename(path.replace(/\\/g, '/')), size })
  }
  return out
}

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Finds the element the agent named and the real file field that belongs to it, and marks both with a one-off
 * attribute so the debugger can take hold of them from its own world. Runs where the outline's numbered elements live.
 */
export function markScript(target: UploadTarget, token: string): string {
  const q = JSON.stringify({ index: target.index ?? null, token })
  return `(() => {
${PAGE_PRELUDE}
const q = ${q};
const isFile = (n) => !!n && n.nodeType === 1 && n.tagName === 'INPUT' && String(n.type || '').toLowerCase() === 'file';
const all = (root, out) => {
  if (!root) return out;
  const list = root.querySelectorAll ? root.querySelectorAll('*') : [];
  const nodes = root.nodeType === 1 ? [root].concat(Array.from(list)) : Array.from(list);
  for (const n of nodes) {
    if (isFile(n) && out.indexOf(n) === -1) out.push(n);
    if (n.shadowRoot) all(n.shadowRoot, out);
    if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') {
      let doc = null;
      try { doc = n.contentDocument; } catch (e) { doc = null; }
      if (doc) all(doc, out);
    }
  }
  return out;
};
const up = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
let el = store.target || null;
if (q.index !== null) {
  const ref = store.refs[q.index];
  if (ref && ref.isConnected) el = ref;
}
if (!el || !el.isConnected) return { ok: false, reason: 'That element is not on the page any more. Take a new snapshot.' };
store.target = null;
let input = null;
let how = '';
if (isFile(el)) { input = el; how = 'the field itself'; }
if (!input) {
  const label = el.tagName === 'LABEL' ? el : (el.closest ? el.closest('label') : null);
  if (label && isFile(label.control)) { input = label.control; how = 'the field its label points at'; }
}
if (!input) {
  const inside = all(el, []);
  if (inside.length > 0) { input = inside[0]; how = 'the field inside it'; }
}
if (!input) {
  let node = up(el);
  for (let level = 0; node && level < 8 && node !== document.body && node !== document.documentElement; level++) {
    const near = all(node, []);
    if (near.length > 0) { input = near[0]; how = 'the field next to it'; break; }
    if (node.tagName === 'FORM') break;
    node = up(node);
  }
}
if (!input) {
  const page = all(document, []);
  if (page.length === 1) { input = page[0]; how = 'the only file field on the page'; }
}
el.setAttribute('data-agent-upload-target', q.token);
const label = (roleOf(el) + ' "' + nameOf(el).slice(0, 70) + '"').trim();
if (!input) return { ok: true, found: false, label, how: '', multiple: false, disabled: false, accept: '' };
input.setAttribute('data-agent-upload', q.token);
return { ok: true, found: true, label, how, multiple: !!input.multiple, disabled: !!input.disabled, accept: String(input.accept || '') };
})()`
}

/** Finds a marked element through shadow roots and same-origin frames; runs in the upload's own world. */
function findMarked(attribute: string, token: string): string {
  return `(() => {
const want = ${JSON.stringify(token)};
const attr = ${JSON.stringify(attribute)};
const find = (root) => {
  if (!root) return null;
  const direct = root.querySelector ? root.querySelector('[' + attr + '="' + want + '"]') : null;
  if (direct) return direct;
  const list = root.querySelectorAll ? root.querySelectorAll('*') : [];
  for (const n of list) {
    if (n.shadowRoot) { const hit = find(n.shadowRoot); if (hit) return hit; }
    if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') {
      let doc = null;
      try { doc = n.contentDocument; } catch (e) { doc = null; }
      const hit = doc ? find(doc) : null;
      if (hit) return hit;
    }
  }
  return null;
};
const el = find(document);
if (el) el.removeAttribute(attr);
return el;
})()`
}

const WATCH = `function () {
  const seen = { change: 0, input: 0 };
  const onChange = () => { seen.change++; };
  const onInput = () => { seen.input++; };
  this.addEventListener('change', onChange, true);
  this.addEventListener('input', onInput, true);
  this.__agentUploadSeen = { seen, off: () => { this.removeEventListener('change', onChange, true); this.removeEventListener('input', onInput, true); } };
  return true;
}`

const CHECK = `function (dispatch) {
  const state = this.__agentUploadSeen || { seen: { change: 0, input: 0 }, off: () => undefined };
  const files = Array.from(this.files || []).map((f) => ({ name: f.name, size: f.size }));
  const fired = state.seen.change > 0;
  let dispatched = false;
  if (dispatch && files.length > 0 && !fired) {
    this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    dispatched = true;
  }
  state.off();
  delete this.__agentUploadSeen;
  return { files, fired, inputs: state.seen.input, dispatched, connected: this.isConnected };
}`

const DROP = `function (payload) {
  const list = JSON.parse(payload);
  const dt = new DataTransfer();
  for (const f of list) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
  const r = this.getBoundingClientRect();
  const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  const fire = (type) => {
    const event = new DragEvent(type, Object.assign({ bubbles: true, cancelable: true, composed: true, dataTransfer: dt }, at));
    this.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const enter = fire('dragenter');
  const over = fire('dragover');
  const drop = fire('drop');
  return { enter, over, drop };
}`

class Session {
  private contexts = new Map<string, number>()
  constructor(private readonly link: UploadLink) {}

  async topFrame(): Promise<string> {
    const tree = obj(await this.link.send('Page.getFrameTree'))
    return String(obj(obj(tree['frameTree'])['frame'])['id'] ?? '')
  }

  /** The upload's own isolated world in a frame: its listeners and expandos are invisible to the page. */
  async world(frameId: string): Promise<number> {
    const known = this.contexts.get(frameId)
    if (known !== undefined) return known
    const made = obj(await this.link.send('Page.createIsolatedWorld', { frameId, worldName: WORLD, grantUniveralAccess: false }))
    const id = Number(made['executionContextId'])
    if (!Number.isFinite(id)) throw new Error('the page gave no world to work in')
    this.contexts.set(frameId, id)
    return id
  }

  async marked(attribute: string, token: string): Promise<string | null> {
    const contextId = await this.world(await this.topFrame())
    const result = obj(obj(await this.link.send('Runtime.evaluate', { expression: findMarked(attribute, token), contextId, returnByValue: false })))
    const remote = obj(result['result'])
    return typeof remote['objectId'] === 'string' ? remote['objectId'] : null
  }

  async call(objectId: string, fn: string, args: unknown[] = []): Promise<unknown> {
    const result = obj(
      await this.link.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: fn,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      }),
    )
    if (result['exceptionDetails'] !== undefined) {
      const details = obj(result['exceptionDetails'])
      throw new Error(String(obj(details['exception'])['description'] ?? details['text'] ?? 'the page script failed'))
    }
    return obj(result['result'])['value']
  }

  release(objectId: string | null): void {
    if (objectId !== null) void this.link.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The whole upload: find, set (or answer the chooser, or drop), verify. Never says it worked unless it did. */
export async function uploadFiles(host: UploadHost, target: UploadTarget, paths: string[], options: UploadOptions = {}): Promise<UploadOutcome> {
  const sleep = host.sleep ?? pause
  const files = localFiles(paths)
  if (typeof files === 'string') return { ok: false, reason: files }
  if (target.index === undefined && (target.name ?? '').trim() === '') {
    return { ok: false, reason: 'Say which element: the upload button, drop area or file field by its [number] or its name.' }
  }
  const session = new Session(host.link)
  const token = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const started = Date.now()

  // Where the target is, for the click (a numbered file field may be hidden: that one needs no measuring).
  let point: { x: number; y: number } | null = null
  const resolved = obj(await host.runPage(resolveScript(target, 1500)))
  if (resolved['ok'] === true) point = { x: Number(resolved['x']), y: Number(resolved['y']) }
  else if (target.index === undefined) return { ok: false, reason: String(resolved['reason'] ?? 'That element is not on the page.') }
  const mark = obj(await host.runPage(markScript(point === null ? { ...(target.index === undefined ? {} : { index: target.index }) } : {}, token)))
  if (mark['ok'] !== true) return { ok: false, reason: String(resolved['reason'] ?? '') || String(mark['reason'] ?? 'That element is not on the page.') }
  const label = String(mark['label'] ?? 'the element')
  const done = (route: UploadRoute, how: string, check: Record<string, unknown>, requests: string[]): UploadOutcome => ({
    ok: true,
    route,
    how,
    target: label,
    files: Array.isArray(check['files']) ? (check['files'] as Array<{ name: string; size: number }>) : files.map((f) => ({ name: f.name, size: f.size })),
    changeFired: check['fired'] === true,
    dispatched: check['dispatched'] === true,
    requests,
  })

  // 1. A real field: set it through the debugger.
  if (mark['found'] === true) {
    const targetId = await session.marked('data-agent-upload-target', token).catch(() => null)
    session.release(targetId)
    if (mark['disabled'] === true) return { ok: false, reason: `The file field for ${label} is disabled, so a person could not choose a file there either.` }
    if (files.length > 1 && mark['multiple'] !== true) return { ok: false, reason: `The file field for ${label} takes one file; ${files.length} were given. Nothing was uploaded.` }
    const inputId = await session.marked('data-agent-upload', token).catch(() => null)
    if (inputId === null) return { ok: false, reason: `Found the file field for ${label}, but the debugger could not take hold of it. Nothing was uploaded.` }
    try {
      return await setAndCheck(session, host, inputId, files, label, String(mark['how'] ?? ''), 'input', started, options, sleep, done)
    } finally {
      session.release(inputId)
    }
  }

  // 2. No field yet: the page opens the chooser itself when the target is clicked.
  if (point !== null) {
    const opened = await catchChooser(host, point, options.chooserMs ?? DEFAULT_CHOOSER_MS, sleep)
    if (typeof opened === 'string') {
      // Fall through to the drop only when no chooser came; a chooser that went wrong is the answer.
      if (opened !== '') return { ok: false, reason: opened }
    } else {
      const multiple = opened.mode === 'selectMultiple'
      let inputId: string | null = null
      try {
        const contextId = await session.world(opened.frameId || (await session.topFrame()))
        const node = obj(await host.link.send('DOM.resolveNode', { backendNodeId: opened.backendNodeId, executionContextId: contextId }))
        inputId = typeof obj(node['object'])['objectId'] === 'string' ? String(obj(node['object'])['objectId']) : null
      } catch {
        inputId = null
      }
      if (files.length > 1 && !multiple) {
        await host.link.send('DOM.setFileInputFiles', { files: [], backendNodeId: opened.backendNodeId }).catch(() => undefined)
        session.release(inputId)
        return { ok: false, reason: `Clicking ${label} opened a chooser for one file; ${files.length} were given. Nothing was uploaded.` }
      }
      if (inputId === null) {
        await host.link.send('DOM.setFileInputFiles', { files: [], backendNodeId: opened.backendNodeId }).catch(() => undefined)
        return { ok: false, reason: `Clicking ${label} opened a file chooser, but its field could not be reached. Nothing was uploaded.` }
      }
      try {
        return await setAndCheck(session, host, inputId, files, label, 'the file chooser it opened', 'chooser', started, options, sleep, done)
      } finally {
        session.release(inputId)
      }
    }
  }

  // 3. A drop zone: hand it the files the way a drag from the desktop does.
  const total = files.reduce((sum, file) => sum + file.size, 0)
  const targetId = await session.marked('data-agent-upload-target', token).catch(() => null)
  if (targetId === null) {
    return { ok: false, reason: `No file field was found for ${label}, and ${point === null ? 'it could not be clicked' : 'clicking it opened no file chooser'}. Nothing was uploaded.` }
  }
  try {
    if (total > (options.maxDropBytes ?? MAX_DROP_BYTES)) {
      return { ok: false, reason: `No file field was found for ${label} and clicking it opened no file chooser; dropping ${Math.round(total / 1048576)} MB onto it is more than this tool carries. Nothing was uploaded.` }
    }
    const payload = JSON.stringify(files.map((file) => ({ name: file.name, type: mimeOf(file.path), base64: readFileSync(file.path).toString('base64') })))
    const dropped = obj(await session.call(targetId, DROP, [payload]))
    if (dropped['over'] !== true && dropped['drop'] !== true) {
      return {
        ok: false,
        reason: `No file field was found for ${label}, ${point === null ? 'it could not be clicked' : 'clicking it opened no file chooser'}, and it did not take a dropped file. Nothing was uploaded. Look for the real upload button (browser_snapshot) and try that.`,
      }
    }
    const requests = await watchRequests(host, started, options.networkMs ?? DEFAULT_NETWORK_MS, sleep)
    return done('drop', 'a drop onto it', { files: files.map((f) => ({ name: f.name, size: f.size })), fired: true }, requests)
  } finally {
    session.release(targetId)
  }
}

async function setAndCheck(
  session: Session,
  host: UploadHost,
  inputId: string,
  files: LocalFile[],
  label: string,
  how: string,
  route: UploadRoute,
  started: number,
  options: UploadOptions,
  sleep: (ms: number) => Promise<void>,
  done: (route: UploadRoute, how: string, check: Record<string, unknown>, requests: string[]) => UploadOutcome,
): Promise<UploadOutcome> {
  await session.call(inputId, WATCH)
  try {
    await host.link.send('DOM.setFileInputFiles', { files: files.map((file) => file.path), objectId: inputId })
  } catch (error) {
    await session.call(inputId, CHECK, [false]).catch(() => undefined)
    return { ok: false, reason: `The file field for ${label} refused the file: ${message(error)}. Nothing was uploaded.` }
  }
  await sleep(150)
  const check = obj(await session.call(inputId, CHECK, [true]))
  const got = Array.isArray(check['files']) ? (check['files'] as Array<Record<string, unknown>>) : []
  const missing = files.filter((file) => !got.some((g) => g['name'] === file.name && Number(g['size']) === file.size))
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `The file field for ${label} does not hold ${missing.map((f) => f.name).join(', ')} after setting it (it holds ${got.length === 0 ? 'nothing' : got.map((g) => String(g['name'])).join(', ')}). Nothing was uploaded.`,
    }
  }
  const requests = await watchRequests(host, started, options.networkMs ?? DEFAULT_NETWORK_MS, sleep)
  return done(route, how, check, requests)
}

/** Clicks the target with the chooser intercepted; the chooser the page opened, '' when none came, or an error. */
async function catchChooser(
  host: UploadHost,
  point: { x: number; y: number },
  waitMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ backendNodeId: number; mode: string; frameId: string } | string> {
  let opened: { backendNodeId: number; mode: string; frameId: string } | null = null
  const off = host.link.onEvent((method, params, sessionId) => {
    if (method !== 'Page.fileChooserOpened' || (sessionId !== undefined && sessionId !== '') || opened !== null) return
    const id = Number(params['backendNodeId'])
    if (Number.isFinite(id)) opened = { backendNodeId: id, mode: String(params['mode'] ?? 'selectSingle'), frameId: String(params['frameId'] ?? '') }
  })
  try {
    await host.link.send('Page.enable').catch(() => undefined)
    try {
      await host.link.send('Page.setInterceptFileChooserDialog', { enabled: true })
    } catch (error) {
      return `This page's file chooser cannot be answered automatically (${message(error)}). Nothing was uploaded.`
    }
    const clicked = await host.click(point)
    if (!clicked) return 'The page did not take the click on the upload button. Nothing was uploaded.'
    const deadline = Date.now() + waitMs
    while (opened === null && Date.now() < deadline) await sleep(40)
    return opened ?? ''
  } finally {
    off()
    // The person's own uploads get the normal dialog again straight away.
    await host.link.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined)
  }
}

async function watchRequests(host: UploadHost, since: number, waitMs: number, sleep: (ms: number) => Promise<void>): Promise<string[]> {
  if (host.requestsSince === undefined || waitMs <= 0) return []
  const pick = (): string[] =>
    (host.requestsSince?.(since) ?? [])
      .filter((entry) => entry.method !== 'GET' || /^(xhr|fetch)$/i.test(entry.type))
      .map((entry) => `${entry.method} ${shortUrl(entry.url)}${entry.status === null ? '' : ` ${entry.status}`}`)
  const deadline = Date.now() + waitMs
  let seen = pick()
  while (seen.length === 0 && Date.now() < deadline) {
    await sleep(150)
    seen = pick()
  }
  return seen.slice(0, 4)
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`.slice(0, 100)
  } catch {
    return url.slice(0, 100)
  }
}

function kb(size: number): string {
  return size < 1024 ? `${size} bytes` : `${Math.max(1, Math.round(size / 1024))} KB`
}

/** The tool's answer. */
export function formatUpload(outcome: UploadOutcome): string {
  if (!outcome.ok) return `ERROR: ${outcome.reason}`
  const names = outcome.files.map((file) => `${file.name} (${kb(file.size)})`).join(', ')
  const via =
    outcome.route === 'input'
      ? `set in ${outcome.how}, for ${outcome.target}`
      : outcome.route === 'chooser'
        ? `answered the file chooser ${outcome.target} opened`
        : `dropped onto ${outcome.target}`
  const events =
    outcome.route === 'drop' ? 'The page took the drop.' : outcome.changeFired ? 'The field holds it and the page saw the change.' : outcome.dispatched ? 'The field holds it; the change event did not fire on its own, so it was sent.' : 'The field holds it.'
  const net = outcome.requests.length > 0 ? ` The page then sent: ${outcome.requests.join('; ')}.` : ' The page sent no request yet; it may upload when the form is submitted.'
  return `Uploaded ${names} by the ${outcome.route} route: ${via}. ${events}${net}`
}
