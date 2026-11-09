/** POST JSON with retries on 429, 5xx and network failures, same rules as Kotlin's postJson. */
import { ProviderException, asObject, asString, type JsonObject } from '../model'

/** Our own client name: some providers refuse generic HTTP-library user agents. */
export const USER_AGENT = 'agent-desktop/1'

export interface PostJsonOptions {
  attempts?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  /** How long one attempt may wait for the provider. A provider that never answers must not hang the agent. */
  timeoutMs?: number
}

/** A provider that asks for a longer wait than this before the next try is not waited for here: the caller decides. */
export const RETRY_AFTER_MAX_MS = 20_000

/** The wait a provider asked for with Retry-After (seconds, or a date), in ms; null when it said nothing usable. */
export function retryAfterMs(value: string | null | undefined, now: number = Date.now()): number | null {
  const text = (value ?? '').trim()
  if (text === '') return null
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text) * 1000)
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** One request may take this long (a long answer from a slow model fits); then it is retried. */
export const REQUEST_TIMEOUT_MS = 120_000

export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: JsonObject,
  options: PostJsonOptions = {},
): Promise<JsonObject> {
  const attempts = options.attempts ?? 3
  const fetchImpl = options.fetchImpl ?? fetch
  const signal = options.signal
  let last: ProviderException | null = null
  /** A retryable error that must still end the call now (the provider said when to come back, and it is not soon). */
  let fatal: ProviderException | null = null

  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  let timeouts = 0
  for (let attempt = 0; attempt < attempts; attempt++) {
    /** The wait the provider asked for before the next try, when it said one. */
    let asked: number | null = null
    if (signal?.aborted) throw abortError()
    // The person's Stop and this attempt's own clock both end the request.
    const clock = new AbortController()
    const timer = setTimeout(() => clock.abort(), timeoutMs)
    const onStop = (): void => clock.abort()
    signal?.addEventListener('abort', onStop, { once: true })
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...headers },
        body: JSON.stringify(body),
        signal: clock.signal,
      })
      const text = await res.text()
      if (res.ok) {
        try {
          const parsed: unknown = JSON.parse(text)
          return asObject(parsed)
        } catch {
          throw new ProviderException(`HTTP ${res.status}: response was not JSON`, res.status)
        }
      }
      const message = errorMessage(text)
      const retryable = res.status === 429 || res.status >= 500
      const error = new ProviderException(`HTTP ${res.status}: ${message}`, res.status, retryable)
      if (!retryable) throw error
      asked = retryAfterMs(res.headers?.get?.('retry-after'))
      // Told to stay away for longer than a turn should wait: trying twice more in the next 5 s only adds to the
      // count against the limit. Fail now; whoever runs the turn waits for the limit to reset.
      if (res.status === 429 && asked !== null && asked > RETRY_AFTER_MAX_MS) {
        fatal = error
        throw error
      }
      last = error
    } catch (e) {
      if (e instanceof ProviderException && (!e.retryable || e === fatal)) throw e
      if (signal?.aborted) throw abortError()
      if (clock.signal.aborted) {
        const timedOut = new ProviderException(`The AI service did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, 0, true)
        // A provider that hangs once usually hangs again: one more try, then say so instead of waiting on.
        if (timeouts > 0) throw timedOut
        timeouts += 1
        last = timedOut
      } else if (e instanceof Error && e.name === 'AbortError') throw e
      else if (e instanceof ProviderException) last = e
      else last = new ProviderException(`Network: ${e instanceof Error ? e.message : String(e)}`, 0, true)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onStop)
    }
    if (attempt < attempts - 1) await sleep(Math.max(1500 * (attempt + 1), asked ?? 0), signal)
  }
  throw last ?? new ProviderException('request failed', 0, true)
}

function errorMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    const error = asObject(parsed).error
    const message = asString(asObject(error).message)
    if (message) return message
  } catch {
    // Not JSON: fall back to the body text below.
  }
  return text.slice(0, 300)
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
