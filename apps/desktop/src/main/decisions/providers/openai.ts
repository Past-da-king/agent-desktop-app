/**
 * OpenAI Decisions API: POST https://api.openai.com/v1/decisions, Authorization: Bearer, model gpt-6-luna, body
 * { model, input, questions: [ { type: predicate | choice | score, name, instructions, choices | levels } ] }, 1 to 400
 * questions, answers returned as an array in the same order (predicate: probability; choice: choice, confidence,
 * probabilities [{value, probability}]; score: score, confidence, probabilities [{label, value, probability}]; refusal).
 * Source: developers.openai.com/api/reference/resources/decisions. Not exercised live (no key for it here).
 */
import { choiceAnswer, noulAnswer, postJson, questionsProblem, scoreAnswer } from '../shared'
import { DecisionError, DEFAULT_MODELS, type Answer, type DecisionInput, type DecisionProvider, type FetchLike, type Questions, type RawDecision } from '../types'

export const OPENAI_DECISIONS_URL = 'https://api.openai.com/v1/decisions'

export interface OpenAiProviderDeps {
  key: () => string | null
  fetchImpl: FetchLike
  model?: string
  url?: string
}

function openAiInput(input: DecisionInput): unknown {
  if (typeof input === 'string') return input
  return [
    {
      role: 'user',
      content: input.map((part) => (part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: `data:${part.mimeType};base64,${part.data}` })),
    },
  ]
}

export function openAiQuestions(questions: Questions): unknown[] {
  return Object.entries(questions).map(([name, q]) => {
    if (q.type === 'noul') {
      const extra = [q.trueDescription !== undefined ? `Yes means: ${q.trueDescription}` : '', q.falseDescription !== undefined ? `No means: ${q.falseDescription}` : ''].filter((s) => s !== '')
      return { type: 'predicate', name, instructions: [q.instructions, ...extra].join(' ') }
    }
    if (q.type === 'choice') return { type: 'choice', name, instructions: q.instructions, choices: Object.entries(q.options).map(([value, description]) => ({ value, ...(description === '' ? {} : { description }) })) }
    return { type: 'score', name, instructions: q.instructions, levels: q.levels.map((description, i) => ({ label: String(i), description })) }
  })
}

export function openAiProvider(deps: OpenAiProviderDeps): DecisionProvider {
  return {
    id: 'openai',
    async decide(input: DecisionInput, questions: Questions, signal?: AbortSignal): Promise<RawDecision> {
      const problem = questionsProblem(questions, 400)
      if (problem !== null) throw new DecisionError('bad_request', problem)
      const key = deps.key()
      if (key === null || key.trim() === '') throw new DecisionError('auth', 'No OpenAI key.')
      const body = await postJson(
        deps.fetchImpl,
        deps.url ?? OPENAI_DECISIONS_URL,
        { authorization: `Bearer ${key.trim()}` },
        { model: deps.model ?? DEFAULT_MODELS.openai, input: openAiInput(input), questions: openAiQuestions(questions) },
        signal,
      )
      const list = body['answers']
      if (!Array.isArray(list)) throw new DecisionError('bad_reply', 'The reply had no answers.')
      const ids = Object.keys(questions)
      const answers: Record<string, Answer> = {}
      const refused: string[] = []
      list.forEach((item, index) => {
        const o = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
        const id = typeof o['name'] === 'string' && ids.includes(o['name']) ? o['name'] : ids[index]
        if (id === undefined) return
        const q = questions[id]
        if (q === undefined || o['type'] === 'refusal') {
          refused.push(id)
          return
        }
        if (q.type === 'noul' && typeof o['probability'] === 'number') {
          answers[id] = noulAnswer(o['probability'])
        } else if (q.type === 'choice' && Array.isArray(o['probabilities'])) {
          const probs: Record<string, number> = {}
          for (const row of o['probabilities']) {
            const r = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {}
            if ((typeof r['value'] === 'string' || typeof r['value'] === 'boolean') && typeof r['probability'] === 'number') probs[String(r['value'])] = r['probability']
          }
          const top = typeof o['choice'] === 'string' || typeof o['choice'] === 'boolean' ? String(o['choice']) : null
          if (top === null || Object.keys(probs).length === 0) refused.push(id)
          else answers[id] = choiceAnswer(top, probs, o['confidence'])
        } else if (q.type === 'score' && Array.isArray(o['probabilities']) && typeof o['score'] === 'number') {
          const probs = q.levels.map((_, i) => {
            const row = o['probabilities'] as unknown[]
            const found = row.find((r) => typeof r === 'object' && r !== null && ((r as Record<string, unknown>)['label'] === String(i) || (r as Record<string, unknown>)['value'] === i))
            const p = typeof found === 'object' && found !== null ? (found as Record<string, unknown>)['probability'] : 0
            return typeof p === 'number' ? p : 0
          })
          answers[id] = scoreAnswer(o['score'], probs, o['confidence'])
        } else {
          refused.push(id)
        }
      })
      for (const id of ids) if (answers[id] === undefined && !refused.includes(id)) refused.push(id)
      const usage = body['usage']
      const used = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>)['input_tokens'] : undefined
      return { answers, refused, ...(typeof used === 'number' ? { inputTokens: used } : {}) }
    },
  }
}
