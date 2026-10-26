/**
 * A finished guided session becomes a learned app (26 Oct 2026): the requests his clicks sent are replayed as one tool,
 * so next time the task runs by API in one call, with no clicks.
 *
 * Nothing secret is saved. Authorization, Cookie, CSRF and any token-like header, query field or body field is left
 * out of the saved code and read FRESH at run time from the signed-in page (a meta tag, a readable cookie, a hidden
 * field, the page's storage); cookies themselves go with the request (credentials: 'include'). Every secret value
 * seen in the capture is checked against the saved code, and the app is refused if one slipped in.
 *
 * What he typed becomes the tool's inputs (a value he typed that the requests carry is replaced by an argument); a
 * password he typed is never read. When the site refuses the replay as a bot (401, 403, 429, a captcha page), the tool
 * fails with the guided steps to fall back to, so the agent calls browser_guide instead.
 *
 * Pure: tests run it on captured rows.
 */
import { SECRET_HEADER, type CapturedRequest, type GuideSession } from './guide-log'
import type { GuideStep, StepLog } from './guide'

export interface LearnedToolDraft {
  name: string
  description: string
  params: Record<string, { type: 'string'; description: string }>
  required: string[]
  js: string
  readOnly: boolean
}

export interface AppDraft {
  startUrl: string
  tool: LearnedToolDraft
  /** Names (never values) of what is read fresh at run time. */
  fresh: string[]
  /** How many requests the tool replays. */
  requests: number
  /** The click path to fall back to. */
  fallback: GuideStep[]
  problem: string | null
}

/** A field name that holds a secret, in a body or a query. */
const SECRET_FIELD = /(csrf|xsrf|token|secret|password|passwd|auth|session|signature|api[-_]?key|nonce)/i
const DROP_HEADERS = /^(cookie|host|origin|referer|user-agent|content-length|connection|accept-encoding|accept-language|pragma|cache-control|priority|dnt)$|^sec-|^:/i

type Marker = { $fresh: string } | { $arg: string }

interface PlanRequest {
  method: string
  url: string | Array<string | Marker>
  headers: Record<string, string>
  fresh: Array<{ header: string; scheme: string }>
  body: unknown
  bodyKind: 'json' | 'form' | 'text' | 'none'
}

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/^(type|enter|fill in|fill|pick|choose|select)\s+(the\s+|your\s+|a\s+)?/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 28)
  return /^[a-z]/.test(s) ? s : `field_${s}`.slice(0, 28)
}

/** The secret values seen in a capture: what the saved code must never contain. */
export function secretValues(requests: CapturedRequest[]): string[] {
  const out = new Set<string>()
  const add = (value: string): void => {
    const v = value.trim()
    if (v.length >= 6) out.add(v)
    const bare = v.replace(/^(bearer|basic|token)\s+/i, '')
    if (bare.length >= 6) out.add(bare)
  }
  for (const request of requests) {
    for (const [key, value] of Object.entries(request.requestHeaders)) {
      if (/^cookie$/i.test(key)) {
        for (const part of value.split(';')) {
          const eq = part.indexOf('=')
          if (eq > 0) add(decodeSafe(part.slice(eq + 1)))
        }
      } else if (SECRET_HEADER.test(key)) add(value)
    }
    for (const [key, value] of fieldsOf(request)) if (SECRET_FIELD.test(key)) add(value)
  }
  return [...out]
}

function decodeSafe(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Every key=value pair of a request's query and body (flat JSON keys included). */
function fieldsOf(request: CapturedRequest): Array<[string, string]> {
  const out: Array<[string, string]> = []
  try {
    for (const [k, v] of new URL(request.url).searchParams) out.push([k, v])
  } catch {
    // Not an absolute address.
  }
  const body = request.postData ?? ''
  if (body === '') return out
  try {
    const walk = (value: unknown, key: string): void => {
      if (Array.isArray(value)) value.forEach((each) => walk(each, key))
      else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, k)
      else if (typeof value === 'string' || typeof value === 'number') out.push([key, String(value)])
    }
    walk(JSON.parse(body), '')
  } catch {
    for (const [k, v] of new URLSearchParams(body)) out.push([k, v])
  }
  return out
}

/** The steps' typed values that can become inputs: label slug -> value. Passwords are never here (never read). */
function inputsOf(logs: StepLog[]): Array<{ param: string; value: string; label: string }> {
  const out: Array<{ param: string; value: string; label: string }> = []
  const used = new Set<string>()
  for (const log of logs) {
    if (log.outcome !== 'typed' || log.secret === true || log.value === undefined || log.value.trim().length < 2) continue
    let param = slug(log.name !== '' ? log.name : log.label) || 'value'
    while (used.has(param)) param = `${param}_2`.slice(0, 30)
    used.add(param)
    out.push({ param, value: log.value, label: log.name !== '' ? log.name : log.label })
  }
  return out
}

/** Replaces typed values in a string with argument markers (longest first). */
function withArgs(text: string, inputs: Array<{ param: string; value: string }>): Array<string | Marker> {
  let parts: Array<string | Marker> = [text]
  for (const input of [...inputs].sort((a, b) => b.value.length - a.value.length)) {
    const variants = [input.value, encodeURIComponent(input.value), encodeURIComponent(input.value).replace(/%20/g, '+')]
    for (const variant of [...new Set(variants)]) {
      parts = parts.flatMap((part) => {
        if (typeof part !== 'string' || variant === '' || !part.includes(variant)) return [part]
        const bits = part.split(variant)
        const joined: Array<string | Marker> = []
        bits.forEach((bit, i) => {
          if (i > 0) joined.push({ $arg: input.param })
          if (bit !== '') joined.push(bit)
        })
        return joined
      })
    }
  }
  return parts
}

function planBody(request: CapturedRequest, inputs: Array<{ param: string; value: string }>): { kind: PlanRequest['bodyKind']; body: unknown } {
  const raw = request.postData
  if (raw === null || raw === '') return { kind: 'none', body: null }
  const ct = Object.entries(request.requestHeaders).find(([k]) => /^content-type$/i.test(k))?.[1] ?? ''
  try {
    const parsed = JSON.parse(raw) as unknown
    const walk = (value: unknown, key: string): unknown => {
      if (Array.isArray(value)) return value.map((each) => walk(each, key))
      if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v, k)]))
      if (key !== '' && SECRET_FIELD.test(key) && (typeof value === 'string' || typeof value === 'number')) return { $fresh: key }
      if (typeof value === 'string') {
        const exact = inputs.find((input) => input.value === value)
        if (exact !== undefined) return { $arg: exact.param }
        const parts = withArgs(value, inputs)
        return parts.length === 1 && typeof parts[0] === 'string' ? value : { $parts: parts }
      }
      return value
    }
    return { kind: 'json', body: walk(parsed, '') }
  } catch {
    if (/x-www-form-urlencoded/i.test(ct) || /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(raw.trim())) {
      const pairs: Array<[string, unknown]> = []
      for (const [k, v] of new URLSearchParams(raw)) {
        if (SECRET_FIELD.test(k)) pairs.push([k, { $fresh: k }])
        else {
          const exact = inputs.find((input) => input.value === v)
          pairs.push([k, exact !== undefined ? { $arg: exact.param } : v])
        }
      }
      return { kind: 'form', body: pairs }
    }
    return { kind: 'text', body: withArgs(raw, inputs) }
  }
}

function planUrl(request: CapturedRequest, inputs: Array<{ param: string; value: string }>): string | Array<string | Marker> {
  let url = request.url
  try {
    const parsed = new URL(request.url)
    const fresh: string[] = []
    for (const key of [...parsed.searchParams.keys()]) if (SECRET_FIELD.test(key)) fresh.push(key)
    for (const key of fresh) parsed.searchParams.set(key, `__FRESH_${key}__`)
    url = parsed.toString()
  } catch {
    // Kept as it is.
  }
  const parts = withArgs(url, inputs).flatMap((part) => {
    if (typeof part !== 'string') return [part]
    const out: Array<string | Marker> = []
    const re = /__FRESH_([A-Za-z0-9_.-]+)__/g
    let last = 0
    for (let m = re.exec(part); m !== null; m = re.exec(part)) {
      if (m.index > last) out.push(part.slice(last, m.index))
      out.push({ $fresh: m[1] ?? '' })
      last = m.index + m[0].length
    }
    if (last < part.length) out.push(part.slice(last))
    return out
  })
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts
}

/** The run-time part of every generated tool: fresh secrets from the signed-in page, the replay, the bot check. */
const RUNTIME = String.raw`
const like = (k, n) => { k = String(k || '').toLowerCase(); n = String(n || '').toLowerCase().replace(/^x-/, ''); const kk = k.replace(/^x-/, ''); if (kk === n) return true; if (/csrf|xsrf/.test(kk) !== /csrf|xsrf/.test(n)) return false; for (const w of ['csrf', 'xsrf']) if (kk.indexOf(w) >= 0 && n.indexOf(w) >= 0) return true; if (n === 'authorization' && /token|auth|jwt|access/.test(kk)) return true; if (/token/.test(n) && /token/.test(kk)) return true; return false; };
const tokenIn = (v) => { if (typeof v !== 'string' || v === '') return null; if (v.charAt(0) === '{') { try { const o = JSON.parse(v); for (const k of ['access_token', 'accessToken', 'token', 'id_token', 'jwt']) if (typeof o[k] === 'string') return o[k]; } catch (e) { return null; } } return v; };
const fresh = (name) => {
  for (const m of Array.from(document.querySelectorAll('meta[name],meta[property]'))) { const k = m.getAttribute('name') || m.getAttribute('property'); if (like(k, name) && m.getAttribute('content')) return m.getAttribute('content'); }
  for (const part of document.cookie.split(';')) { const eq = part.indexOf('='); if (eq < 1) continue; const k = part.slice(0, eq).trim(); if (like(k, name)) return decodeURIComponent(part.slice(eq + 1).trim()); }
  for (const i of Array.from(document.querySelectorAll('input[type=hidden][name]'))) if (like(i.name, name) && i.value) return i.value;
  for (const store of [localStorage, sessionStorage]) { try { for (let i = 0; i < store.length; i++) { const k = store.key(i); if (like(k, name)) { const t = tokenIn(store.getItem(k)); if (t) return t; } } } catch (e) { /* storage blocked */ } }
  if (window.__agentFresh && typeof window.__agentFresh[name] === 'string') return window.__agentFresh[name];
  return null;
};
const need = (name) => { const v = fresh(name); if (v === null || v === '') throw new Error('Could not read a fresh ' + name + ' from the signed-in page (sign in again, or fall back to browser_guide with steps ' + JSON.stringify(plan.fallback) + ').'); return v; };
const val = (v) => { if (v && typeof v === 'object' && !Array.isArray(v)) { if ('$fresh' in v) return need(v.$fresh); if ('$arg' in v) { const a = args[v.$arg]; if (a === undefined || a === null) throw new Error('Missing input: ' + v.$arg); return String(a); } if ('$parts' in v) return v.$parts.map(val).join(''); return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, val(x)])); } if (Array.isArray(v)) return v.map(val); return v; };
const str = (p) => Array.isArray(p) ? p.map((x) => typeof x === 'string' ? x : (x.$arg ? encodeURIComponent(val(x)) : encodeURIComponent(val(x)))).join('') : p;
let last = null;
for (const r of plan.requests) {
  const headers = Object.assign({}, r.headers);
  for (const f of r.fresh) { const v = need(f.header); headers[f.header] = f.scheme && v.toLowerCase().indexOf(f.scheme.toLowerCase() + ' ') !== 0 ? f.scheme + ' ' + v : v; }
  let body;
  if (r.bodyKind === 'json') body = JSON.stringify(val(r.body));
  else if (r.bodyKind === 'form') body = new URLSearchParams(r.body.map(([k, v]) => [k, String(val(v))])).toString();
  else if (r.bodyKind === 'text') body = r.body.map(val).join('');
  const res = await fetch(str(r.url), { method: r.method, headers, body, credentials: 'include' });
  const text = await res.text();
  if (res.status === 401 || res.status === 403 || res.status === 429 || /captcha|are you a robot|automated (requests|traffic)|unusual traffic|bot detected/i.test(text.slice(0, 4000))) {
    throw new Error('The site refused the API call (' + res.status + ' on ' + r.method + ' ' + new URL(str(r.url), location.href).pathname + '), most likely a bot check. Fall back to guided clicks: browser_guide with steps ' + JSON.stringify(plan.fallback));
  }
  if (!res.ok) throw new Error(r.method + ' ' + new URL(str(r.url), location.href).pathname + ' failed: ' + res.status + ' ' + text.slice(0, 300));
  let data = text; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  last = { status: res.status, data };
}
if (last && typeof last.data === 'string') last.data = last.data.slice(0, 2000);
return last;
`

/** Builds the learned tool from a session. problem says why it cannot be saved (nothing captured, a secret slipped in). */
export function appFromSession(session: GuideSession, requests: CapturedRequest[], options: { toolName: string; description: string }): AppDraft {
  const fallback: GuideStep[] = session.logs
    .filter((log) => ['clicked', 'typed', 'done', 'navigated'].includes(log.outcome))
    .map((log) => {
      const asked = session.steps[log.n - 1]
      const target = log.name !== '' ? { name: log.name, ...(log.role !== '' && log.role !== 'generic' ? { role: log.role } : {}) } : (asked?.target ?? {})
      const { index: _index, ...rest } = target as GuideStep['target']
      return { label: log.label, target: rest }
    })
  let startUrl = session.url
  try {
    startUrl = new URL(session.url).origin + '/'
  } catch {
    // Kept.
  }
  const inputs = inputsOf(session.logs)
  // The task is what his clicks changed: every request that is not a read. A task of only reads replays its last read.
  const writes = requests.filter((request) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method))
  const chosen = writes.length > 0 ? writes : requests.filter((request) => request.method === 'GET').slice(-1)
  const freshNames = new Set<string>()
  const planned: PlanRequest[] = chosen.map((request) => {
    const headers: Record<string, string> = {}
    const fresh: PlanRequest['fresh'] = []
    for (const [key, value] of Object.entries(request.requestHeaders)) {
      if (DROP_HEADERS.test(key)) continue
      if (SECRET_HEADER.test(key)) {
        const scheme = /^(bearer|basic|token)\s/i.exec(value)?.[1] ?? ''
        fresh.push({ header: key, scheme })
        freshNames.add(key)
        continue
      }
      headers[key] = value
    }
    const body = planBody(request, inputs)
    const url = planUrl(request, inputs)
    const note = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(note)
      else if (value !== null && typeof value === 'object') {
        if ('$fresh' in value) freshNames.add(String((value as { $fresh: string }).$fresh))
        else Object.values(value).forEach(note)
      }
    }
    note(body.body)
    note(url)
    return { method: request.method, url, headers, fresh, body: body.body, bodyKind: body.kind }
  })
  const plan = { requests: planned, fallback }
  const js = `const plan = ${JSON.stringify(plan)};\n${RUNTIME.trim()}`
  const params: LearnedToolDraft['params'] = {}
  for (const input of inputs) {
    if (!js.includes(`"$arg":"${input.param}"`)) continue
    params[input.param] = { type: 'string', description: `What goes in "${input.label}" (he typed "${input.value.slice(0, 40)}" when it was learned)` }
  }
  let problem: string | null = null
  if (chosen.length === 0) problem = 'His clicks sent no API request that could be replayed (nothing was captured for this session). The task stays a guided one.'
  const leaked = secretValues(requests).filter((value) => js.includes(value))
  if (leaked.length > 0) problem = `A captured secret would have been saved in the code (${leaked.length} value${leaked.length === 1 ? '' : 's'}), so nothing was saved.`
  const changes = writes.length > 0
  return {
    startUrl,
    tool: {
      name: options.toolName,
      description: options.description,
      params,
      required: Object.keys(params),
      js,
      readOnly: !changes,
    },
    fresh: [...freshNames],
    requests: planned.length,
    fallback,
    problem,
  }
}
