/** Models come from the provider's own list for the key, never from a hardcoded choice. */
import { describe, expect, it } from 'vitest'

import { listModels } from '../src/main/models'

function fake(status: number, body: unknown, seen: { url?: string; headers?: Record<string, string> } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    seen.url = url
    seen.headers = init?.headers as Record<string, string>
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
}

describe('listModels', () => {
  it('reads an OpenAI-style list with the key as a bearer token, and drops non-chat models', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    const out = await listModels({
      provider: 'opencode_go',
      key: 'k',
      fetchImpl: fake(200, { data: [{ id: 'deepseek-v4.1-flash' }, { id: 'kimi-k3' }, { id: 'text-embedding-3' }] }, seen),
    })
    expect(seen.url).toBe('https://opencode.ai/zen/go/v1/models')
    expect(seen.headers?.['authorization']).toBe('Bearer k')
    expect(out.models.map((m) => m.id)).toEqual(['deepseek-v4.1-flash', 'kimi-k3'])
  })

  it('asks Anthropic with its own headers', async () => {
    const seen: { url?: string; headers?: Record<string, string> } = {}
    const out = await listModels({ provider: 'anthropic', key: 'a', fetchImpl: fake(200, { data: [{ id: 'claude-opus-5-5' }] }, seen) })
    expect(seen.url).toContain('api.anthropic.com/v1/models')
    expect(seen.headers?.['x-api-key']).toBe('a')
    expect(out.models.map((m) => m.id)).toEqual(['claude-opus-5-5'])
  })

  it('strips the models/ prefix Gemini uses', async () => {
    const out = await listModels({ provider: 'gemini', key: 'g', fetchImpl: fake(200, { data: [{ id: 'models/gemini-3.5-flash' }] }) })
    expect(out.models.map((m) => m.id)).toEqual(['gemini-3.5-flash'])
  })

  it('says plainly when the key is refused', async () => {
    const out = await listModels({ provider: 'deepseek', key: 'bad', fetchImpl: fake(401, {}) })
    expect(out).toMatchObject({ ok: false, message: 'That key was not accepted.' })
  })
})
