import { describe, expect, it, vi } from 'vitest'

import { geminiProvider } from '../src/main/decisions/providers/gemini'
import { jevProvider } from '../src/main/decisions/providers/jev'
import { llmProvider } from '../src/main/decisions/providers/llm'
import { openAiProvider } from '../src/main/decisions/providers/openai'
import { DecisionError, type FetchLike, type Questions } from '../src/main/decisions/types'

const QUESTIONS: Questions = {
  refund: { type: 'noul', instructions: 'Is the sender asking for a refund?' },
  dept: { type: 'choice', instructions: 'Which team?', options: { billing: 'Money.', support: 'Help.' } },
  urgency: { type: 'score', instructions: 'How urgent?', levels: ['Not', 'Soon', 'Now'] },
}

function reply(status: number, body: unknown): FetchLike {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }))
}
function lastCall(fetchImpl: FetchLike): { url: string; init: { headers: Record<string, string>; body: string } } {
  const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, { headers: Record<string, string>; body: string }]
  return { url, init }
}

describe('gemini adapter', () => {
  const ok = {
    answers: {
      refund: { type: 'noul', noul: 0.97, confidence: 0.97 },
      dept: { type: 'choice', choice: 'billing', probabilities: { billing: 0.9, support: 0.1 }, confidence: 0.9 },
      urgency: { type: 'score', score: 1.8, legend: { 0: 'Not', 1: 'Soon', 2: 'Now' }, probabilities: [0.05, 0.15, 0.8], confidence: 0.8 },
    },
    usage: { total_input_tokens: 120, total_output_tokens: 0 },
  }

  it('sends the documented request and reads the three answer types', async () => {
    const fetchImpl = reply(200, ok)
    const raw = await geminiProvider({ key: () => 'k-secret', fetchImpl }).decide('Please refund me', QUESTIONS)
    const { url, init } = lastCall(fetchImpl)
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/decisions')
    expect(init.headers['x-goog-api-key']).toBe('k-secret')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gemini-decision-1')
    expect(body.input).toBe('Please refund me')
    expect(body.questions.refund).toEqual({ type: 'noul', instructions: 'Is the sender asking for a refund?' })
    expect(body.questions.dept.criteria).toEqual({ billing: 'Money.', support: 'Help.' })
    expect(body.questions.urgency.criteria).toEqual(['Not', 'Soon', 'Now'])
    expect(raw.answers['refund']).toEqual({ type: 'noul', value: true, probability: 0.97, confidence: 0.97 })
    expect(raw.answers['dept']).toMatchObject({ type: 'choice', value: 'billing', confidence: 0.9 })
    expect(raw.answers['urgency']).toMatchObject({ type: 'score', level: 2, confidence: 0.8 })
    expect(raw.inputTokens).toBe(120)
    expect(raw.refused).toEqual([])
  })

  it('a low P(yes) is a confident no: confidence is max(p, 1-p)', async () => {
    const raw = await geminiProvider({ key: () => 'k', fetchImpl: reply(200, { answers: { refund: { type: 'noul', noul: 0.04 } } }) }).decide('hi', { refund: QUESTIONS['refund']! })
    expect(raw.answers['refund']).toMatchObject({ value: false, probability: 0.04, confidence: 0.96 })
  })

  it('sends images as input blocks and a model or address override', async () => {
    const fetchImpl = reply(200, { answers: { refund: { type: 'noul', noul: 0.5, confidence: 0.5 } } })
    await geminiProvider({ key: () => 'k', fetchImpl, model: 'gemini-decision-2', url: 'https://example.test/d' }).decide(
      [
        { type: 'text', text: 'Screenshot' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      ],
      { refund: QUESTIONS['refund']! },
    )
    const { url, init } = lastCall(fetchImpl)
    expect(url).toBe('https://example.test/d')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gemini-decision-2')
    expect(body.input[1]).toMatchObject({ type: 'image', data: 'AAAA', mime_type: 'image/png' })
  })

  it('maps failures to kinds the service acts on', async () => {
    const cases: Array<[number, unknown, string]> = [
      [403, { error: { message: 'Permission denied on the service.' } }, 'auth'],
      [429, { error: { message: 'quota' } }, 'rate'],
      [400, { error: { message: 'blocked', code: 'safety' } }, 'blocked'],
      [400, { error: { message: 'too many questions' } }, 'bad_request'],
      [503, 'down', 'server'],
    ]
    for (const [status, body, kind] of cases) {
      await expect(geminiProvider({ key: () => 'k', fetchImpl: reply(status, body) }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind })
    }
    const boom: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(geminiProvider({ key: () => 'k', fetchImpl: boom }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind: 'network' })
    const slow: FetchLike = async () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' })
    }
    await expect(geminiProvider({ key: () => 'k', fetchImpl: slow }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind: 'timeout' })
    await expect(geminiProvider({ key: () => 'k', fetchImpl: reply(200, 'not json') }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind: 'bad_reply' })
  })

  it('never calls the network without a key or with a bad question set', async () => {
    const fetchImpl = reply(200, ok)
    await expect(geminiProvider({ key: () => null, fetchImpl }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind: 'auth' })
    await expect(geminiProvider({ key: () => '  ', fetchImpl }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind: 'auth' })
    await expect(geminiProvider({ key: () => 'k', fetchImpl }).decide('x', {})).rejects.toBeInstanceOf(DecisionError)
    await expect(geminiProvider({ key: () => 'k', fetchImpl }).decide('x', { 'bad id!': QUESTIONS['refund']! })).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(geminiProvider({ key: () => 'k', fetchImpl }).decide('x', { c: { type: 'choice', instructions: 'q', options: { only: 'one' } } })).rejects.toMatchObject({ kind: 'bad_request' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reads the shapes in the Google docs: choice probabilities as a map, score probabilities keyed by level', async () => {
    const documented = {
      answers: {
        department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.99, shipping: 0.004, other: 0.003, technical: 0.002 }, confidence: 0.99 },
        severity: { type: 'score', score: 1.12, legend: { '0': 'Cosmetic', '1': 'Workaround available', '2': 'Blocked' }, probabilities: { '0': 0.03, '1': 0.83, '2': 0.15 }, confidence: 0.83 },
      },
      usage: { total_input_tokens: 100, input_tokens_by_modality: [{ modality: 'text', tokens: 100 }], total_output_tokens: 0, total_tokens: 100 },
    }
    const raw = await geminiProvider({ key: () => 'k', fetchImpl: reply(200, documented) }).decide('x', {
      department: { type: 'choice', instructions: 'Which?', options: { billing: '', shipping: '', other: '', technical: '' } },
      severity: { type: 'score', instructions: 'How bad?', levels: ['Cosmetic', 'Workaround available', 'Blocked'] },
    })
    expect(raw.answers['department']).toMatchObject({ value: 'billing', confidence: 0.99, probabilities: { billing: 0.99, shipping: 0.004, other: 0.003, technical: 0.002 } })
    expect(raw.answers['severity']).toMatchObject({ type: 'score', value: 1.12, level: 1, probabilities: [0.03, 0.83, 0.15], confidence: 0.83 })
    expect(raw.inputTokens).toBe(100)
  })

  it('reads the shapes in the Google docs: choice probabilities as a map, score probabilities keyed by level', async () => {
    const documented = {
      answers: {
        department: { type: 'choice', choice: 'billing', probabilities: { billing: 0.99, shipping: 0.004, other: 0.003, technical: 0.002 }, confidence: 0.99 },
        severity: { type: 'score', score: 1.12, legend: { '0': 'Cosmetic', '1': 'Workaround available', '2': 'Blocked' }, probabilities: { '0': 0.03, '1': 0.83, '2': 0.15 }, confidence: 0.83 },
      },
      usage: { total_input_tokens: 100, input_tokens_by_modality: [{ modality: 'text', tokens: 100 }], total_output_tokens: 0, total_tokens: 100 },
    }
    const raw = await geminiProvider({ key: () => 'k', fetchImpl: reply(200, documented) }).decide('x', {
      department: { type: 'choice', instructions: 'Which?', options: { billing: '', shipping: '', other: '', technical: '' } },
      severity: { type: 'score', instructions: 'How bad?', levels: ['Cosmetic', 'Workaround available', 'Blocked'] },
    })
    expect(raw.answers['department']).toMatchObject({ value: 'billing', confidence: 0.99, probabilities: { billing: 0.99, shipping: 0.004, other: 0.003, technical: 0.002 } })
    expect(raw.answers['severity']).toMatchObject({ type: 'score', value: 1.12, level: 1, probabilities: [0.03, 0.83, 0.15], confidence: 0.83 })
    expect(raw.inputTokens).toBe(100)
  })

  it('a question the model left out is reported, not invented', async () => {
    const raw = await geminiProvider({ key: () => 'k', fetchImpl: reply(200, { answers: { refund: { type: 'noul', noul: 0.9, confidence: 0.9 } } }) }).decide('x', QUESTIONS)
    expect(raw.refused.sort()).toEqual(['dept', 'urgency'])
    expect(Object.keys(raw.answers)).toEqual(['refund'])
  })
})

describe('jev adapter (OpenRouter envelope)', () => {
  it('uses state, a bearer key and keyed answers', async () => {
    const fetchImpl = reply(200, { id: 'x', model: 'typesafe/jev-1.14', answers: { refund: { type: 'noul', probability: 0.9, confidence: 0.9 }, dept: { type: 'choice', choice: 'support', probabilities: { billing: 0.2, support: 0.8 }, confidence: 0.8 } }, usage: { input_tokens: 40, output_tokens: 0 } })
    const raw = await jevProvider({ key: () => 'or-key', fetchImpl }).decide('hello', { refund: QUESTIONS['refund']!, dept: QUESTIONS['dept']! })
    const { url, init } = lastCall(fetchImpl)
    expect(url).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(init.headers['authorization']).toBe('Bearer or-key')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('typesafe/jev-1.14')
    expect(body.state).toBe('hello')
    expect(body.questions.dept.criteria).toEqual({ billing: 'Money.', support: 'Help.' })
    expect(raw.answers['refund']).toMatchObject({ value: true, probability: 0.9 })
    expect(raw.answers['dept']).toMatchObject({ value: 'support' })
    expect(raw.inputTokens).toBe(40)
  })
  it('needs a key and reads a refusal as no answer', async () => {
    const fetchImpl = reply(200, { answers: { refund: { type: 'refusal' } } })
    await expect(jevProvider({ key: () => null, fetchImpl }).decide('x', { refund: QUESTIONS['refund']! })).rejects.toMatchObject({ kind: 'auth' })
    expect(fetchImpl).not.toHaveBeenCalled()
    const raw = await jevProvider({ key: () => 'k', fetchImpl }).decide('x', { refund: QUESTIONS['refund']! })
    expect(raw.refused).toEqual(['refund'])
  })
})

describe('openai adapter', () => {
  it('sends predicate, choice and score questions as a list and reads the answers in order', async () => {
    const fetchImpl = reply(200, {
      model: 'gpt-6-luna',
      answers: [
        { type: 'predicate', name: 'refund', probability: 0.08 },
        { type: 'choice', name: 'dept', choice: 'billing', confidence: 0.7, probabilities: [{ value: 'billing', probability: 0.7 }, { value: 'support', probability: 0.3 }] },
        { type: 'score', name: 'urgency', score: 2, confidence: 0.6, probabilities: [{ label: '0', value: 0, probability: 0.1 }, { label: '1', value: 1, probability: 0.3 }, { label: '2', value: 2, probability: 0.6 }] },
      ],
      usage: { input_tokens: 55, output_tokens: 0, total_tokens: 55 },
    })
    const raw = await openAiProvider({ key: () => 'sk-test', fetchImpl }).decide('Please refund me', QUESTIONS)
    const { url, init } = lastCall(fetchImpl)
    expect(url).toBe('https://api.openai.com/v1/decisions')
    expect(init.headers['authorization']).toBe('Bearer sk-test')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('gpt-6-luna')
    expect(body.questions[0]).toMatchObject({ type: 'predicate', name: 'refund' })
    expect(body.questions[1]).toMatchObject({ type: 'choice', name: 'dept', choices: [{ value: 'billing', description: 'Money.' }, { value: 'support', description: 'Help.' }] })
    expect(body.questions[2].levels).toEqual([{ label: '0', description: 'Not' }, { label: '1', description: 'Soon' }, { label: '2', description: 'Now' }])
    expect(raw.answers['refund']).toMatchObject({ value: false, confidence: 0.92 })
    expect(raw.answers['dept']).toMatchObject({ value: 'billing', confidence: 0.7 })
    expect(raw.answers['urgency']).toMatchObject({ level: 2, confidence: 0.6 })
    expect(raw.inputTokens).toBe(55)
  })
  it('a refusal affects only its own question, and 400 questions is the limit', async () => {
    const fetchImpl = reply(200, { answers: [{ type: 'refusal', name: 'refund' }, { type: 'predicate', name: 'x', probability: 0.5 }] })
    const raw = await openAiProvider({ key: () => 'k', fetchImpl }).decide('x', { refund: QUESTIONS['refund']!, x: QUESTIONS['refund']! })
    expect(raw.refused).toEqual(['refund'])
    expect(raw.answers['x']).toBeDefined()
    const many: Questions = Object.fromEntries(Array.from({ length: 401 }, (_, i) => [`q${i}`, QUESTIONS['refund']!]))
    await expect(openAiProvider({ key: () => 'k', fetchImpl }).decide('x', many)).rejects.toMatchObject({ kind: 'bad_request' })
  })
})

describe('llm backend (the apps own model)', () => {
  it('asks the same questions as JSON and reads them back', async () => {
    const complete = vi.fn(async () => 'Sure: {"refund": {"answer": true, "confidence": 0.9}, "dept": {"answer": "billing", "confidence": 0.8}, "urgency": {"answer": 2, "confidence": 0.7}}')
    const raw = await llmProvider({ complete }).decide('Please refund me', QUESTIONS)
    expect(complete).toHaveBeenCalledTimes(1)
    const prompt = (complete.mock.calls[0] as unknown as string[])[1] as string
    expect(prompt).toContain('refund (yes/no)')
    expect(prompt).toContain('Options: billing = Money.')
    expect(raw.answers['refund']).toMatchObject({ value: true, confidence: 0.9 })
    expect(raw.answers['dept']).toMatchObject({ value: 'billing', confidence: 0.8 })
    expect(raw.answers['urgency']).toMatchObject({ level: 2 })
  })
  it('unreadable or invalid answers are refused, and a model failure is an error', async () => {
    const raw = await llmProvider({ complete: async () => '{"refund": {"answer": "maybe"}, "dept": {"answer": "nonsense"}}' }).decide('x', QUESTIONS)
    expect(raw.refused.sort()).toEqual(['dept', 'refund', 'urgency'])
    await expect(llmProvider({ complete: async () => 'no json here' }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind: 'bad_reply' })
    await expect(llmProvider({ complete: async () => { throw new Error('not signed in') } }).decide('x', QUESTIONS)).rejects.toMatchObject({ kind: 'server' })
  })
})
