/**
 * decide: any agent, desk or routine can ask a decision model a few yes/no, choice or score questions about some text
 * (or text with images) and get probabilities and a confidence back in well under a second, instead of a written answer.
 */
import type { JsonObject, Tool } from '@agent/core'

import type { DecisionService } from './service'
import type { Question, Questions } from './types'

const GUIDE =
  'Ask a decision model a few questions about some text and get probabilities back, fast and cheap, instead of writing the answer yourself. ' +
  'Each question: id, type (noul = yes/no, choice, score), instructions (one clear question; vague ones come back unsure), and for a choice options {id: what it means} (add a catch-all option), for a score levels (ordered, lowest first). ' +
  'The result says which path answered (decision or llm or none), and per question the value, the probabilities, the confidence and whether it is confident. ' +
  'Confidence is how sure the model is of its own top answer, not how often it is right. If it is off or not confident (path none, or confident false) decide it yourself. Never use it for anything that cannot be undone on its own.'

const QUESTION_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    id: { type: 'string', description: '1 to 64 letters, digits, _ or -' },
    type: { type: 'string', enum: ['noul', 'choice', 'score'] },
    instructions: { type: 'string', description: 'The question, in one clear sentence' },
    options: { type: 'object', description: 'choice only: option id to what it means', additionalProperties: { type: 'string' } },
    levels: { type: 'array', items: { type: 'string' }, description: 'score only: ordered level descriptions, lowest first' },
    true_description: { type: 'string', description: 'noul only, optional: what yes means' },
    false_description: { type: 'string', description: 'noul only, optional: what no means' },
  },
  required: ['id', 'type', 'instructions'],
}

export function parseQuestions(raw: unknown): Questions | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'questions must be a list with at least one question.'
  const out: Questions = {}
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return 'Each question must be an object.'
    const o = item as Record<string, unknown>
    const id = typeof o['id'] === 'string' ? o['id'].trim() : ''
    const instructions = typeof o['instructions'] === 'string' ? o['instructions'].trim() : ''
    if (id === '') return 'Every question needs an id.'
    if (id in out) return `Question id "${id}" is used twice.`
    let q: Question
    if (o['type'] === 'noul') {
      q = {
        type: 'noul',
        instructions,
        ...(typeof o['true_description'] === 'string' && o['true_description'] !== '' ? { trueDescription: o['true_description'] } : {}),
        ...(typeof o['false_description'] === 'string' && o['false_description'] !== '' ? { falseDescription: o['false_description'] } : {}),
      }
    } else if (o['type'] === 'choice') {
      const options = typeof o['options'] === 'object' && o['options'] !== null && !Array.isArray(o['options']) ? (o['options'] as Record<string, unknown>) : null
      if (options === null) return `Question "${id}": a choice needs options.`
      q = { type: 'choice', instructions, options: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, typeof v === 'string' ? v : ''])) }
    } else if (o['type'] === 'score') {
      if (!Array.isArray(o['levels'])) return `Question "${id}": a score needs levels.`
      q = { type: 'score', instructions, levels: o['levels'].map((v) => String(v)) }
    } else {
      return `Question "${id}": type must be noul, choice or score.`
    }
    out[id] = q
  }
  return out
}

export function decideTool(service: () => DecisionService | null): Tool {
  return {
    spec: {
      name: 'decide',
      description: GUIDE,
      schema: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'The text the questions are about' },
          questions: { type: 'array', items: QUESTION_SCHEMA, description: 'One to a few questions' },
          threshold: { type: 'number', description: 'Optional: confidence needed, 0.5 to 0.99 (default: the setting)' },
          fallback: { type: 'boolean', description: 'When not confident, ask the app\'s own model (default true)' },
        },
        required: ['input', 'questions'],
      },
    },
    run: async (input) => {
      const svc = service()
      if (svc === null || !svc.enabled()) {
        return JSON.stringify({ path: 'none', reason: 'off', note: 'Decisions are off (Settings, Agents and helpers). Answer the questions yourself.' })
      }
      const text = typeof input['input'] === 'string' ? input['input'] : ''
      if (text.trim() === '') return JSON.stringify({ error: 'input is empty.' })
      const questions = parseQuestions(input['questions'])
      if (typeof questions === 'string') return JSON.stringify({ error: questions })
      const result = await svc.decide(text, questions, {
        ...(typeof input['threshold'] === 'number' ? { threshold: input['threshold'] } : {}),
        fallback: input['fallback'] === false ? 'none' : 'llm',
      })
      return JSON.stringify({
        path: result.path,
        provider: result.provider,
        latencyMs: result.latencyMs,
        reason: result.reason,
        threshold: result.threshold,
        allConfident: result.allConfident,
        answers: result.answers,
      })
    },
  }
}
