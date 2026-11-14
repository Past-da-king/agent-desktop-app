/**
 * The shape Gemini's Decisions API and Jev (TypeSafe, through OpenRouter or AI/ML API) share: questions as an object
 * keyed by id, each { type: noul | choice | score, instructions, criteria }, and answers keyed by the same ids.
 */
import { choiceAnswer, noulAnswer, readProbabilities, scoreAnswer } from '../shared'
import { DecisionError, type Answer, type DecisionInput, type Questions, type RawDecision } from '../types'

export function keyedQuestions(questions: Questions): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      const criteria = q.trueDescription !== undefined || q.falseDescription !== undefined ? { criteria: { true_description: q.trueDescription ?? '', false_description: q.falseDescription ?? '' } } : {}
      out[id] = { type: 'noul', instructions: q.instructions, ...criteria }
    } else if (q.type === 'choice') {
      out[id] = { type: 'choice', instructions: q.instructions, criteria: q.options }
    } else {
      out[id] = { type: 'score', instructions: q.instructions, criteria: q.levels }
    }
  }
  return out
}

/** Gemini input blocks: a string stays a string; parts become { type: text | image }. */
export function geminiInput(input: DecisionInput): unknown {
  if (typeof input === 'string') return input
  return input.map((part) => (part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', data: part.data, mime_type: part.mimeType, resolution: 'low' }))
}

/** OpenRouter state parts: images as image_url data URLs. */
export function openRouterState(input: DecisionInput): unknown {
  if (typeof input === 'string') return input
  return input.map((part) => (part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${part.data}` } }))
}

export function readKeyedAnswers(body: Record<string, unknown>, questions: Questions): RawDecision {
  const raw = body['answers']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DecisionError('bad_reply', 'The reply had no answers.')
  const answers: Record<string, Answer> = {}
  const refused: string[] = []
  for (const [id, q] of Object.entries(questions)) {
    const a = (raw as Record<string, unknown>)[id]
    if (typeof a !== 'object' || a === null) {
      refused.push(id)
      continue
    }
    const o = a as Record<string, unknown>
    if (o['type'] === 'refusal') {
      refused.push(id)
      continue
    }
    if (q.type === 'noul') {
      const p = [o['noul'], o['probability'], o['value']].find((v): v is number => typeof v === 'number')
      if (p === undefined) {
        refused.push(id)
        continue
      }
      const base = noulAnswer(p)
      answers[id] = typeof o['confidence'] === 'number' ? { ...base, confidence: Math.min(1, Math.max(0, o['confidence'])) } : base
    } else if (q.type === 'choice') {
      const keys = Object.keys(q.options)
      const probs = readProbabilities(o['probabilities'], keys)
      const choice = typeof o['choice'] === 'string' ? o['choice'] : null
      if (choice === null || probs === null) {
        refused.push(id)
        continue
      }
      answers[id] = choiceAnswer(choice, probs, o['confidence'])
    } else {
      const probs = Array.isArray(o['probabilities']) ? o['probabilities'].filter((v): v is number => typeof v === 'number') : (() => {
        const mapped = readProbabilities(o['probabilities'], q.levels.map((_, i) => String(i)))
        return mapped === null ? [] : q.levels.map((_, i) => mapped[String(i)] ?? 0)
      })()
      const score = typeof o['score'] === 'number' ? o['score'] : null
      if (score === null || probs.length === 0) {
        refused.push(id)
        continue
      }
      answers[id] = scoreAnswer(score, probs, o['confidence'])
    }
  }
  const usage = body['usage']
  const tokens = typeof usage === 'object' && usage !== null ? (usage as Record<string, unknown>) : {}
  const used = [tokens['total_input_tokens'], tokens['input_tokens']].find((v): v is number => typeof v === 'number')
  return { answers, refused, ...(used === undefined ? {} : { inputTokens: used }) }
}
