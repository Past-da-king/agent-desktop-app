/** What every backend adapter needs: question checks, the HTTP call, and the answer readers. */
import { DecisionError, type Answer, type ChoiceAnswer, type DecisionErrorKind, type FetchLike, type NoulAnswer, type Questions, type ScoreAnswer } from './types'

export const QUESTION_ID = /^[A-Za-z0-9_-]{1,64}$/

/** The problem with a question set, or null. Checked before any request, so a bad set never costs a call. */
export function questionsProblem(questions: Questions, max = 1000): string | null {
  const ids = Object.keys(questions)
  if (ids.length === 0) return 'Ask at least one question.'
  if (ids.length > max) return `At most ${max} questions at a time.`
  for (const id of ids) {
    if (!QUESTION_ID.test(id)) return `Question id "${id}" must be 1 to 64 letters, digits, _ or -.`
    const q = questions[id]
    if (q === undefined || typeof q.instructions !== 'string' || q.instructions.trim() === '') return `Question "${id}" needs instructions.`
    if (q.type === 'choice') {
      const n = Object.keys(q.options ?? {}).length
      if (n < 2 || n > 255) return `Question "${id}": a choice needs 2 to 255 options.`
    } else if (q.type === 'score') {
      if (!Array.isArray(q.levels) || q.levels.length < 2 || q.levels.length > 255) return `Question "${id}": a score needs 2 or more levels.`
    } else if (q.type !== 'noul') {
      return `Question "${id}": type must be noul, choice or score.`
    }
  }
  return null
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function noulAnswer(probability: number): NoulAnswer {
  const p = clamp01(probability)
  return { type: 'noul', value: p >= 0.5, probability: p, confidence: Math.max(p, 1 - p) }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** A confidence the reply gave, else the one its own probabilities imply. */
export function confidenceOf(value: unknown, fallback: number): number {
  const n = num(value)
  return clamp01(n ?? fallback)
}

/** Probabilities the way a backend may send them: a map of option to number, a list of numbers, or a list of {key, probability}. */
export function readProbabilities(raw: unknown, keys: string[]): Record<string, number> | null {
  const out: Record<string, number> = {}
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (typeof item === 'number') {
        const key = keys[index]
        if (key !== undefined) out[key] = item
      } else if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        const key = ['value', 'option', 'choice', 'id', 'label', 'name'].map((k) => o[k]).find((v) => typeof v === 'string' || typeof v === 'boolean')
        const p = num(o['probability']) ?? num(o['p'])
        if (key !== undefined && p !== null) out[String(key)] = p
      }
    })
  } else if (typeof raw === 'object' && raw !== null) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const p = num(value)
      if (p !== null) out[key] = p
    }
  }
  return Object.keys(out).length === 0 ? null : out
}

export function choiceAnswer(value: string, probabilities: Record<string, number>, confidence: unknown): ChoiceAnswer {
  const top = probabilities[value]
  return { type: 'choice', value, probabilities, confidence: confidenceOf(confidence, top ?? Math.max(...Object.values(probabilities))) }
}

export function scoreAnswer(value: number, probabilities: number[], confidence: unknown): ScoreAnswer {
  let level = 0
  probabilities.forEach((p, i) => {
    if (p > (probabilities[level] ?? 0)) level = i
  })
  return { type: 'score', value, level, probabilities, confidence: confidenceOf(confidence, probabilities[level] ?? 0) }
}

export function kindOfStatus(status: number): DecisionErrorKind {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate'
  if (status === 400 || status === 404 || status === 413 || status === 422) return 'bad_request'
  if (status === 402) return 'auth'
  return 'server'
}

function messageOf(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const error = (parsed as Record<string, unknown>)['error']
      if (typeof error === 'string') return error.slice(0, 200)
      if (typeof error === 'object' && error !== null) {
        const o = error as Record<string, unknown>
        const message = typeof o['message'] === 'string' ? o['message'] : ''
        const code = typeof o['code'] === 'string' ? ` (${o['code']})` : ''
        if (message !== '') return `${message}${code}`.slice(0, 200)
      }
    }
  } catch {
    // Not JSON: the status says enough.
  }
  return text.slice(0, 120)
}

/** POST JSON and read the JSON back. Every failure becomes a DecisionError with a kind the service can act on. */
export async function postJson(fetcher: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') throw new DecisionError('timeout', 'The decision model took too long.')
    throw new DecisionError('network', 'Could not reach the decision model.')
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    const message = messageOf(text)
    const blocked = response.status === 400 && /safety|prohibited|blocklist|content_blocked|image_safety/i.test(text)
    throw new DecisionError(blocked ? 'blocked' : kindOfStatus(response.status), message === '' ? `HTTP ${response.status}` : message, response.status)
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new DecisionError('bad_reply', 'The decision model sent a reply this app cannot read.')
}

export type { Answer }
