/**
 * What a tab's developer tools remember: its network requests and its console, each in a bounded ring
 * so a long session never grows without limit. Fed with raw Chrome DevTools Protocol events
 * (Network.*, Runtime.consoleAPICalled, Runtime.exceptionThrown, Log.entryAdded) by ./devtools.ts.
 *
 * Plain logic with no Electron in it, so the buffers, filters and caps are unit tested on their own.
 * Every formatter caps its output: one tool call must never flood the model's context.
 */

export const NETWORK_CAPACITY = 400
export const CONSOLE_CAPACITY = 400
/** Response bodies of API calls are kept as they finish, up to this many characters each... */
export const EAGER_BODY_CHARS = 64_000
/** ...and this many in total per tab; the oldest kept bodies are dropped first (they can still be fetched lazily). */
export const EAGER_BODY_BUDGET = 4_000_000
const MAX_URL = 300
const MAX_HEADER_VALUE = 1_000
const MAX_HEADERS = 60
const MAX_CONSOLE_TEXT = 1_500
const MAX_STACK = 1_500
const MAX_ARG = 1_000
export const MAX_LIST_LINES = 200

// ---- the ring ---------------------------------------------------------------------------------

/** A fixed-size buffer: pushing past capacity drops the oldest item and returns it. */
export class Ring<T> {
  private readonly items: T[] = []
  readonly capacity: number

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity))
  }

  push(item: T): T | undefined {
    this.items.push(item)
    return this.items.length > this.capacity ? this.items.shift() : undefined
  }

  all(): T[] {
    return [...this.items]
  }

  last(): T | undefined {
    return this.items[this.items.length - 1]
  }

  get size(): number {
    return this.items.length
  }

  clear(): void {
    this.items.length = 0
  }
}

// ---- small helpers ------------------------------------------------------------------------------

type Obj = Record<string, unknown>

function obj(value: unknown): Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {}
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Text cut to max characters, saying how much was left out. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[cut: ${text.length - max} more characters]`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`
}

export function sizeLabel(bytes: number | null): string {
  if (bytes === null || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function headersOf(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(obj(value))) {
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw)
  }
  return out
}

export function formatHeaders(headers: Record<string, string>): string[] {
  const keys = Object.keys(headers)
  const lines = keys.slice(0, MAX_HEADERS).map((key) => {
    const value = headers[key] ?? ''
    // Repeated headers (Set-Cookie) arrive joined by newlines: one line each.
    return value
      .split('\n')
      .map((part) => `  ${key}: ${part.length > MAX_HEADER_VALUE ? `${part.slice(0, MAX_HEADER_VALUE)}...` : part}`)
      .join('\n')
  })
  if (keys.length > MAX_HEADERS) lines.push(`  [${keys.length - MAX_HEADERS} more headers]`)
  return lines
}

const TEXT_MIME = /^(text\/|application\/(json|[a-z0-9.+-]*\+json|javascript|ecmascript|x-javascript|xml|[a-z0-9.+-]*\+xml|x-www-form-urlencoded|graphql|x-ndjson|ld\+json|manifest\+json)|image\/svg\+xml)/i

export function isTextMime(mime: string): boolean {
  return TEXT_MIME.test(mime.trim())
}

/** A body as the model sees it: text decoded, binary named and sized (with the start in base64). */
export function bodyText(body: string, base64: boolean, mime: string, max: number): { text: string; kind: string; length: number } {
  if (!base64) return { text: cap(body, max), kind: 'text', length: body.length }
  const bytes = Buffer.from(body, 'base64')
  const texty = isTextMime(mime) || (mime === '' && looksLikeText(bytes))
  if (texty) {
    const decoded = bytes.toString('utf8')
    return { text: cap(decoded, max), kind: 'text', length: decoded.length }
  }
  const head = bytes.subarray(0, Math.min(bytes.length, Math.max(0, Math.floor(max / 4)), 2_048)).toString('base64')
  return {
    text: `[binary ${mime || 'data'}, ${sizeLabel(bytes.length)}; the first ${Math.min(bytes.length, 2_048)} bytes in base64:]\n${head}`,
    kind: 'binary',
    length: bytes.length,
  }
}

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 512)
  for (const byte of sample) if (byte === 0) return false
  return true
}

// ---- network ------------------------------------------------------------------------------------

export interface NetTiming {
  /** Network.requestWillBeSent timestamp, seconds on the browser's monotonic clock. */
  start: number | null
  end: number | null
  /** Response.timing, milliseconds relative to its requestTime. */
  dnsMs: number | null
  connectMs: number | null
  sslMs: number | null
  waitMs: number | null
  downloadMs: number | null
  /** When the response headers were in, seconds on the same clock as start, for the download time. */
  headersAt: number | null
}

export interface NetEntry {
  /** Short id the model passes back: r1, r2... */
  id: string
  requestId: string
  url: string
  method: string
  /** The protocol's resource type: Document, Script, XHR, Fetch, Image, Stylesheet, Font, Media, WebSocket, Ping, Other... */
  type: string
  /** When it started, epoch milliseconds. */
  wallTime: number
  requestHeaders: Record<string, string>
  /** True once the raw headers (with cookies) replaced the basic ones. */
  rawRequestHeaders: boolean
  postData: string | null
  hasPostData: boolean
  status: number | null
  statusText: string
  mimeType: string
  responseHeaders: Record<string, string>
  rawResponseHeaders: boolean
  remoteAddress: string
  fromCache: boolean
  fromServiceWorker: boolean
  encodedBytes: number | null
  finished: boolean
  failed: string
  /** A redirect hop: this entry ended in a redirect and the request carried on as the next one. */
  redirectedTo: string
  initiator: string
  timing: NetTiming
  /** A body kept as it finished (API calls), or fetched on request. */
  body: { text: string; base64: boolean } | null
}

export interface NetFilter {
  /** Substring of the URL, case-insensitive. */
  url?: string
  method?: string
  /** Resource type, case-insensitive: xhr, fetch, document, script... */
  type?: string
  /** 200, '2xx', '4xx', 'error' (400 and up or failed), 'failed' (no response). */
  status?: string
  /** Only the page's own API calls (XHR and fetch). */
  api?: boolean
}

const API_TYPES = new Set(['xhr', 'fetch'])

export function isApiType(type: string): boolean {
  return API_TYPES.has(type.toLowerCase())
}

/** The network log of one tab, fed with Network.* events. */
export class NetworkLog {
  private readonly ring: Ring<NetEntry>
  private readonly live = new Map<string, NetEntry>()
  /** ExtraInfo events can arrive before their request; held here briefly. */
  private readonly early = new Map<string, { request?: Obj; response?: Obj }>()
  private seq = 0
  private bodyChars = 0

  constructor(capacity = NETWORK_CAPACITY) {
    this.ring = new Ring<NetEntry>(capacity)
  }

  /** Feeds one CDP event. Returns the entry it finished, if any (so the caller may keep its body). */
  handle(method: string, raw: unknown): NetEntry | null {
    const params = obj(raw)
    const requestId = str(params['requestId'])
    if (requestId === '') return null
    switch (method) {
      case 'Network.requestWillBeSent':
        this.onRequest(requestId, params)
        return null
      case 'Network.requestWillBeSentExtraInfo': {
        const entry = this.live.get(requestId)
        if (entry === undefined) this.hold(requestId, 'request', params)
        else applyRequestExtra(entry, params)
        return null
      }
      case 'Network.responseReceived': {
        const entry = this.live.get(requestId)
        if (entry !== undefined) applyResponse(entry, obj(params['response']), str(params['type']))
        return null
      }
      case 'Network.responseReceivedExtraInfo': {
        const entry = this.live.get(requestId)
        if (entry === undefined) this.hold(requestId, 'response', params)
        else applyResponseExtra(entry, params)
        return null
      }
      case 'Network.requestServedFromCache': {
        const entry = this.live.get(requestId)
        if (entry !== undefined) entry.fromCache = true
        return null
      }
      case 'Network.loadingFinished': {
        const entry = this.live.get(requestId)
        if (entry === undefined) return null
        entry.finished = true
        entry.timing.end = num(params['timestamp'])
        const bytes = num(params['encodedDataLength'])
        if (bytes !== null) entry.encodedBytes = bytes
        finishTiming(entry)
        this.live.delete(requestId)
        this.early.delete(requestId)
        return entry
      }
      case 'Network.loadingFailed': {
        const entry = this.live.get(requestId)
        if (entry === undefined) return null
        entry.finished = true
        entry.timing.end = num(params['timestamp'])
        entry.failed = params['canceled'] === true ? 'canceled' : str(params['errorText']) || 'failed'
        const blocked = str(params['blockedReason'])
        if (blocked !== '') entry.failed += ` (blocked: ${blocked})`
        const cors = str(obj(params['corsErrorStatus'])['corsError'])
        if (cors !== '') entry.failed += ` (CORS: ${cors})`
        finishTiming(entry)
        this.live.delete(requestId)
        this.early.delete(requestId)
        return null
      }
      default:
        return null
    }
  }

  private onRequest(requestId: string, params: Obj): void {
    const previous = this.live.get(requestId)
    const request = obj(params['request'])
    if (previous !== undefined) {
      // The same request id again is a redirect: the old hop ends with the redirect response.
      const redirect = obj(params['redirectResponse'])
      if (Object.keys(redirect).length > 0) applyResponse(previous, redirect, previous.type)
      previous.finished = true
      previous.redirectedTo = str(request['url'])
      previous.timing.end = num(params['timestamp'])
      finishTiming(previous)
    }
    const initiator = obj(params['initiator'])
    const entry: NetEntry = {
      id: `r${++this.seq}`,
      requestId,
      url: str(request['url']) + str(request['urlFragment']),
      method: str(request['method']) || 'GET',
      type: str(params['type']) || 'Other',
      wallTime: Math.round((num(params['wallTime']) ?? Date.now() / 1000) * 1000),
      requestHeaders: headersOf(request['headers']),
      rawRequestHeaders: false,
      postData: typeof request['postData'] === 'string' ? request['postData'] : null,
      hasPostData: request['hasPostData'] === true || typeof request['postData'] === 'string',
      status: null,
      statusText: '',
      mimeType: '',
      responseHeaders: {},
      rawResponseHeaders: false,
      remoteAddress: '',
      fromCache: false,
      fromServiceWorker: false,
      encodedBytes: null,
      finished: false,
      failed: '',
      redirectedTo: '',
      initiator: initiatorLabel(initiator),
      timing: { start: num(params['timestamp']), end: null, dnsMs: null, connectMs: null, sslMs: null, waitMs: null, downloadMs: null, headersAt: null },
      body: null,
    }
    this.live.set(requestId, entry)
    const held = this.early.get(requestId)
    if (held !== undefined) {
      if (held.request !== undefined) applyRequestExtra(entry, held.request)
      if (held.response !== undefined) applyResponseExtra(entry, held.response)
      this.early.delete(requestId)
    }
    const dropped = this.ring.push(entry)
    if (dropped !== undefined) {
      this.live.delete(dropped.requestId)
      if (dropped.body !== null) this.bodyChars -= dropped.body.text.length
    }
  }

  private hold(requestId: string, which: 'request' | 'response', params: Obj): void {
    if (this.early.size > 200) this.early.clear()
    const held = this.early.get(requestId) ?? {}
    held[which] = params
    this.early.set(requestId, held)
  }

  /** Keeps a body for later, within the per-tab budget (oldest kept bodies make room). */
  keepBody(entry: NetEntry, text: string, base64: boolean): void {
    const kept = text.length > EAGER_BODY_CHARS ? text.slice(0, EAGER_BODY_CHARS) : text
    if (entry.body !== null) this.bodyChars -= entry.body.text.length
    entry.body = { text: kept, base64: base64 && kept.length === text.length }
    if (base64 && kept.length !== text.length) entry.body = null
    if (entry.body === null) return
    this.bodyChars += kept.length
    if (this.bodyChars <= EAGER_BODY_BUDGET) return
    for (const old of this.ring.all()) {
      if (this.bodyChars <= EAGER_BODY_BUDGET) break
      if (old === entry || old.body === null) continue
      this.bodyChars -= old.body.text.length
      old.body = null
    }
  }

  get keptBodyChars(): number {
    return this.bodyChars
  }

  get(id: string): NetEntry | null {
    const wanted = id.trim().toLowerCase()
    return this.ring.all().find((entry) => entry.id === wanted || entry.requestId === id.trim()) ?? null
  }

  all(): NetEntry[] {
    return this.ring.all()
  }

  clear(): void {
    this.ring.clear()
    this.live.clear()
    this.early.clear()
    this.bodyChars = 0
  }
}

function initiatorLabel(initiator: Obj): string {
  const type = str(initiator['type'])
  const url = str(initiator['url'])
  const frames = Array.isArray(obj(initiator['stack'])['callFrames']) ? (obj(initiator['stack'])['callFrames'] as unknown[]) : []
  const top = obj(frames[0])
  const where = str(top['url'])
  if (where !== '') return `${type} ${where}:${(num(top['lineNumber']) ?? 0) + 1}`
  return url === '' ? type : `${type} ${url}`
}

function applyRequestExtra(entry: NetEntry, params: Obj): void {
  const headers = headersOf(params['headers'])
  if (Object.keys(headers).length === 0) return
  entry.requestHeaders = headers
  entry.rawRequestHeaders = true
}

function applyResponseExtra(entry: NetEntry, params: Obj): void {
  const headers = headersOf(params['headers'])
  if (Object.keys(headers).length > 0) {
    entry.responseHeaders = headers
    entry.rawResponseHeaders = true
  }
  const status = num(params['statusCode'])
  if (status !== null && entry.status === null) entry.status = status
}

function applyResponse(entry: NetEntry, response: Obj, type: string): void {
  const status = num(response['status'])
  if (status !== null) entry.status = status
  entry.statusText = str(response['statusText'])
  entry.mimeType = str(response['mimeType'])
  // The raw (ExtraInfo) headers are more complete; keep them when they came first.
  if (!entry.rawResponseHeaders) entry.responseHeaders = headersOf(response['headers'])
  if (!entry.rawRequestHeaders) {
    const sent = headersOf(response['requestHeaders'])
    if (Object.keys(sent).length > 0) entry.requestHeaders = sent
  }
  const ip = str(response['remoteIPAddress'])
  const port = num(response['remotePort'])
  if (ip !== '') entry.remoteAddress = port === null ? ip : `${ip}:${port}`
  if (response['fromDiskCache'] === true || response['fromPrefetchCache'] === true) entry.fromCache = true
  if (response['fromServiceWorker'] === true) entry.fromServiceWorker = true
  if (type !== '') entry.type = type
  const timing = obj(response['timing'])
  const at = (key: string): number | null => {
    const value = num(timing[key])
    return value === null || value < 0 ? null : value
  }
  const span = (from: string, to: string): number | null => {
    const a = at(from)
    const b = at(to)
    return a === null || b === null ? null : Math.max(0, Math.round(b - a))
  }
  entry.timing.dnsMs = span('dnsStart', 'dnsEnd')
  entry.timing.connectMs = span('connectStart', 'connectEnd')
  entry.timing.sslMs = span('sslStart', 'sslEnd')
  entry.timing.waitMs = span('sendEnd', 'receiveHeadersEnd')
  const requestTime = num(timing['requestTime'])
  const headersEnd = at('receiveHeadersEnd')
  if (requestTime !== null && headersEnd !== null) {
    entry.timing.headersAt = requestTime + headersEnd / 1000
  }
}

function finishTiming(entry: NetEntry): void {
  const headersAt = entry.timing.headersAt
  if (headersAt !== null && entry.timing.end !== null) entry.timing.downloadMs = Math.max(0, Math.round((entry.timing.end - headersAt) * 1000))
}

export function durationMs(entry: NetEntry): number | null {
  const { start, end } = entry.timing
  return start === null || end === null ? null : Math.max(0, Math.round((end - start) * 1000))
}

/** Parses the model's status filter. Null when it is not one. */
export function statusMatcher(raw: string): ((entry: NetEntry) => boolean) | null {
  const value = raw.trim().toLowerCase()
  if (value === '') return () => true
  if (value === 'failed') return (entry) => entry.failed !== ''
  if (value === 'error' || value === 'errors') return (entry) => entry.failed !== '' || (entry.status ?? 0) >= 400
  if (value === 'pending') return (entry) => !entry.finished
  const range = /^([1-5])xx$/.exec(value)
  if (range !== null) {
    const hundred = Number(range[1]) * 100
    return (entry) => entry.status !== null && entry.status >= hundred && entry.status < hundred + 100
  }
  if (/^\d{3}$/.test(value)) {
    const exact = Number(value)
    return (entry) => entry.status === exact
  }
  return null
}

export function filterNetwork(entries: NetEntry[], filter: NetFilter): NetEntry[] {
  const url = (filter.url ?? '').trim().toLowerCase()
  const method = (filter.method ?? '').trim().toUpperCase()
  const type = (filter.type ?? '').trim().toLowerCase()
  const status = statusMatcher(filter.status ?? '') ?? (() => true)
  return entries.filter((entry) => {
    if (url !== '' && !entry.url.toLowerCase().includes(url)) return false
    if (method !== '' && entry.method.toUpperCase() !== method) return false
    if (type !== '' && entry.type.toLowerCase() !== type) return false
    if (filter.api === true && !isApiType(entry.type)) return false
    return status(entry)
  })
}

function statusLabel(entry: NetEntry): string {
  if (entry.failed !== '') return `FAILED ${entry.failed}`
  if (entry.status !== null) return String(entry.status)
  return entry.finished ? '?' : 'pending'
}

function shortUrl(url: string): string {
  return url.length <= MAX_URL ? url : `${url.slice(0, MAX_URL)}...`
}

/** One line per request, newest last. */
export function formatNetworkList(entries: NetEntry[], options: { limit: number; total: number }): string {
  if (entries.length === 0) {
    return options.total === 0
      ? 'No requests recorded in this tab yet. Load or use the page, then look again.'
      : `None of the ${options.total} recorded requests match. Loosen the filter.`
  }
  const limit = Math.max(1, Math.min(MAX_LIST_LINES, Math.floor(options.limit)))
  const shown = entries.slice(-limit)
  const lines = shown.map((entry) => {
    const took = durationMs(entry)
    const parts = [
      entry.id,
      entry.method,
      statusLabel(entry),
      entry.type.toLowerCase(),
      entry.mimeType === '' ? '' : entry.mimeType,
      entry.fromCache ? '(cache)' : sizeLabel(entry.encodedBytes),
      took === null ? '' : `${took} ms`,
      shortUrl(entry.url),
    ].filter((part) => part !== '')
    return parts.join(' ')
  })
  const head =
    entries.length > shown.length
      ? `${entries.length} match (of ${options.total} recorded); the newest ${shown.length}, oldest first:`
      : `${entries.length} request${entries.length === 1 ? '' : 's'} (of ${options.total} recorded), oldest first:`
  return [head, ...lines, '', 'browser_network_get with an id shows its headers, body and response.'].join('\n')
}

/** Everything about one request; the response body is passed in (it may have been fetched just now). */
export function formatNetworkEntry(
  entry: NetEntry,
  extra: { requestBody: string | null; responseBody: { text: string; kind: string; length: number } | null; bodyNote: string; maxBody: number },
): string {
  const lines: string[] = []
  lines.push(`${entry.id} ${entry.method} ${shortUrl(entry.url)}`)
  const took = durationMs(entry)
  lines.push(
    [
      `Type: ${entry.type}`,
      `Status: ${statusLabel(entry)}${entry.statusText === '' ? '' : ` ${entry.statusText}`}`,
      entry.mimeType === '' ? '' : `MIME: ${entry.mimeType}`,
      `Size: ${sizeLabel(entry.encodedBytes)}`,
      entry.fromCache ? 'from cache' : '',
      entry.fromServiceWorker ? 'from service worker' : '',
    ]
      .filter((part) => part !== '')
      .join('   '),
  )
  const t = entry.timing
  const timing = [
    took === null ? '' : `total ${took} ms`,
    t.dnsMs === null ? '' : `dns ${t.dnsMs} ms`,
    t.connectMs === null ? '' : `connect ${t.connectMs} ms`,
    t.sslMs === null ? '' : `tls ${t.sslMs} ms`,
    t.waitMs === null ? '' : `waiting ${t.waitMs} ms`,
    t.downloadMs === null ? '' : `download ${t.downloadMs} ms`,
  ].filter((part) => part !== '')
  lines.push(`Started: ${new Date(entry.wallTime).toISOString()}${timing.length === 0 ? '' : `   Timing: ${timing.join(', ')}`}`)
  if (entry.remoteAddress !== '') lines.push(`Server: ${entry.remoteAddress}`)
  if (entry.initiator !== '') lines.push(`Initiator: ${oneLine(entry.initiator, 300)}`)
  if (entry.redirectedTo !== '') lines.push(`Redirected to: ${shortUrl(entry.redirectedTo)}`)
  lines.push('', `Request headers${entry.rawRequestHeaders ? '' : ' (as the page set them; cookies are added by the browser)'}:`)
  lines.push(...(Object.keys(entry.requestHeaders).length === 0 ? ['  (none)'] : formatHeaders(entry.requestHeaders)))
  if (extra.requestBody !== null) {
    lines.push('', `Request body (${extra.requestBody.length} characters):`, cap(extra.requestBody, Math.min(extra.maxBody, 8_000)))
  } else if (entry.hasPostData) {
    lines.push('', 'Request body: there was one, but it is no longer available.')
  }
  if (entry.status !== null) {
    lines.push('', 'Response headers:')
    lines.push(...(Object.keys(entry.responseHeaders).length === 0 ? ['  (none)'] : formatHeaders(entry.responseHeaders)))
  }
  if (extra.responseBody !== null) {
    lines.push('', `Response body (${extra.responseBody.kind}, ${extra.responseBody.length} characters):`, extra.responseBody.text)
  } else if (extra.bodyNote !== '') {
    lines.push('', `Response body: ${extra.bodyNote}`)
  }
  return lines.join('\n')
}

// ---- console ------------------------------------------------------------------------------------

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'log' | 'debug'
export const CONSOLE_LEVELS: ConsoleLevel[] = ['error', 'warning', 'info', 'log', 'debug']

export interface ConsoleEntry {
  seq: number
  level: ConsoleLevel
  /** console: console.log and friends; exception: an uncaught error or rejection; browser: Chromium's own messages. */
  source: 'console' | 'exception' | 'browser'
  text: string
  /** Where it came from: url:line:column. */
  where: string
  stack: string
  time: number
  /** The same message again right after: counted, not repeated. */
  count: number
}

/** Formats one Runtime.RemoteObject the way the DevTools console would print it, briefly. */
export function remoteText(raw: unknown): string {
  const o = obj(raw)
  const type = str(o['type'])
  const subtype = str(o['subtype'])
  if (o['unserializableValue'] !== undefined) return String(o['unserializableValue'])
  if (type === 'string') return str(o['value'])
  if (type === 'number' || type === 'boolean') return String(o['value'])
  if (type === 'undefined') return 'undefined'
  if (type === 'symbol' || type === 'bigint') return str(o['description'])
  if (type === 'function') return oneLine(str(o['description']), 120)
  if (subtype === 'null') return 'null'
  if (subtype === 'error') return str(o['description'])
  if (subtype === 'node') return str(o['description'])
  const preview = obj(o['preview'])
  if (Object.keys(preview).length > 0) return previewText(preview, str(o['description']))
  if (o['value'] !== undefined) {
    try {
      return JSON.stringify(o['value'])
    } catch {
      return str(o['description'])
    }
  }
  return str(o['description']) || type
}

function previewText(preview: Obj, description: string): string {
  const subtype = str(preview['subtype'])
  const props = Array.isArray(preview['properties']) ? (preview['properties'] as unknown[]).map(obj) : []
  const more = preview['overflow'] === true ? ', ...' : ''
  const value = (p: Obj): string => {
    const t = str(p['type'])
    if (t === 'string') return JSON.stringify(str(p['value']))
    if (t === 'object' && str(p['subtype']) !== 'null') return str(p['value']) || 'Object'
    return str(p['value']) || t
  }
  if (subtype === 'array' || subtype === 'typedarray') {
    return `${description === '' ? '' : `${description} `}[${props.map(value).join(', ')}${more}]`
  }
  if (subtype === 'map' || subtype === 'set') {
    const entries = Array.isArray(preview['entries']) ? (preview['entries'] as unknown[]).map(obj) : []
    const shown = entries.map((e) => {
      const key = obj(e['key'])
      const val = previewText(obj(e['value']), str(obj(e['value'])['description']))
      return Object.keys(key).length > 0 ? `${previewText(key, str(key['description']))} => ${val}` : val
    })
    return `${description} {${shown.join(', ')}${more}}`
  }
  if (props.length === 0 && str(preview['type']) !== 'object') return str(preview['description']) || description
  const head = description === '' || description === 'Object' ? '' : `${description} `
  return `${head}{${props.map((p) => `${str(p['name'])}: ${value(p)}`).join(', ')}${more}}`
}

/** console.log('%s is %d', a, b) and friends; %c styles are dropped. */
export function consoleArgsText(args: unknown[]): string {
  const list = args.map(obj)
  const first = list[0]
  const out: string[] = []
  let rest = list
  if (first !== undefined && str(first['type']) === 'string' && /%[sdifoOjc]/.test(str(first['value']))) {
    let index = 1
    const head = str(first['value']).replace(/%([sdifoOjc%])/g, (match, code: string) => {
      if (code === '%') return '%'
      const arg = list[index]
      if (arg === undefined) return match
      index++
      if (code === 'c') return ''
      const text = remoteText(arg)
      if (code === 'd' || code === 'i') return String(Math.trunc(Number(arg['value'] ?? text)))
      if (code === 'f') return String(Number(arg['value'] ?? text))
      return text
    })
    out.push(head)
    rest = list.slice(index)
  } else if (first !== undefined) {
    out.push(cap(remoteText(first), MAX_ARG))
    rest = list.slice(1)
  }
  for (const arg of rest) out.push(cap(remoteText(arg), MAX_ARG))
  return out.join(' ')
}

export function stackText(raw: unknown): string {
  const frames = Array.isArray(obj(raw)['callFrames']) ? (obj(raw)['callFrames'] as unknown[]).map(obj) : []
  return frames
    .slice(0, 12)
    .map((frame) => {
      const name = str(frame['functionName']) || '(anonymous)'
      return `    at ${name} (${str(frame['url']) || '<inline>'}:${(num(frame['lineNumber']) ?? 0) + 1}:${(num(frame['columnNumber']) ?? 0) + 1})`
    })
    .join('\n')
}

function topFrame(raw: unknown): string {
  const frames = Array.isArray(obj(raw)['callFrames']) ? (obj(raw)['callFrames'] as unknown[]).map(obj) : []
  const top = frames[0]
  if (top === undefined || str(top['url']) === '') return ''
  return `${str(top['url'])}:${(num(top['lineNumber']) ?? 0) + 1}:${(num(top['columnNumber']) ?? 0) + 1}`
}

const CONSOLE_TYPE_LEVEL: Record<string, ConsoleLevel> = {
  error: 'error',
  assert: 'error',
  warning: 'warning',
  warn: 'warning',
  info: 'info',
  debug: 'debug',
  verbose: 'debug',
}

/** The console of one tab, fed with Runtime and Log events. */
export class ConsoleLog {
  private readonly ring: Ring<ConsoleEntry>
  private seq = 0

  constructor(capacity = CONSOLE_CAPACITY) {
    this.ring = new Ring<ConsoleEntry>(capacity)
  }

  handle(method: string, raw: unknown): void {
    const params = obj(raw)
    if (method === 'Runtime.consoleAPICalled') {
      const type = str(params['type'])
      // Grouping and timers carry no message of their own.
      if (type === 'endGroup' || type === 'profile' || type === 'profileEnd') return
      const args = Array.isArray(params['args']) ? (params['args'] as unknown[]) : []
      let text = consoleArgsText(args)
      if (type === 'assert') text = `Assertion failed: ${text}`
      if (type === 'clear') text = 'console.clear() was called'
      const stack = type === 'trace' || type === 'error' || type === 'assert' ? stackText(params['stackTrace']) : ''
      this.add({
        level: CONSOLE_TYPE_LEVEL[type] ?? 'log',
        source: 'console',
        text,
        where: topFrame(params['stackTrace']),
        stack,
        time: num(params['timestamp']) ?? Date.now(),
      })
      return
    }
    if (method === 'Runtime.exceptionThrown') {
      const details = obj(params['exceptionDetails'])
      const exception = obj(details['exception'])
      const description = Object.keys(exception).length > 0 ? remoteText(exception) : ''
      const head = str(details['text']) || 'Uncaught'
      // An Error's description already carries its stack; a thrown string or object does not.
      const text = description === '' ? head : description.startsWith(head) ? description : `${head} ${description}`
      const url = str(details['url'])
      const where = url === '' ? topFrame(details['stackTrace']) : `${url}:${(num(details['lineNumber']) ?? 0) + 1}:${(num(details['columnNumber']) ?? 0) + 1}`
      const ownStack = /\n\s+at /.test(text)
      this.add({
        level: 'error',
        source: 'exception',
        text,
        where,
        stack: ownStack ? '' : stackText(details['stackTrace']),
        time: num(params['timestamp']) ?? Date.now(),
      })
      return
    }
    if (method === 'Log.entryAdded') {
      const entry = obj(params['entry'])
      const url = str(entry['url'])
      const line = num(entry['lineNumber'])
      const source = str(entry['source'])
      this.add({
        level: CONSOLE_TYPE_LEVEL[str(entry['level'])] ?? 'info',
        source: 'browser',
        text: source === '' || source === 'other' ? str(entry['text']) : `[${source}] ${str(entry['text'])}`,
        where: url === '' ? '' : line === null ? url : `${url}:${line + 1}`,
        stack: stackText(entry['stackTrace']),
        time: num(entry['timestamp']) ?? Date.now(),
      })
    }
  }

  private add(next: Omit<ConsoleEntry, 'seq' | 'count'>): void {
    // Electron's own warnings (its sandbox bundle) are not the site's.
    if (next.where.startsWith('node:electron/')) return
    const text = cap(next.text, MAX_CONSOLE_TEXT)
    const stack = cap(next.stack, MAX_STACK)
    const last = this.ring.last()
    if (last !== undefined && last.level === next.level && last.text === text && last.where === next.where && last.source === next.source) {
      last.count++
      last.time = next.time
      return
    }
    this.ring.push({ ...next, text, stack, seq: ++this.seq, count: 1 })
  }

  all(): ConsoleEntry[] {
    return this.ring.all()
  }

  clear(): void {
    this.ring.clear()
  }
}

export interface ConsoleFilter {
  /** 'error' shows errors and uncaught exceptions; 'warning' shows warnings and worse, and so on. */
  level?: string
  text?: string
}

const LEVEL_RANK: Record<ConsoleLevel, number> = { error: 4, warning: 3, info: 2, log: 1, debug: 0 }

export function filterConsole(entries: ConsoleEntry[], filter: ConsoleFilter): ConsoleEntry[] | null {
  const level = (filter.level ?? '').trim().toLowerCase()
  const wanted = level === '' || level === 'all' ? null : level === 'errors' ? 'error' : level === 'warn' || level === 'warnings' ? 'warning' : level
  if (wanted !== null && !(CONSOLE_LEVELS as string[]).includes(wanted)) return null
  const floor = wanted === null ? -1 : LEVEL_RANK[wanted as ConsoleLevel]
  const text = (filter.text ?? '').trim().toLowerCase()
  return entries.filter((entry) => {
    if (LEVEL_RANK[entry.level] < floor) return false
    if (text !== '' && !entry.text.toLowerCase().includes(text) && !entry.where.toLowerCase().includes(text)) return false
    return true
  })
}

export function formatConsole(entries: ConsoleEntry[], options: { limit: number; total: number; maxChars?: number }): string {
  if (entries.length === 0) {
    return options.total === 0 ? 'The console of this tab is empty.' : `None of the ${options.total} console messages match.`
  }
  const limit = Math.max(1, Math.min(MAX_LIST_LINES, Math.floor(options.limit)))
  const shown = entries.slice(-limit)
  const blocks = shown.map((entry) => {
    const time = new Date(entry.time).toISOString().slice(11, 19)
    const label = entry.source === 'exception' ? 'uncaught' : entry.level
    const repeat = entry.count > 1 ? ` (x${entry.count})` : ''
    const lines = [`[${label}] ${time}${repeat} ${entry.text}`]
    // An error's own stack usually starts at the same place; say it once.
    if (entry.where !== '' && !entry.text.includes(entry.where)) lines.push(`    at ${entry.where}`)
    if (entry.stack !== '') lines.push(entry.stack)
    return lines.join('\n')
  })
  const head =
    entries.length > shown.length
      ? `${entries.length} messages match (of ${options.total}); the newest ${shown.length}, oldest first:`
      : `${entries.length} message${entries.length === 1 ? '' : 's'} (of ${options.total}), oldest first:`
  return cap([head, ...blocks].join('\n'), options.maxChars ?? 16_000)
}
