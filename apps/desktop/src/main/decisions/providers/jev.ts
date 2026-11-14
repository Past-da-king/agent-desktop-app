/**
 * Jev (TypeSafe AI). Reached through OpenRouter's alpha Decisions endpoint: POST https://openrouter.ai/api/alpha/decisions,
 * Authorization: Bearer, body { model: 'typesafe/jev-1.14', state, questions: { id: { type, instructions, criteria } } },
 * answers keyed by id. The same envelope is served by AI/ML API (/v1/decisions) and Eden AI, so the address is a setting.
 * Built from the OpenRouter reference; not exercised live (no Jev key here), so the noul field name is read leniently.
 */
import { postJson, questionsProblem } from '../shared'
import { DecisionError, DEFAULT_MODELS, type DecisionInput, type DecisionProvider, type FetchLike, type Questions, type RawDecision } from '../types'
import { keyedQuestions, openRouterState, readKeyedAnswers } from './keyed'

export const JEV_DEFAULT_URL = 'https://openrouter.ai/api/alpha/decisions'

export interface JevProviderDeps {
  key: () => string | null
  fetchImpl: FetchLike
  model?: string
  url?: string
}

export function jevProvider(deps: JevProviderDeps): DecisionProvider {
  return {
    id: 'jev',
    async decide(input: DecisionInput, questions: Questions, signal?: AbortSignal): Promise<RawDecision> {
      const problem = questionsProblem(questions, 1000)
      if (problem !== null) throw new DecisionError('bad_request', problem)
      const key = deps.key()
      if (key === null || key.trim() === '') throw new DecisionError('auth', 'No Jev (OpenRouter) key.')
      const body = await postJson(
        deps.fetchImpl,
        deps.url ?? JEV_DEFAULT_URL,
        { authorization: `Bearer ${key.trim()}` },
        { model: deps.model ?? DEFAULT_MODELS.jev, state: openRouterState(input), questions: keyedQuestions(questions) },
        signal,
      )
      return readKeyedAnswers(body, questions)
    },
  }
}
