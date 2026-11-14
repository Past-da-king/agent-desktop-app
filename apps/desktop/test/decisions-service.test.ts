import { describe, expect, it, vi } from 'vitest'

import { resolveDecisionKeys } from '../src/main/decisions/keys'
import { DecisionService, type DecisionServiceDeps, type DecisionSettings } from '../src/main/decisions/service'
import { DecisionError, type Answer, type DecisionProvider, type Questions } from '../src/main/decisions/types'

const Q: Questions = {
  a: { type: 'noul', instructions: 'Is it a?' },
  b: { type: 'noul', instructions: 'Is it b?' },
}

function noul(p: number): Answer {
  return { type: 'noul', value: p >= 0.5, probability: p, confidence: Math.max(p, 1 - p) }
}

function setup(over: { settings?: Partial<DecisionSettings>; gemini?: DecisionProvider; complete?: DecisionServiceDeps['complete']; keys?: Partial<DecisionServiceDeps['keys']> } = {}) {
  const logs: Array<Record<string, unknown>> = []
  const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '{}' }))
  const settings: DecisionSettings = { enabled: true, backend: 'gemini', threshold: 0.8, ...over.settings }
  const service = new DecisionService({
    settings: () => settings,
    keys: { gemini: () => 'key', openai: () => null, jev: () => null, ...over.keys },
    fetchImpl,
    ...(over.complete === undefined ? {} : { complete: over.complete }),
    ...(over.gemini === undefined ? {} : { providers: { gemini: over.gemini } }),
    log: (_m, f) => logs.push(f),
  })
  return { service, fetchImpl, logs }
}

const provider = (answers: Record<string, Answer>, refused: string[] = []): DecisionProvider => ({ id: 'gemini', decide: vi.fn(async () => ({ answers, refused })) })
const failing = (kind: 'auth' | 'timeout' | 'rate'): DecisionProvider => ({ id: 'gemini', decide: vi.fn(async () => { throw new DecisionError(kind, 'x') }) })

describe('DecisionService', () => {
  it('is off by default: no network call, no provider call, path none', async () => {
    const gemini = provider({ a: noul(0.99), b: noul(0.99) })
    const { service, fetchImpl } = setup({ settings: { enabled: false }, gemini })
    const result = await service.decide('x', Q)
    expect(result).toMatchObject({ path: 'none', reason: 'off', provider: null, allConfident: false })
    expect(gemini.decide).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(service.enabled()).toBe(false)
  })

  it('off with the real adapter also never touches the network', async () => {
    const { service, fetchImpl } = setup({ settings: { enabled: false } })
    await service.decide('x', Q)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers confidently from the decision model and says so', async () => {
    const { service, logs } = setup({ gemini: provider({ a: noul(0.95), b: noul(0.03) }) })
    const result = await service.decide('x', Q)
    expect(result.path).toBe('decision')
    expect(result.provider).toBe('gemini')
    expect(result.allConfident).toBe(true)
    expect(result.answers['a']).toMatchObject({ via: 'decision', confident: true, value: true })
    expect(result.answers['b']).toMatchObject({ confident: true, value: false })
    expect(logs[0]).toMatchObject({ path: 'decision', provider: 'gemini', reason: 'ok', questions: 2 })
  })

  it('a confidence exactly at the threshold counts, just under does not', async () => {
    const { service } = setup({ gemini: provider({ a: noul(0.8), b: noul(0.79) }) })
    const result = await service.decide('x', Q, { fallback: 'none' })
    expect(result.answers['a']?.confident).toBe(true)
    expect(result.answers['b']?.confident).toBe(false)
    expect(result.allConfident).toBe(false)
    expect(result.reason).toBe('low_confidence')
  })

  it('a per-call threshold overrides the setting, and is clamped to 0.5 to 0.99', async () => {
    const { service } = setup({ gemini: provider({ a: noul(0.9), b: noul(0.9) }) })
    expect((await service.decide('x', Q, { threshold: 0.95, fallback: 'none' })).allConfident).toBe(false)
    expect((await service.decide('x', Q, { threshold: 0.1, fallback: 'none' })).threshold).toBe(0.5)
    expect((await service.decide('x', Q, { threshold: 5, fallback: 'none' })).threshold).toBe(0.99)
  })

  it('low confidence asks the app\'s own model only for the unsure questions', async () => {
    const complete = vi.fn(async () => '{"b": {"answer": true, "confidence": 0.9}}')
    const { service } = setup({ gemini: provider({ a: noul(0.99), b: noul(0.55) }), complete: () => complete })
    const result = await service.decide('x', Q)
    expect(complete).toHaveBeenCalledTimes(1)
    expect((complete.mock.calls[0] as unknown as string[])[1]).not.toContain('Is it a?')
    expect(result.path).toBe('decision+llm')
    expect(result.answers['a']?.via).toBe('decision')
    expect(result.answers['b']).toMatchObject({ via: 'llm', confident: true, value: true })
    expect(result.allConfident).toBe(true)
  })

  it('an error, a timeout or a rate limit falls back to the LLM, never throws', async () => {
    for (const kind of ['auth', 'timeout', 'rate'] as const) {
      const complete = vi.fn(async () => '{"a": {"answer": true, "confidence": 0.7}, "b": {"answer": false, "confidence": 0.7}}')
      const { service } = setup({ gemini: failing(kind), complete: () => complete })
      const result = await service.decide('x', Q)
      expect(result.path).toBe('llm')
      expect(result.reason).toBe(`error:${kind}`)
      expect(result.allConfident).toBe(true)
    }
  })

  it('with fallback none an error leaves the work to the caller', async () => {
    const complete = vi.fn(async () => '{}')
    const { service } = setup({ gemini: failing('timeout'), complete: () => complete })
    const result = await service.decide('x', Q, { fallback: 'none' })
    expect(result).toMatchObject({ path: 'none', reason: 'error:timeout', allConfident: false })
    expect(complete).not.toHaveBeenCalled()
  })

  it('no key: path none, no network call, and the LLM answers when allowed', async () => {
    const { service, fetchImpl } = setup({ keys: { gemini: () => null } })
    const none = await service.decide('x', Q, { fallback: 'none' })
    expect(none.reason).toBe('error:auth')
    expect(fetchImpl).not.toHaveBeenCalled()
    const complete = vi.fn(async () => '{"a": {"answer": true, "confidence": 0.9}, "b": {"answer": true, "confidence": 0.9}}')
    const { service: withLlm } = setup({ keys: { gemini: () => null }, complete: () => complete })
    expect((await withLlm.decide('x', Q)).path).toBe('llm')
  })

  it('a failing LLM fallback still does not throw', async () => {
    const complete = vi.fn(async () => { throw new Error('offline') })
    const { service } = setup({ gemini: provider({ a: noul(0.5), b: noul(0.5) }), complete: () => complete })
    const result = await service.decide('x', Q)
    expect(result.path).toBe('decision')
    expect(result.reason).toContain('llm_error')
    expect(result.allConfident).toBe(false)
  })

  it('the llm backend uses only the app\'s own model', async () => {
    const complete = vi.fn(async () => '{"a": {"answer": false, "confidence": 0.9}, "b": {"answer": true, "confidence": 0.9}}')
    const { service, fetchImpl } = setup({ settings: { backend: 'llm' }, complete: () => complete })
    const result = await service.decide('x', Q)
    expect(result).toMatchObject({ path: 'llm', provider: 'llm' })
    expect(fetchImpl).not.toHaveBeenCalled()
    const { service: none } = setup({ settings: { backend: 'llm' } })
    expect((await none.decide('x', Q)).reason).toBe('no_llm')
  })

  it('settings are clamped when read', () => {
    const { service } = setup({ settings: { threshold: 7 } })
    expect(service.settings().threshold).toBe(0.99)
    const { service: low } = setup({ settings: { threshold: Number.NaN } })
    expect(low.settings().threshold).toBe(0.9)
  })
})

describe('resolveDecisionKeys: reuse what the app already holds', () => {
  const secrets = (map: Record<string, string>) => ({ get: (name: string) => map[name] ?? null })
  const account = (id: string, provider: string, hasKey = true) => ({ id, label: id, kind: 'api' as const, provider: provider as 'gemini', model: '', hasKey })

  it('uses the Voice Gemini key first, else a Gemini AI account, and asks for no new key', () => {
    const settings = () => ({ accounts: [account('a1', 'gemini')] })
    expect(resolveDecisionKeys(secrets({ geminiKey: ' voice-key ', 'apiKey-a1': 'acct' }), settings).gemini()).toBe('voice-key')
    expect(resolveDecisionKeys(secrets({ 'apiKey-a1': 'acct' }), settings).gemini()).toBe('acct')
    expect(resolveDecisionKeys(secrets({}), settings).gemini()).toBeNull()
    expect(resolveDecisionKeys(secrets({ 'apiKey-a1': 'acct' }), () => ({ accounts: [account('a1', 'gemini', false)] })).gemini()).toBeNull()
  })
  it('openai and jev use their own secret or a matching account', () => {
    const settings = () => ({ accounts: [account('o1', 'openai'), account('r1', 'openrouter')] })
    const keys = resolveDecisionKeys(secrets({ 'apiKey-o1': 'sk-o', 'apiKey-r1': 'sk-r' }), settings)
    expect(keys.openai()).toBe('sk-o')
    expect(keys.jev()).toBe('sk-r')
    expect(resolveDecisionKeys(secrets({ 'decisionsKey-jev': 'own', 'apiKey-r1': 'sk-r' }), settings).jev()).toBe('own')
  })
})
