import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { formatReport, isCorrect, parseExamples, runEval, summarize, type Observation, type RunOutput } from '../src/main/decisions/eval'
import type { Answer, DecisionProvider } from '../src/main/decisions/types'

const SEED = join(__dirname, 'fixtures', 'decisions', 'seed.jsonl')

describe('eval example file', () => {
  it('the seed set parses, is synthetic and labelled for every question', () => {
    const text = readFileSync(SEED, 'utf8')
    const { examples, errors } = parseExamples(text)
    expect(errors).toEqual([])
    expect(examples.length).toBeGreaterThanOrEqual(40)
    for (const e of examples) expect(Object.keys(e.expected).sort()).toEqual(['needs_attention', 'route', 'urgent'])
    // No real people or addresses in the repo.
    expect(text).not.toMatch(/@[a-z0-9-]+\.(com|co\.za|co\.uk)/i)
    const noise = examples.filter((e) => e.expected['needs_attention'] === false).length
    expect(noise).toBeGreaterThan(10)
    expect(examples.length - noise).toBeGreaterThan(10)
  })

  it('reports each bad line with its number and keeps the good ones', () => {
    const good = JSON.stringify({ id: 'a', input: 'x', questions: { q: { type: 'noul', instructions: 'Is it?' } }, expected: { q: true } })
    const { examples, errors } = parseExamples(['not json', good, good, JSON.stringify({ id: 'b', input: 'x', questions: { q: { type: 'noul', instructions: 'Is it?' } }, expected: { nope: true } }), '', JSON.stringify({ id: 'c', input: 5, questions: {}, expected: {} })].join('\n'))
    expect(examples).toHaveLength(1)
    expect(errors.join('|')).toContain('line 1: not JSON')
    expect(errors.join('|')).toContain('line 3: id "a" used twice')
    expect(errors.join('|')).toContain('line 4: expected names unknown question nope')
    expect(errors.join('|')).toContain('line 6: input must be text')
  })

  it('scores each answer type against its expected value', () => {
    expect(isCorrect({ type: 'noul', value: true, probability: 0.9, confidence: 0.9 }, true)).toBe(true)
    expect(isCorrect({ type: 'choice', value: 'a', probabilities: { a: 1 }, confidence: 1 }, 'b')).toBe(false)
    expect(isCorrect({ type: 'score', value: 1.7, level: 2, probabilities: [0, 0.3, 0.7], confidence: 0.7 }, 2)).toBe(true)
  })
})

function obs(question: string, confidence: number, correct: boolean): Observation {
  return { example: 'e', question, type: 'noul', correct, confidence }
}

describe('summarize', () => {
  it('computes per-question accuracy, buckets, the curve and a recommended threshold', () => {
    const rows: Observation[] = []
    // Low-confidence answers are right half the time; high-confidence ones nearly always.
    for (let i = 0; i < 20; i++) rows.push(obs('q1', 0.55, i % 2 === 0))
    for (let i = 0; i < 40; i++) rows.push(obs('q1', 0.97, i !== 0))
    for (let i = 0; i < 20; i++) rows.push(obs('q2', 0.85, i < 16))
    const run: RunOutput = { observations: rows, failures: [], missing: 0, latenciesMs: [100, 200, 300, 400, 500] }
    const r = summarize(run, { target: 0.95 })
    expect(r.answers).toBe(80)
    expect(r.perQuestion['q1']).toEqual({ n: 60, accuracy: (10 + 39) / 60 })
    expect(r.perQuestion['q2']?.accuracy).toBe(0.8)
    const b = r.buckets.find((x) => x.from === 0.5)!
    expect(b).toMatchObject({ n: 20, accuracy: 0.5 })
    expect(r.buckets.find((x) => x.from === 0.95)).toMatchObject({ n: 40 })
    expect(r.curve.find((p) => p.threshold === 0.95)).toMatchObject({ n: 40, coverage: 0.5 })
    expect(r.recommended.threshold).toBe(0.9)
    expect(r.recommended.accuracy).toBeCloseTo(39 / 40)
    expect(r.latency).toMatchObject({ n: 5, p50Ms: 300, p95Ms: 500 })
    expect(r.recommendedPerQuestion['q1']).toMatchObject({ threshold: 0.6 })
    expect(r.recommendedPerQuestion['q2']).toMatchObject({ threshold: null })
    expect(summarize({ observations: [obs('c', 0.4, false), obs('c', 0.6, true)], failures: [], missing: 0, latenciesMs: [] }).buckets[0]).toMatchObject({ from: 0, to: 0.5, n: 1 })
    expect(r.recommendedPerQuestion['q1']).toMatchObject({ threshold: 0.6 })
    expect(r.recommendedPerQuestion['q2']).toMatchObject({ threshold: null })
    expect(summarize({ observations: [obs('c', 0.4, false), obs('c', 0.6, true)], failures: [], missing: 0, latenciesMs: [] }).buckets[0]).toMatchObject({ from: 0, to: 0.5, n: 1 })
    expect(r.calibrationError).toBeGreaterThan(0)
    expect(formatReport(r)).toContain('Recommended threshold: 0.9')
  })

  it('recommends no threshold when none is good enough or has enough answers', () => {
    const run: RunOutput = { observations: Array.from({ length: 30 }, (_, i) => obs('q', 0.9, i % 3 === 0)), failures: [], missing: 0, latenciesMs: [] }
    expect(summarize(run).recommended.threshold).toBeNull()
    const few: RunOutput = { observations: [obs('q', 0.99, true), obs('q', 0.99, true)], failures: [], missing: 0, latenciesMs: [] }
    expect(summarize(few, { minAnswers: 10 }).recommended.threshold).toBeNull()
    expect(summarize({ observations: [], failures: [], missing: 0, latenciesMs: [] }).accuracy).toBeNull()
  })
})

describe('runEval', () => {
  it('asks only for what is labelled, records failures and missing answers, and times each request', async () => {
    const { examples } = parseExamples(
      [
        JSON.stringify({ id: 'a', input: 'one', questions: { q: { type: 'noul', instructions: 'Is it?' }, other: { type: 'noul', instructions: 'Other?' } }, expected: { q: true } }),
        JSON.stringify({ id: 'b', input: 'two', questions: { q: { type: 'noul', instructions: 'Is it?' } }, expected: { q: false } }),
        JSON.stringify({ id: 'c', input: 'boom', questions: { q: { type: 'noul', instructions: 'Is it?' } }, expected: { q: true } }),
        JSON.stringify({ id: 'd', input: 'skip', questions: { q: { type: 'noul', instructions: 'Is it?' } }, expected: { q: true } }),
      ].join('\n'),
    )
    const asked: string[][] = []
    const provider: DecisionProvider = {
      id: 'gemini',
      async decide(input, questions) {
        asked.push(Object.keys(questions))
        if (input === 'boom') throw new Error('HTTP 500')
        if (input === 'skip') return { answers: {}, refused: ['q'] }
        const yes: Answer = { type: 'noul', value: input === 'one', probability: 0.9, confidence: 0.9 }
        return { answers: { q: yes }, refused: [] }
      },
    }
    let t = 0
    const run = await runEval(provider, examples, { concurrency: 1, now: () => (t += 10) })
    expect(asked[0]).toEqual(['q'])
    expect(run.observations.map((o) => [o.example, o.correct])).toEqual([['a', true], ['b', true]])
    expect(run.failures).toEqual([{ example: 'c', error: 'HTTP 500' }])
    expect(run.missing).toBe(1)
    expect(run.latenciesMs.length).toBe(3)
  })
})
