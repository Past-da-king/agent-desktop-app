/**
 * The eval harness core (docs/decisions.md): load labelled examples, run them through a backend, and report per-question
 * accuracy, calibration by confidence bucket, the coverage and accuracy at each threshold, and a recommended threshold.
 *
 * Example file: JSON Lines, one example per line:
 *   {"id":"a1","input":"text or [{type:'text',text}]","questions":{"urgent":{"type":"noul","instructions":"..."}},"expected":{"urgent":true}}
 * expected: true/false for a noul, the option id for a choice, the level index (0 is the first) for a score.
 */
import { questionsProblem } from './shared'
import type { Answer, DecisionInput, DecisionProvider, Questions } from './types'

export type Expected = boolean | string | number

export interface EvalExample {
  id: string
  input: DecisionInput
  questions: Questions
  expected: Record<string, Expected>
}

export function parseExamples(jsonl: string): { examples: EvalExample[]; errors: string[] } {
  const examples: EvalExample[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  jsonl.split(/\r?\n/).forEach((line, index) => {
    const text = line.trim()
    if (text === '' || text.startsWith('//')) return
    const at = `line ${index + 1}`
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      errors.push(`${at}: not JSON`)
      return
    }
    if (typeof raw !== 'object' || raw === null) {
      errors.push(`${at}: not an object`)
      return
    }
    const o = raw as Record<string, unknown>
    const id = typeof o['id'] === 'string' && o['id'] !== '' ? o['id'] : `ex${index + 1}`
    if (seen.has(id)) {
      errors.push(`${at}: id "${id}" used twice`)
      return
    }
    const input = o['input']
    if (typeof input !== 'string' && !Array.isArray(input)) {
      errors.push(`${at}: input must be text or a list of parts`)
      return
    }
    const questions = o['questions'] as Questions
    if (typeof questions !== 'object' || questions === null) {
      errors.push(`${at}: questions missing`)
      return
    }
    const problem = questionsProblem(questions)
    if (problem !== null) {
      errors.push(`${at}: ${problem}`)
      return
    }
    const expected = o['expected']
    if (typeof expected !== 'object' || expected === null) {
      errors.push(`${at}: expected missing`)
      return
    }
    const exp = expected as Record<string, Expected>
    const missing = Object.keys(exp).filter((k) => questions[k] === undefined)
    if (missing.length > 0) {
      errors.push(`${at}: expected names unknown question ${missing.join(', ')}`)
      return
    }
    if (Object.keys(exp).length === 0) {
      errors.push(`${at}: expected is empty`)
      return
    }
    seen.add(id)
    examples.push({ id, input: input as DecisionInput, questions, expected: exp })
  })
  return { examples, errors }
}

/** Is the answer the expected one? */
export function isCorrect(answer: Answer, expected: Expected): boolean {
  if (answer.type === 'noul') return answer.value === expected
  if (answer.type === 'choice') return answer.value === expected
  return answer.level === expected
}

export interface Observation {
  example: string
  question: string
  type: 'noul' | 'choice' | 'score'
  correct: boolean
  confidence: number
}

export interface RunOutput {
  observations: Observation[]
  /** Examples whose request failed, and why. */
  failures: Array<{ example: string; error: string }>
  /** Questions a backend refused or left out. */
  missing: number
  latenciesMs: number[]
}

export interface RunOptions {
  concurrency?: number
  now?: () => number
  signal?: AbortSignal
}

export async function runEval(provider: DecisionProvider, examples: EvalExample[], options: RunOptions = {}): Promise<RunOutput> {
  const now = options.now ?? Date.now
  const out: RunOutput = { observations: [], failures: [], missing: 0, latenciesMs: [] }
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      const example = examples[i]
      if (example === undefined) return
      const asked: Questions = Object.fromEntries(Object.keys(example.expected).map((id) => [id, example.questions[id] as Questions[string]]))
      const started = now()
      try {
        const raw = await provider.decide(example.input, asked, options.signal)
        out.latenciesMs.push(now() - started)
        for (const [id, expected] of Object.entries(example.expected)) {
          const answer = raw.answers[id]
          const q = asked[id]
          if (answer === undefined || q === undefined) {
            out.missing += 1
            continue
          }
          out.observations.push({ example: example.id, question: id, type: q.type, correct: isCorrect(answer, expected), confidence: answer.confidence })
        }
      } catch (error) {
        out.failures.push({ example: example.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, examples.length)) }, worker))
  return out
}

export interface Bucket {
  from: number
  to: number
  n: number
  accuracy: number | null
  meanConfidence: number | null
}
export interface CurvePoint {
  threshold: number
  /** Share of answers that reach this confidence. */
  coverage: number
  /** Accuracy among those. */
  accuracy: number | null
  n: number
}
export interface Report {
  answers: number
  accuracy: number | null
  perQuestion: Record<string, { n: number; accuracy: number }>
  perType: Record<string, { n: number; accuracy: number }>
  buckets: Bucket[]
  /** Mean |bucket accuracy - bucket confidence|, weighted by size: 0 is perfectly calibrated. */
  calibrationError: number | null
  curve: CurvePoint[]
  recommended: { threshold: number | null; coverage: number | null; accuracy: number | null; note: string }
  /** The same rule applied to each question on its own: a question can be safe at a lower bar than the rest. */
  recommendedPerQuestion: Record<string, { threshold: number | null; coverage: number | null; accuracy: number | null }>
  latency: { n: number; meanMs: number | null; p50Ms: number | null; p95Ms: number | null }
  failures: number
  missing: number
}

/** The first bucket is everything under 0.5 (a choice or score can be less sure than a yes/no ever is). */
const BUCKET_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001]
export const CURVE_THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.99]

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length
}
function share(rows: Observation[]): number | null {
  return rows.length === 0 ? null : rows.filter((r) => r.correct).length / rows.length
}
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? null
}

export interface SummarizeOptions {
  /** The accuracy a threshold must reach among the answers it lets through. Default 0.95. */
  target?: number
  /** Fewest answers a threshold must let through to be believed. Default 10. */
  minAnswers?: number
}

export function summarize(run: RunOutput, options: SummarizeOptions = {}): Report {
  const target = options.target ?? 0.95
  const minAnswers = options.minAnswers ?? 10
  const obs = run.observations
  const perQuestion: Report['perQuestion'] = {}
  const perType: Report['perType'] = {}
  for (const key of new Set(obs.map((o) => o.question))) {
    const rows = obs.filter((o) => o.question === key)
    perQuestion[key] = { n: rows.length, accuracy: share(rows) ?? 0 }
  }
  for (const key of new Set(obs.map((o) => o.type))) {
    const rows = obs.filter((o) => o.type === key)
    perType[key] = { n: rows.length, accuracy: share(rows) ?? 0 }
  }
  const buckets: Bucket[] = []
  for (let i = 0; i < BUCKET_EDGES.length - 1; i++) {
    const from = BUCKET_EDGES[i] as number
    const to = BUCKET_EDGES[i + 1] as number
    const rows = obs.filter((o) => o.confidence >= from && o.confidence < to)
    buckets.push({ from, to: Math.min(1, to), n: rows.length, accuracy: share(rows), meanConfidence: mean(rows.map((r) => r.confidence)) })
  }
  const filled = buckets.filter((b) => b.n > 0 && b.accuracy !== null && b.meanConfidence !== null)
  const calibrationError = obs.length === 0 ? null : filled.reduce((sum, b) => sum + b.n * Math.abs((b.accuracy as number) - (b.meanConfidence as number)), 0) / obs.length
  const curve: CurvePoint[] = CURVE_THRESHOLDS.map((threshold) => {
    const rows = obs.filter((o) => o.confidence >= threshold)
    return { threshold, coverage: obs.length === 0 ? 0 : rows.length / obs.length, accuracy: share(rows), n: rows.length }
  })
  const pick = curve.find((p) => p.n >= minAnswers && p.accuracy !== null && p.accuracy >= target)
  const recommendedPerQuestion: Report['recommendedPerQuestion'] = {}
  for (const key of Object.keys(perQuestion)) {
    const rows = obs.filter((o) => o.question === key)
    const found = CURVE_THRESHOLDS.map((threshold) => {
      const kept = rows.filter((o) => o.confidence >= threshold)
      return { threshold, n: kept.length, coverage: kept.length / rows.length, accuracy: share(kept) }
    }).find((p) => p.n >= minAnswers && p.accuracy !== null && p.accuracy >= target)
    recommendedPerQuestion[key] = found === undefined ? { threshold: null, coverage: null, accuracy: null } : { threshold: found.threshold, coverage: found.coverage, accuracy: found.accuracy }
  }
  const recommended: Report['recommended'] =
    pick === undefined
      ? { threshold: null, coverage: null, accuracy: null, note: `No threshold reaches ${Math.round(target * 100)}% accuracy on at least ${minAnswers} answers. Keep the normal path for this question set, or reword the questions.` }
      : { threshold: pick.threshold, coverage: pick.coverage, accuracy: pick.accuracy, note: `The lowest threshold whose answers are at least ${Math.round(target * 100)}% right (${pick.n} answers let through).` }
  const sorted = [...run.latenciesMs].sort((a, b) => a - b)
  return {
    answers: obs.length,
    accuracy: share(obs),
    perQuestion,
    perType,
    buckets,
    calibrationError,
    curve,
    recommended,
    recommendedPerQuestion,
    latency: { n: sorted.length, meanMs: mean(sorted), p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95) },
    failures: run.failures.length,
    missing: run.missing,
  }
}

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
}

export function formatReport(report: Report): string {
  const lines: string[] = []
  lines.push(`Answers: ${report.answers}   accuracy: ${pct(report.accuracy)}   failed requests: ${report.failures}   missing answers: ${report.missing}`)
  lines.push(`Latency per request: p50 ${report.latency.p50Ms ?? 'n/a'} ms, p95 ${report.latency.p95Ms ?? 'n/a'} ms, mean ${report.latency.meanMs === null ? 'n/a' : Math.round(report.latency.meanMs)} ms (${report.latency.n} requests)`)
  lines.push('', 'Per question:')
  for (const [id, v] of Object.entries(report.perQuestion)) lines.push(`  ${id.padEnd(18)} n=${String(v.n).padEnd(4)} accuracy ${pct(v.accuracy)}`)
  lines.push('', 'Calibration (confidence bucket: how often right):')
  for (const b of report.buckets) lines.push(`  ${b.from.toFixed(2)}-${b.to.toFixed(2)}  n=${String(b.n).padEnd(4)} right ${pct(b.accuracy).padEnd(7)} mean confidence ${pct(b.meanConfidence)}`)
  lines.push(`  calibration error: ${report.calibrationError === null ? 'n/a' : report.calibrationError.toFixed(3)}`)
  lines.push('', 'Threshold curve (answers with confidence at least t):')
  for (const p of report.curve) lines.push(`  t=${p.threshold.toFixed(2)}  covers ${pct(p.coverage).padEnd(7)} accuracy ${pct(p.accuracy).padEnd(7)} n=${p.n}`)
  lines.push('', `Recommended threshold: ${report.recommended.threshold ?? 'none'}  ${report.recommended.note}`)
  for (const [id, r] of Object.entries(report.recommendedPerQuestion)) lines.push(`  ${id.padEnd(18)} alone: ${r.threshold ?? 'none'}${r.coverage === null ? '' : `  (covers ${pct(r.coverage)}, accuracy ${pct(r.accuracy)})`}`)
  return lines.join('\n')
}
