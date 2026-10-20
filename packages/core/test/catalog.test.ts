import { describe, expect, it } from 'vitest'

import type { ProviderId } from '../src/ipc'
import { PROVIDERS } from '../src/providers/catalog'

const EXPECTED: ProviderId[] = [
  'anthropic',
  'openai',
  'gemini',
  'deepseek',
  'opencode_go',
  'opencode_zen',
  'openrouter',
  'custom',
]

describe('provider catalog', () => {
  it('lists every provider the settings type allows', () => {
    expect(PROVIDERS.map((provider) => provider.id).sort()).toEqual([...EXPECTED].sort())
  })

  it('has no duplicate ids', () => {
    const ids = PROVIDERS.map((provider) => provider.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('gives every provider a readable label', () => {
    for (const provider of PROVIDERS) expect(provider.label.trim().length).toBeGreaterThan(1)
  })

  it('names a default model for every hosted provider', () => {
    for (const provider of PROVIDERS) {
      if (provider.id === 'custom') continue
      expect(provider.defaultModel.trim().length, provider.id).toBeGreaterThan(0)
    }
  })

  it('leaves the custom provider blank so the person fills it in', () => {
    const custom = PROVIDERS.find((provider) => provider.id === 'custom')
    expect(custom?.baseUrl).toBe('')
    expect(custom?.defaultModel).toBe('')
  })

  it('uses https for every built-in endpoint', () => {
    for (const provider of PROVIDERS) {
      if (provider.id === 'custom') continue
      expect(provider.baseUrl, provider.id).toMatch(/^https:\/\//)
    }
  })

  it('offers a key hint on every row', () => {
    for (const provider of PROVIDERS) expect(provider.keyHint.trim().length, provider.id).toBeGreaterThan(0)
  })
})
