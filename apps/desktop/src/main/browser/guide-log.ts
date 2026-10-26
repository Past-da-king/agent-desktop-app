/**
 * The step log of every guided session (26 Oct 2026): which step he is on, what each step was, and every API request
 * (XHR, fetch, a form post) his action on that step made the page send, read from the tab's own network recording
 * (devtools.ts, the browser_network capture), so watching costs his clicks nothing. Any agent can read it
 * (browser_guide_log), so a second helper can sit beside the guide as the watcher: "he is on step 3" -> "that click
 * called POST /api/... with body ...". guide-app.ts turns a finished session into a learned app.
 *
 * Plain logic, no Electron: tests drive it with NetEntry rows.
 */
import { isApiType, type NetEntry } from './devtools-log'
import type { GuideResult, GuideStep, StepLog } from './guide'

export interface CapturedRequest {
  step: number
  id: string
  method: string
  url: string
  type: string
  status: number | null
  at: number
  requestHeaders: Record<string, string>
  postData: string | null
  responseMime: string
  responseBody: string | null
}

export interface GuideSession {
  id: string
  owner: string
  tabId: string
  url: string
  startedAt: number
  endedAt: number | null
  total: number
  steps: GuideStep[]
  /** The step he is on now (1-based), 0 before the first ring, total+1 once over. */
  current: number
  logs: StepLog[]
  result: GuideResult | null
  /** Requests frozen at the end (the live recording rolls over); until then they are read live. */
  frozen: CapturedRequest[] | null
  /** Sensitive values (clipboard fill): masked wherever a captured request carries them. Never shown. */
  masks: string[]
}

const MAX_SESSIONS = 20
/** Requests his last action set off may come a little after it: they still belong to it. */
export const TAIL_MS = 3_000
const BODY_CHARS = 4_000

/** Headers whose values are secrets: never shown to a model and never saved into a learned app. */
export const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie)$|csrf|xsrf|token|auth|session|secret|api[-_]?key|signature|bearer/i

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key] = SECRET_HEADER.test(key) ? '[secret, read fresh at run time]' : value
  return out
}

/** A request worth recording for a step: the page's own API calls, and anything that is not a plain GET (a form post). */
export function interesting(entry: NetEntry): boolean {
  if (/^(data|blob|chrome-extension|devtools):/i.test(entry.url)) return false
  if (isApiType(entry.type)) return true
  return entry.method.toUpperCase() !== 'GET' && entry.method.toUpperCase() !== 'OPTIONS' && entry.method.toUpperCase() !== 'HEAD'
}

/**
 * Which step each request belongs to: step n owns what started between his action on n and his action on n+1 (a
 * click's requests start right after it); the last step owns what started up to TAIL_MS after the guide ended.
 * Nothing before his first action is his.
 */
export function assignRequests(logs: Array<Pick<StepLog, 'n' | 'at' | 'outcome'>>, entries: NetEntry[], endAt: number | null): CapturedRequest[] {
  const acted = logs.filter((log) => ['clicked', 'typed', 'done', 'navigated', 'skipped'].includes(log.outcome)).sort((a, b) => a.at - b.at)
  if (acted.length === 0) return []
  const out: CapturedRequest[] = []
  for (const entry of entries) {
    if (!interesting(entry) || entry.redirectedTo !== '' && entry.status !== null && entry.status >= 300 && entry.status < 400 && entry.method === 'GET') continue
    const at = entry.wallTime
    let owner: number | null = null
    for (let i = 0; i < acted.length; i++) {
      const start = acted[i]!.at - 50
      const next = acted[i + 1]
      const end = next === undefined ? (endAt === null ? Number.POSITIVE_INFINITY : endAt + TAIL_MS) : next.at - 50
      if (at >= start && at < end) owner = acted[i]!.n
    }
    if (owner === null) continue
    out.push({
      step: owner,
      id: entry.id,
      method: entry.method.toUpperCase(),
      url: entry.url,
      type: entry.type,
      status: entry.status,
      at,
      requestHeaders: { ...entry.requestHeaders },
      postData: entry.postData,
      responseMime: entry.mimeType,
      responseBody: entry.body === null || entry.body.base64 ? null : entry.body.text.slice(0, BODY_CHARS),
    })
  }
  return out
}

/** Every sensitive value replaced by [secret] in what a request carried (address, headers, body, reply), URL-encoded forms too. */
export function maskRequests(requests: CapturedRequest[], masks: string[]): CapturedRequest[] {
  if (masks.length === 0) return requests
  const forms = masks.flatMap((m) => [m, encodeURIComponent(m), encodeURIComponent(m).replace(/%20/g, '+'), JSON.stringify(m).slice(1, -1)]).filter((m, i, all) => m.length >= 3 && all.indexOf(m) === i)
  const mask = (text: string): string => forms.reduce((acc, m) => acc.split(m).join('[secret]'), text)
  return requests.map((r) => ({
    ...r,
    url: mask(r.url),
    requestHeaders: Object.fromEntries(Object.entries(r.requestHeaders).map(([k, v]) => [k, mask(v)])),
    postData: r.postData === null ? null : mask(r.postData),
    responseBody: r.responseBody === null ? null : mask(r.responseBody),
  }))
}

type Waiter = { after: number; resolve: () => void }

export class GuideLog {
  private readonly sessions: GuideSession[] = []
  private readonly sources = new Map<string, () => NetEntry[]>()
  private readonly waiters = new Set<Waiter>()
  private seq = 0

  constructor(private readonly now: () => number = Date.now) {}

  start(input: { owner: string; tabId: string; url: string; steps: GuideStep[]; network?: () => NetEntry[]; masks?: string[] }): GuideSession {
    const session: GuideSession = {
      id: `guide-${++this.seq}`,
      owner: input.owner,
      tabId: input.tabId,
      url: input.url,
      startedAt: this.now(),
      endedAt: null,
      total: input.steps.length,
      // A step's value (clipboard fill) is never kept here: only that it had one.
      steps: input.steps.map(({ value: _value, sensitive: _sensitive, ...rest }) => rest),
      current: 0,
      logs: [],
      result: null,
      frozen: null,
      masks: (input.masks ?? []).filter((m) => m.length >= 3),
    }
    this.sessions.push(session)
    if (input.network !== undefined) this.sources.set(session.id, input.network)
    while (this.sessions.length > MAX_SESSIONS) {
      const old = this.sessions.shift()
      if (old !== undefined) this.sources.delete(old.id)
    }
    this.wake()
    return session
  }

  stepStarted(id: string, n: number): void {
    const session = this.get(id)
    if (session === null) return
    session.current = n
    this.wake()
  }

  stepEnded(id: string, log: StepLog): void {
    const session = this.get(id)
    if (session === null) return
    session.logs = [...session.logs.filter((each) => each.n !== log.n), log].sort((a, b) => a.n - b.n)
    this.wake()
  }

  end(id: string, result: GuideResult): void {
    const session = this.get(id)
    if (session === null) return
    session.result = result
    session.endedAt = this.now()
    session.current = session.total + 1
    this.wake()
  }

  /** The live recording is copied once the tail is over, so the session outlives the tab's rolling buffer. */
  freeze(id: string): void {
    const session = this.get(id)
    if (session === null || session.frozen !== null) return
    session.frozen = this.requests(id)
    // The values themselves are not needed once what the requests carried is masked.
    session.masks = []
    this.sources.delete(id)
  }

  get(id: string): GuideSession | null {
    if (id === 'latest' || id === '') return this.sessions[this.sessions.length - 1] ?? null
    return this.sessions.find((session) => session.id === id) ?? null
  }

  requests(id: string): CapturedRequest[] {
    const session = this.get(id)
    if (session === null) return []
    if (session.frozen !== null) return session.frozen
    const source = this.sources.get(session.id)
    return source === undefined ? [] : maskRequests(assignRequests(session.logs, source(), session.endedAt), session.masks)
  }

  /**
   * Waits until the session has a step beyond `after` (ended), the session ends, or ms pass. With no session yet
   * ('latest' asked before any guide), waits for one to start.
   */
  async waitFor(id: string, after: number, ms: number, signal?: AbortSignal): Promise<void> {
    const ready = (): boolean => {
      const session = this.get(id)
      if (session === null) return false
      return session.logs.some((log) => log.n > after) || session.endedAt !== null
    }
    if (ready() || ms <= 0) return
    await new Promise<void>((resolve) => {
      const waiter: Waiter = {
        after,
        resolve: () => {
          if (!ready()) return
          finish()
        },
      }
      const timer = setTimeout(finish, ms)
      function finish(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        logWaiters.delete(waiter)
        resolve()
      }
      const logWaiters = this.waiters
      logWaiters.add(waiter)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter.resolve()
  }
}

/** The log as a watcher reads it: where he is, each step, and what each step's action sent. */
export function formatLog(session: GuideSession, requests: CapturedRequest[], after = 0): string {
  const state = session.endedAt !== null ? `ended (${session.result?.outcome ?? 'done'})` : session.current === 0 ? 'starting' : `he is on step ${session.current} of ${session.total}: ${session.steps[session.current - 1]?.label ?? ''}`
  const lines = [`session: ${session.id}, ${state}`, `started on ${session.url}`]
  for (const log of session.logs.filter((each) => each.n > after)) {
    lines.push('', `Step ${log.n}. ${log.label}: ${log.outcome}${log.target === '' ? '' : ` on ${log.target}`}${log.url === '' ? '' : `, then at ${log.url}`}`)
    const mine = requests.filter((request) => request.step === log.n)
    if (mine.length === 0) lines.push('  (no API request from this step yet)')
    for (const request of mine.slice(0, 12)) {
      lines.push(`  ${request.method} ${request.url} -> ${request.status ?? 'pending'} [${request.id}]`)
      const headers = Object.entries(redactHeaders(request.requestHeaders)).filter(([key]) => !/^(user-agent|accept-language|accept-encoding|sec-|referer|origin|connection|host|content-length)/i.test(key))
      if (headers.length > 0) lines.push(`    headers: ${headers.map(([k, v]) => `${k}: ${v}`).join('; ').slice(0, 600)}`)
      if (request.postData !== null && request.postData !== '') lines.push(`    body: ${redactBody(request.postData).slice(0, 800)}`)
      if (request.responseBody !== null && request.responseBody !== '') lines.push(`    reply: ${request.responseBody.replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }
  if (session.endedAt === null) lines.push('', 'Still running: call again with after_step set to the last step you saw to wait for the next one.')
  return lines.join('\n')
}

/** A body with its token-like fields masked, for showing to a model. */
export function redactBody(body: string): string {
  const key = /(csrf|xsrf|token|secret|password|passwd|auth|session|signature|api[-_]?key)/i
  try {
    const parsed = JSON.parse(body) as unknown
    const walk = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(walk)
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, key.test(k) ? '[secret]' : walk(v)]))
      }
      return value
    }
    return JSON.stringify(walk(parsed))
  } catch {
    if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(body.trim())) {
      return body
        .split('&')
        .map((pair) => {
          const [k = '', ...rest] = pair.split('=')
          return key.test(decodeURIComponent(k)) ? `${k}=[secret]` : `${k}=${rest.join('=')}`
        })
        .join('&')
    }
    return body
  }
}
