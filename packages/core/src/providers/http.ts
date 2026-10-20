/** POST JSON with retries on 429, 5xx and network failures, same rules as Kotlin's postJson. */
import { ProviderException, asObject, asString, type JsonObject } from '../model'

/** Our own client name: some providers refuse generic HTTP-library user agents. */
export const USER_AGENT = 'agent-desktop/1'

export interface PostJsonOptions {
  attempts?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

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

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw abortError()
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, ...headers },
        body: JSON.stringify(body),
        signal,
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
      last = error
    } catch (e) {
      if (e instanceof ProviderException && !e.retryable) throw e
      if (e instanceof Error && e.name === 'AbortError') throw e
      if (e instanceof ProviderException) last = e
      else last = new ProviderException(`Network: ${e instanceof Error ? e.message : String(e)}`, 0, true)
    }
    if (attempt < attempts - 1) await sleep(1500 * (attempt + 1), signal)
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
