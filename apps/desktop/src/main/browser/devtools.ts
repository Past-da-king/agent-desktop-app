/**
 * Developer tools for the agent's own tabs, the way a person uses Ctrl+Shift+I: every tab records its
 * network and console from the moment its debugger is attached (before its first real page loads), and the
 * agent can read a request's full detail and body, run code, inspect elements and read storage.
 *
 * Everything goes through the Chrome DevTools Protocol on the tab's own debugger (webContents.debugger),
 * reached through a small channel so the same code runs against a real Chromium in tests. It never
 * depends on how the tab is shown (a WebContentsView today, maybe a <webview> later): only on its webContents.
 *
 * Measured on Electron 44 (Chromium 152) before choosing to enable Runtime on every tab: the known page
 * tricks that notice a DevTools client (an Error whose stack getter counts reads, logged to the console)
 * did not fire. One getter (an Error's name) is read once more than without it, and plain Electron already
 * reads it once, so a page that counts it sees Electron either way.
 */
import type { WebContents } from 'electron'

import { alive, ifAlive } from '../alive'
import { Cdp } from './cdp'
import { ConsoleLog, EAGER_BODY_CHARS, NetworkLog, bodyText, isApiType, type NetEntry } from './devtools-log'

/** One tab's debugger, as the developer tools need it. */
export interface DevtoolsChannel {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  onEvent(listener: (method: string, params: unknown) => void): void
  onDetach(listener: () => void): void
  /** The address of the page now, or ''. */
  url(): string
}

/** The events the developer tools read, for channels that subscribe by name (Playwright's CDP session in tests). */
export const DEVTOOLS_EVENTS = [
  'Network.requestWillBeSent',
  'Network.requestWillBeSentExtraInfo',
  'Network.responseReceived',
  'Network.responseReceivedExtraInfo',
  'Network.requestServedFromCache',
  'Network.loadingFinished',
  'Network.loadingFailed',
  'Runtime.consoleAPICalled',
  'Runtime.exceptionThrown',
  'Log.entryAdded',
] as const

/** API bodies bigger than this on the wire are not kept as they finish; they are fetched when asked for. */
const EAGER_MAX_BYTES = 1_000_000

type Obj = Record<string, unknown>

function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export type EvalResult = { ok: true; value: unknown } | { ok: false; error: string }

export class TabDevtools {
  readonly network = new NetworkLog()
  readonly console = new ConsoleLog()
  private readonly channel: DevtoolsChannel
  private enabled = false
  private starting: Promise<boolean> | null = null

  constructor(channel: DevtoolsChannel) {
    this.channel = channel
    channel.onEvent((method, params) => this.onEvent(method, params))
    // Detached (the tab crashed, or another client took it): the domains are enabled again on the next use.
    channel.onDetach(() => {
      this.enabled = false
    })
  }

  /** Turns on recording. Safe to call again; it only does the work once per attach. */
  async start(): Promise<boolean> {
    if (this.enabled) return true
    if (this.starting !== null) return this.starting
    this.starting = (async () => {
      try {
        // Big buffers so a response body is still there when the agent asks for it a little later.
        await this.channel.send('Network.enable', { maxTotalBufferSize: 25_000_000, maxResourceBufferSize: 10_000_000 })
        await this.channel.send('Runtime.enable')
        await this.channel.send('Log.enable')
        this.enabled = true
      } catch {
        this.enabled = false
      }
      this.starting = null
      return this.enabled
    })()
    return this.starting
  }

  get recording(): boolean {
    return this.enabled
  }

  url(): string {
    return this.channel.url()
  }

  private onEvent(method: string, params: unknown): void {
    if (method.startsWith('Network.')) {
      const finished = this.network.handle(method, params)
      // An API call's body is kept as it finishes: the page may navigate away before the agent asks.
      if (finished !== null && isApiType(finished.type) && (finished.encodedBytes ?? 0) <= EAGER_MAX_BYTES) void this.keep(finished)
      return
    }
    if (method === 'Runtime.consoleAPICalled' || method === 'Runtime.exceptionThrown' || method === 'Log.entryAdded') {
      this.console.handle(method, params)
    }
  }

  private async keep(entry: NetEntry): Promise<void> {
    try {
      const out = obj(await this.channel.send('Network.getResponseBody', { requestId: entry.requestId }))
      this.network.keepBody(entry, str(out['body']), out['base64Encoded'] === true)
    } catch {
      // No body (a 204, a redirect) or already gone: it is fetched again when asked for.
    }
  }

  /** The response body, kept or fetched now. A note instead when there is none. */
  async responseBody(entry: NetEntry, max: number): Promise<{ body: { text: string; kind: string; length: number } | null; note: string }> {
    if (entry.failed !== '') return { body: null, note: 'none, the request failed.' }
    if (entry.status === null) return { body: null, note: entry.finished ? 'none.' : 'not finished yet.' }
    if (entry.redirectedTo !== '') return { body: null, note: 'none, it is a redirect.' }
    if (!entry.finished) return { body: null, note: 'still loading; ask again in a moment.' }
    let raw = entry.body
    // A kept body may have been cut to its keeping size: fetch the whole one then.
    if (raw === null || raw.text.length >= EAGER_BODY_CHARS) {
      try {
        const out = obj(await this.channel.send('Network.getResponseBody', { requestId: entry.requestId }))
        raw = { text: str(out['body']), base64: out['base64Encoded'] === true }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error)
        return {
          body: null,
          note: `no longer available (${why.slice(0, 120)}). Bodies are dropped when the page navigates or the buffer fills; browser_fetch can request it again.`,
        }
      }
    }
    if (raw.text === '') return { body: null, note: 'empty.' }
    return { body: bodyText(raw.text, raw.base64, entry.mimeType, max), note: '' }
  }

  async requestBody(entry: NetEntry): Promise<string | null> {
    if (entry.postData !== null) return entry.postData
    if (!entry.hasPostData) return null
    try {
      const out = obj(await this.channel.send('Network.getRequestPostData', { requestId: entry.requestId }))
      const data = str(out['postData'])
      entry.postData = data
      return data
    } catch {
      return null
    }
  }

  /**
   * Evaluates an expression in the page's main world: promises are awaited and the result comes back by
   * value (JSON). A thrown error comes back with its stack.
   */
  async evaluate(expression: string): Promise<EvalResult> {
    try {
      const out = obj(
        await this.channel.send('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          allowUnsafeEvalBlockedByCSP: true,
        }),
      )
      const details = obj(out['exceptionDetails'])
      if (Object.keys(details).length > 0) {
        const exception = obj(details['exception'])
        const error = str(exception['description']) || str(exception['value']) || str(details['text']) || 'the script threw'
        return { ok: false, error }
      }
      return { ok: true, value: obj(out['result'])['value'] }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Empties the console here and lets the page drop the objects its old messages held on to. */
  async clearConsole(): Promise<void> {
    this.console.clear()
    await this.channel.send('Runtime.discardConsoleEntries').catch(() => undefined)
  }

  /** Cookies the browser would send to these addresses, httpOnly ones included. */
  async cookies(urls: string[]): Promise<Obj[]> {
    const out = obj(await this.channel.send('Network.getCookies', { urls }))
    return Array.isArray(out['cookies']) ? (out['cookies'] as unknown[]).map(obj) : []
  }
}

// ---- the tabs' developer tools, by webContents --------------------------------------------------

const byTarget = new WeakMap<object, TabDevtools>()

/** The channel for an Electron webContents: its own debugger, kept attached. */
export function electronChannel(wc: WebContents): DevtoolsChannel {
  // The debugger is taken once, while the page is alive: reading wc.debugger later, after the tab closed, throws.
  const dbg = wc.debugger
  const cdp = new Cdp(dbg, 30_000)
  return {
    send: (method, params) => (alive(wc) ? cdp.send(method, params ?? {}) : Promise.reject(new Error('The page has closed.'))),
    onEvent: (listener) => {
      dbg.on('message', (_event, method, params) => ifAlive('devtools event', () => listener(method, params)))
    },
    onDetach: (listener) => {
      dbg.on('detach', () => ifAlive('devtools detach', () => listener()))
    },
    url: () => (alive(wc) ? wc.getURL() : ''),
  }
}

/**
 * Starts recording a tab. Called once its debugger is attached (a document exists: attaching to a view
 * that never loaded one crashes Electron), before its first real page loads.
 */
export function watchDevtools(wc: WebContents): TabDevtools | null {
  if (wc.isDestroyed()) return null
  let tools = byTarget.get(wc)
  if (tools === undefined) {
    tools = new TabDevtools(electronChannel(wc))
    byTarget.set(wc, tools)
  }
  void tools.start()
  return tools
}

/** What the browser offers the developer tools: the agent's current tab's webContents. */
export interface DevtoolsHost {
  devtoolsTarget(): WebContents | null
}

export function isDevtoolsHost(value: unknown): value is DevtoolsHost {
  return typeof value === 'object' && value !== null && typeof (value as Partial<DevtoolsHost>).devtoolsTarget === 'function'
}

/** The developer tools of the agent's current tab, recording; null when it has no page yet. */
export async function devtoolsOf(browser: unknown): Promise<TabDevtools | null> {
  if (!isDevtoolsHost(browser)) return null
  const wc = browser.devtoolsTarget()
  if (wc === null || wc.isDestroyed() || wc.getURL() === '') return null
  const tools = watchDevtools(wc)
  if (tools === null) return null
  await tools.start()
  return tools
}

// ---- scripts run in the page through Runtime.evaluate -------------------------------------------

/** Elements matching a selector: tag, attributes, box, text, outerHTML and chosen computed styles. */
export function inspectScript(selector: string, limit: number, styles: string[], htmlMax: number): string {
  return `(() => {
  const sel = ${JSON.stringify(selector)};
  let nodes;
  try { nodes = Array.from(document.querySelectorAll(sel)); } catch (e) { return { error: 'That is not a valid CSS selector: ' + String(e && e.message || e) }; }
  const props = ${JSON.stringify(styles)};
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + '... [' + (s.length - n) + ' more characters]' : s);
  const items = nodes.slice(0, ${Math.max(1, Math.floor(limit))}).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const attributes = {};
    for (const a of Array.from(el.attributes).slice(0, 40)) attributes[a.name] = cut(a.value, 300);
    const style = {};
    for (const p of props) style[p] = cs.getPropertyValue(p);
    const visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0;
    const text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      tag: el.tagName.toLowerCase(),
      attributes,
      box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height), inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth },
      visible,
      text: cut(text, 300),
      styles: style,
      html: cut(el.outerHTML, ${Math.max(100, Math.floor(htmlMax))}),
    };
  });
  return { count: nodes.length, items };
})()`
}

/** localStorage and sessionStorage of the page's origin. */
export function storageScript(which: { local: boolean; session: boolean }, name: string, valueMax: number): string {
  return `(() => {
  const want = ${JSON.stringify(name.toLowerCase())};
  const read = (get) => {
    let store;
    try { store = get(); } catch (e) { return { error: String(e && e.message || e) }; }
    if (!store) return { error: 'not available' };
    const items = [];
    let bytes = 0;
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i) || '';
      const value = store.getItem(key) || '';
      bytes += key.length + value.length;
      if (want !== '' && !key.toLowerCase().includes(want)) continue;
      items.push({ key, size: value.length, value: value.length > ${valueMax} ? value.slice(0, ${valueMax}) + '... [' + (value.length - ${valueMax}) + ' more characters]' : value });
    }
    return { count: store.length, bytes, items: items.slice(0, 100), more: Math.max(0, items.length - 100) };
  };
  return {
    origin: location.origin,
    local: ${which.local ? 'read(() => window.localStorage)' : 'null'},
    session: ${which.session ? 'read(() => window.sessionStorage)' : 'null'},
  };
})()`
}

export interface FetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  maxChars: number
  timeoutMs: number
}

/** One HTTP request made by the page itself, so its cookies, origin and sign-in apply. */
export function fetchScript(request: FetchRequest): string {
  return `(async () => {
  const req = ${JSON.stringify(request)};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
  const t0 = performance.now();
  try {
    const init = { method: req.method, headers: req.headers, credentials: 'include', redirect: 'follow', signal: ctl.signal };
    if (req.body !== null && req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
    const res = await fetch(req.url, init);
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const type = res.headers.get('content-type') || '';
    const texty = type === '' || /^(text\\/|application\\/(json|[a-z0-9.+-]*\\+json|javascript|xml|[a-z0-9.+-]*\\+xml|x-www-form-urlencoded|graphql|x-ndjson)|image\\/svg)/i.test(type);
    let body = '';
    let size = 0;
    let binary = false;
    if (req.method !== 'HEAD') {
      if (texty) {
        const text = await res.text();
        size = text.length;
        body = text.slice(0, req.maxChars);
      } else {
        const bytes = new Uint8Array(await res.arrayBuffer());
        size = bytes.length;
        binary = true;
        let s = '';
        for (const b of bytes.slice(0, 1536)) s += String.fromCharCode(b);
        body = btoa(s);
      }
    }
    return { ok: true, status: res.status, statusText: res.statusText, url: res.url, redirected: res.redirected, type: res.type, headers, body, size, binary, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    const aborted = e && e.name === 'AbortError';
    return { ok: false, error: aborted ? 'no answer within ' + Math.round(req.timeoutMs / 1000) + ' s' : String(e && e.message || e), ms: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(timer);
  }
})()`
}
