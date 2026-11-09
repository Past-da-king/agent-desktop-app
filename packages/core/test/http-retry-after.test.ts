/** A rate-limited provider that says when to come back is believed: no doomed retries, and short waits are kept. */
import { describe, expect, it } from 'vitest'

import { ProviderException } from '../src/model'
import { postJson, retryAfterMs } from '../src/providers/http'

function limited(calls: { n: number }, retryAfter: string, okAfter = Infinity): typeof fetch {
  return (async () => {
    calls.n += 1
    if (calls.n > okAfter) return new Response('{"ok":true}', { status: 200 })
    return new Response('{"error":{"message":"Too many requests"}}', { status: 429, headers: { 'retry-after': retryAfter } })
  }) as unknown as typeof fetch
}

describe('postJson and Retry-After', () => {
  it('reads seconds and dates', () => {
    expect(retryAfterMs('7')).toBe(7000)
    expect(retryAfterMs('Mon, 09 Nov 2026 20:00:10 GMT', Date.parse('2026-11-09T20:00:00Z'))).toBe(10_000)
    expect(retryAfterMs('')).toBeNull()
    expect(retryAfterMs('soon')).toBeNull()
  })

  it('a 429 that says come back in an hour is not tried twice more', async () => {
    const calls = { n: 0 }
    const started = Date.now()
    const error = await postJson('https://x/chat', {}, {}, { fetchImpl: limited(calls, '3600') }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderException)
    expect((error as ProviderException).status).toBe(429)
    expect(calls.n).toBe(1)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('a 429 with a short wait is retried and goes through', async () => {
    const calls = { n: 0 }
    const out = await postJson('https://x/chat', {}, {}, { fetchImpl: limited(calls, '0', 1) })
    expect(out).toEqual({ ok: true })
    expect(calls.n).toBe(2)
  }, 10_000)
})
