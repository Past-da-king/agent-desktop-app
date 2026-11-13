/**
 * Google Decisions API (gemini-decision-1, 11 Nov 2026): POST https://generativelanguage.googleapis.com/v1beta/decisions,
 * header x-goog-api-key, body { model, input, questions: { id: { type, instructions, criteria } } }. Answers come back
 * keyed by the same ids; only input tokens are billed. Docs: aistudio.google.com/docs/decisions-api.
 */
import { postJson, questionsProblem } from '../shared'
import { DecisionError, DEFAULT_MODELS, type DecisionInput, type DecisionProvider, type FetchLike, type Questions, type RawDecision } from '../types'
import { geminiInput, keyedQuestions, readKeyedAnswers } from './keyed'

export const GEMINI_DECISIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/decisions'

export interface GeminiProviderDeps {
  key: () => string | null
  fetchImpl: FetchLike
  model?: string
  url?: string
}

export function geminiProvider(deps: GeminiProviderDeps): DecisionProvider {
  return {
    id: 'gemini',
    async decide(input: DecisionInput, questions: Questions, signal?: AbortSignal): Promise<RawDecision> {
      const problem = questionsProblem(questions, 1000)
      if (problem !== null) throw new DecisionError('bad_request', problem)
      const key = deps.key()
      if (key === null || key.trim() === '') throw new DecisionError('auth', 'No Gemini key.')
      const body = await postJson(
        deps.fetchImpl,
        deps.url ?? GEMINI_DECISIONS_URL,
        { 'x-goog-api-key': key.trim() },
        { model: deps.model ?? DEFAULT_MODELS.gemini, input: geminiInput(input), questions: keyedQuestions(questions) },
        signal,
      )
      return readKeyedAnswers(body, questions)
    },
  }
}
