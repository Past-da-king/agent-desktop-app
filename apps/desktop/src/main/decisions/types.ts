/**
 * Decisions: the small, optional, generic "answer yes/no, pick one, or score" capability (docs/decisions.md).
 *
 * A decision model writes no text. It reads an input and answers each named question with a probability and a
 * confidence, in a few hundred milliseconds and for a tiny fraction of an LLM call. The app uses it only as a cheap
 * pre-check: when it is sure it skips or routes, otherwise the normal path runs unchanged.
 *
 * Nothing here names a person, a key, a model the app must use or a setup. Every backend is optional.
 */

export type BackendId = 'gemini' | 'jev' | 'openai' | 'llm'
export const BACKENDS: readonly BackendId[] = ['gemini', 'jev', 'openai', 'llm']

/** Each backend's own default model id. Defaults only: a build or a setting may name another. */
export const DEFAULT_MODELS: Record<BackendId, string> = {
  gemini: 'gemini-decision-1',
  jev: 'typesafe/jev-1.14',
  openai: 'gpt-6-luna',
  llm: '',
}

export type InputPart = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
/** What the questions are about: text, or text and images (base64 data, no data: prefix). */
export type DecisionInput = string | InputPart[]

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  /** Optional: what yes and no mean, for a question that could be read two ways. */
  trueDescription?: string
  falseDescription?: string
}
export interface ChoiceQuestion {
  type: 'choice'
  instructions: string
  /** Option id to what it means. 2 to 255. */
  options: Record<string, string>
}
export interface ScoreQuestion {
  type: 'score'
  instructions: string
  /** Ordered from lowest to highest, at least 2. */
  levels: string[]
}
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion
/** Question id to question. An id is 1 to 64 characters of letters, digits, _ and -. */
export type Questions = Record<string, Question>

export interface NoulAnswer {
  type: 'noul'
  value: boolean
  /** P(yes). */
  probability: number
  /** max(p, 1 - p): how sure the model is of its own top answer. It is NOT accuracy. */
  confidence: number
}
export interface ChoiceAnswer {
  type: 'choice'
  value: string
  probabilities: Record<string, number>
  confidence: number
}
export interface ScoreAnswer {
  type: 'score'
  /** The probability-weighted level, may fall between levels. */
  value: number
  /** The most likely level (index). */
  level: number
  probabilities: number[]
  confidence: number
}
export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer

/** What a backend returns: an answer per question it answered (a refused one is listed in `refused`). */
export interface RawDecision {
  answers: Record<string, Answer>
  refused: string[]
  inputTokens?: number
}

export interface DecisionProvider {
  readonly id: BackendId
  decide(input: DecisionInput, questions: Questions, signal?: AbortSignal): Promise<RawDecision>
}

export type DecisionErrorKind = 'auth' | 'rate' | 'blocked' | 'network' | 'timeout' | 'bad_reply' | 'bad_request' | 'unsupported' | 'server'

export class DecisionError extends Error {
  readonly kind: DecisionErrorKind
  readonly status: number
  constructor(kind: DecisionErrorKind, message: string, status = 0) {
    super(message)
    this.name = 'DecisionError'
    this.kind = kind
    this.status = status
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
