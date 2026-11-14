import { describe, expect, it, vi } from 'vitest'

import { DecisionService } from '../src/main/decisions/service'
import { decideTool, parseQuestions } from '../src/main/decisions/tool'
import type { DecisionProvider } from '../src/main/decisions/types'

const provider: DecisionProvider = {
  id: 'gemini',
  decide: vi.fn(async () => ({ answers: { urgent: { type: 'noul' as const, value: true, probability: 0.96, confidence: 0.96 } }, refused: [] })),
}
function svc(enabled: boolean): DecisionService {
  return new DecisionService({ settings: () => ({ enabled, backend: 'gemini', threshold: 0.8 }), keys: { gemini: () => 'k', openai: () => null, jev: () => null }, providers: { gemini: provider } })
}
const ctx = {} as never
const QUESTIONS = [{ id: 'urgent', type: 'noul', instructions: 'Is this urgent?' }]

describe('decide tool', () => {
  it('is a registered read-only tool with a clear schema', () => {
    const spec = decideTool(() => null).spec
    expect(spec.name).toBe('decide')
    expect(JSON.stringify(spec.schema)).toContain('noul')
  })

  it('off: tells the agent to answer itself and makes no call', async () => {
    const out = JSON.parse(await decideTool(() => svc(false)).run({ input: 'x', questions: QUESTIONS }, ctx))
    expect(out).toMatchObject({ path: 'none', reason: 'off' })
    expect(provider.decide).not.toHaveBeenCalled()
    expect(JSON.parse(await decideTool(() => null).run({ input: 'x', questions: QUESTIONS }, ctx))).toMatchObject({ reason: 'off' })
  })

  it('on: returns the path, provider, latency and per-question answers', async () => {
    const out = JSON.parse(await decideTool(() => svc(true)).run({ input: 'The server is down', questions: QUESTIONS }, ctx))
    expect(out).toMatchObject({ path: 'decision', provider: 'gemini', allConfident: true, threshold: 0.8 })
    expect(out.answers.urgent).toMatchObject({ value: true, confidence: 0.96, confident: true, via: 'decision' })
    expect(typeof out.latencyMs).toBe('number')
  })

  it('rejects an empty input and a bad question set without a call', async () => {
    const tool = decideTool(() => svc(true))
    expect(JSON.parse(await tool.run({ input: ' ', questions: QUESTIONS }, ctx)).error).toContain('empty')
    expect(JSON.parse(await tool.run({ input: 'x', questions: [] }, ctx)).error).toContain('at least one')
    expect(JSON.parse(await tool.run({ input: 'x', questions: [{ id: 'c', type: 'choice', instructions: 'q' }] }, ctx)).error).toContain('options')
  })

  it('parseQuestions reads all three types and refuses duplicates', () => {
    const parsed = parseQuestions([
      { id: 'a', type: 'noul', instructions: 'Q?', true_description: 'yes' },
      { id: 'b', type: 'choice', instructions: 'Which?', options: { x: 'ex', y: 'why' } },
      { id: 'c', type: 'score', instructions: 'How much?', levels: ['low', 'high'] },
    ])
    expect(parsed).toEqual({
      a: { type: 'noul', instructions: 'Q?', trueDescription: 'yes' },
      b: { type: 'choice', instructions: 'Which?', options: { x: 'ex', y: 'why' } },
      c: { type: 'score', instructions: 'How much?', levels: ['low', 'high'] },
    })
    expect(parseQuestions([{ id: 'a', type: 'noul', instructions: 'Q' }, { id: 'a', type: 'noul', instructions: 'Q' }])).toContain('twice')
  })
})
