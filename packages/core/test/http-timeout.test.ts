/** A provider that never answers must not hang the agent: one retry, then a plain error. */
import { describe, expect, it } from 'vitest'

import { ProviderException } from '../src/model'
import { postJson } from '../src/providers/http'

function hanging(calls: { n: number }): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      calls.n += 1
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })) as unknown as typeof fetch
}

describe('postJson time limit', () => {
  it('gives up after one retry with a plain message', async () => {
    const calls = { n: 0 }
    const error = await postJson('https://x/chat', {}, {}, { fetchImpl: hanging(calls), timeoutMs: 30 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderException)
    expect((error as Error).message).toContain('did not answer')
    expect(calls.n).toBe(2)
  }, 10_000)

  it('the person stopping still ends it as a stop, not a timeout', async () => {
    const stop = new AbortController()
    const pending = postJson('https://x/chat', {}, {}, { fetchImpl: hanging({ n: 0 }), timeoutMs: 60_000, signal: stop.signal }).catch((e: unknown) => e)
    stop.abort()
    expect(((await pending) as Error).name).toBe('AbortError')
  })
})
