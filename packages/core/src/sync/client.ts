/**
 * Talks to the multi-tenant sync service. Port of reference/kotlin-shared/sync/SyncClient.kt.
 *
 * The service is deliberately dumb: it stores changes in arrival order and hands them back by
 * sequence number. Conflicts are resolved on the devices by the HLC, so the server never has to
 * understand the app's data.
 */
import { blockReason } from '../http-policy'
import { changeFromJson, changeToJson, type Change } from './change'

/** Our own client name, matching the Kotlin client. */
export const SYNC_USER_AGENT = 'agent-sync/1 (multi-platform)'

/** Status 0 means the request never reached the service (network, DNS, blocked URL). */
export class SyncException extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'SyncException'
  }
}

export interface Pulled {
  changes: Change[]
  cursor: number
  /** A node (docs/devices-protocol.md s7) also says which version of its state bundle it has; the service does not. */
  bundle?: string
  /** A node that honoured `entities` names them back; absent when it read the whole log (an older node). */
  entities?: string[]
}

export interface AuthResult {
  userId: number
  token: string
}

export interface PullOptions {
  /** Long-poll seconds. The service holds the request open up to 55 s and answers the instant a change arrives. */
  wait?: number
  signal?: AbortSignal
  /** Only these entities (a node backfilling kinds of rows it did not know before). Older nodes ignore it. */
  entities?: readonly string[]
}

export class SyncClient {
  private readonly base: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch

  constructor(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch, allowHttp = false) {
    const reason = blockReason(baseUrl, allowHttp)
    if (reason !== null) throw new SyncException(0, reason)
    this.base = baseUrl.trim().replace(/\/+$/, '')
    this.token = token
    this.fetchImpl = fetchImpl
  }

  /** Push local changes; returns the server-assigned sequence cursor after accepting them. */
  async push(device: string, changes: Change[], signal?: AbortSignal): Promise<number> {
    const body = { device, changes: changes.map(changeToJson) }
    const json = await this.call('POST', '/v1/sync/push', body, signal)
    return numberOr(json.cursor, 0)
  }

  /** Everything the server has accepted since [since]. */
  async pull(since: number, options: PullOptions = {}): Promise<Pulled> {
    const wait = Math.min(55, Math.max(0, Math.floor(options.wait ?? 0)))
    const sinceValue = Math.max(0, Math.floor(since))
    const only = options.entities !== undefined && options.entities.length > 0 ? `&entities=${encodeURIComponent(options.entities.join(','))}` : ''
    const query = `since=${sinceValue}${wait > 0 ? `&wait=${wait}` : ''}${only}`
    const json = await this.call('GET', `/v1/sync/pull?${query}`, undefined, options.signal)
    const raw = Array.isArray(json.changes) ? json.changes : []
    const changes: Change[] = []
    for (const item of raw) {
      const change = changeFromJson(item)
      if (change !== null) changes.push(change)
    }
    const pulled: Pulled = { changes, cursor: numberOr(json.cursor, sinceValue) }
    if (typeof json.bundle === 'string' && json.bundle !== '') pulled.bundle = json.bundle
    if (Array.isArray(json.entities)) pulled.entities = json.entities.filter((e: unknown): e is string => typeof e === 'string')
    return pulled
  }

  /** Create an account. Throws [SyncException] 409 when the email is taken. */
  static register(
    baseUrl: string,
    email: string,
    password: string,
    fetchImpl: typeof fetch = fetch,
    allowHttp = false,
  ): Promise<AuthResult> {
    return authCall(baseUrl, '/v1/auth/register', email, password, fetchImpl, allowHttp)
  }

  /** Sign in to an existing account. Throws [SyncException] 401 when the details are wrong. */
  static login(
    baseUrl: string,
    email: string,
    password: string,
    fetchImpl: typeof fetch = fetch,
    allowHttp = false,
  ): Promise<AuthResult> {
    return authCall(baseUrl, '/v1/auth/login', email, password, fetchImpl, allowHttp)
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'User-Agent': SYNC_USER_AGENT,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    try {
      const res = await this.fetchImpl(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      })
      const text = await res.text()
      if (!res.ok) throw new SyncException(res.status, errorMessage(text))
      return parseObject(text)
    } catch (error) {
      throw wrapNetworkError(error)
    }
  }
}

async function authCall(
  baseUrl: string,
  path: string,
  email: string,
  password: string,
  fetchImpl: typeof fetch,
  allowHttp: boolean,
): Promise<AuthResult> {
  const reason = blockReason(baseUrl, allowHttp)
  if (reason !== null) throw new SyncException(0, reason)
  const base = baseUrl.trim().replace(/\/+$/, '')
  try {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': SYNC_USER_AGENT },
      body: JSON.stringify({ email, password }),
    })
    const text = await res.text()
    if (!res.ok) throw new SyncException(res.status, errorMessage(text))
    const json = parseObject(text)
    return { userId: numberOr(json.userId, 0), token: typeof json.token === 'string' ? json.token : '' }
  } catch (error) {
    throw wrapNetworkError(error)
  }
}

function wrapNetworkError(error: unknown): Error {
  if (error instanceof SyncException) return error
  if (error instanceof Error && error.name === 'AbortError') return error
  const message = error instanceof Error ? error.message : 'network error'
  return new SyncException(0, message || 'network error')
}

function parseObject(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The service reports `{error:{message}}`; fall back to the raw body like Kotlin does. */
function errorMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>).error
      if (typeof error === 'object' && error !== null) {
        const message = (error as Record<string, unknown>).message
        if (typeof message === 'string' && message !== '') return message
      }
    }
  } catch {
    // Not JSON: use the body text below.
  }
  return text.slice(0, 300)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
