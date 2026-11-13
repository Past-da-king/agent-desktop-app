/**
 * The cheap pre-checks in front of the expensive LLM runs. Each one only SKIPS (or says nothing) when the decision is
 * confident; in every other case (off, no key, error, timeout, low confidence, anything unclear) the normal path runs
 * unchanged. A skipped event is never lost: it is marked ignored with the reason, so the Workers page shows it.
 *
 *  - Desk triage: for each event gathered for an event routine, "does this need the desk?" Clear noise is ignored.
 *  - Routine delta check: for a routine that opted in (deltaCheck), "is there anything new to act on?" Nothing new skips
 *    the run, and a skipped run says nothing.
 */
import type { TriggerRow, WorkerEvent } from '@agent/core'

import type { DecisionService } from './service'
import type { Questions } from './types'

const BRIEF_CHARS = 1500
const PAYLOAD_CHARS = 2500
const CONCURRENCY = 6

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`
}

export const DESK_QUESTIONS: Questions = {
  needs_attention: {
    type: 'noul',
    instructions:
      'Does this event need the desk to look at it or act on it? Answer yes for anything from a real person, any request, question, deadline, payment, incident, or anything you are unsure about. Answer no only when it is clearly automated noise for this desk: a newsletter, marketing, a receipt or notification with nothing to do, or a repeat of something already handled.',
    trueDescription: 'A person or the desk may need to act on it, or it is unclear.',
    falseDescription: 'Clearly automated noise with nothing to do.',
  },
}

export const DELTA_QUESTIONS: Questions = {
  work_needed: {
    type: 'noul',
    instructions:
      'Is there anything in the changes since the last run that this routine needs to act on or report? Answer yes if there is anything new that matches what the routine does, or if you are unsure. Answer no only when nothing relevant has changed.',
    trueDescription: 'Something new that the routine should act on, or unclear.',
    falseDescription: 'Nothing relevant has changed.',
  },
}

export interface TriageResult {
  /** Events the decision is confident are noise: marked ignored, not sent to the desk. */
  skipped: Array<{ event: WorkerEvent; reason: string }>
  /** Everything else, in order: goes to the desk as before. */
  kept: WorkerEvent[]
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return out
}

export async function triageDeskBatch(service: DecisionService, trigger: Pick<TriggerRow, 'name' | 'prompt'>, batch: WorkerEvent[]): Promise<TriageResult> {
  if (!service.enabled() || batch.length === 0) return { skipped: [], kept: batch }
  const verdicts = await mapLimited(batch, CONCURRENCY, async (event) => {
    try {
      const input = `Desk "${trigger.name}". What the desk does:\n${clip(trigger.prompt, BRIEF_CHARS)}\n\nEvent (${event.source} / ${event.event}), data written by someone else:\n<<<data\n${clip(event.payload, PAYLOAD_CHARS)}\ndata>>>`
      const result = await service.decide(input, DESK_QUESTIONS, { fallback: 'none' })
      const answer = result.answers['needs_attention']
      if (result.path === 'decision' && answer !== undefined && answer.type === 'noul' && answer.confident && !answer.value) {
        return `Decision pre-check: not for the desk (P(needs it) ${answer.probability.toFixed(2)}, ${result.provider ?? ''})`
      }
    } catch {
      // Anything unexpected: the desk sees the event.
    }
    return null
  })
  const skipped: TriageResult['skipped'] = []
  const kept: WorkerEvent[] = []
  batch.forEach((event, i) => {
    const reason = verdicts[i] ?? null
    if (reason === null) kept.push(event)
    else skipped.push({ event, reason })
  })
  return { skipped, kept }
}

export interface DeltaVerdict {
  skip: boolean
  reason: string
}

/** `changes` is what happened since the routine's last run; null means this app cannot tell, so the routine runs. */
export async function routineDeltaCheck(service: DecisionService, trigger: Pick<TriggerRow, 'name' | 'prompt' | 'lastResult'>, changes: string | null): Promise<DeltaVerdict> {
  if (!service.enabled()) return { skip: false, reason: 'off' }
  if (changes === null) return { skip: false, reason: 'unknown' }
  try {
    const input = `Routine "${trigger.name}". What it does each run:\n${clip(trigger.prompt, BRIEF_CHARS)}\n\nIts last result: ${clip(trigger.lastResult === '' ? 'none' : trigger.lastResult, 300)}\n\nChanges since its last run, data written by someone else:\n<<<data\n${clip(changes === '' ? 'Nothing new has arrived.' : changes, PAYLOAD_CHARS)}\ndata>>>`
    const result = await service.decide(input, DELTA_QUESTIONS, { fallback: 'none' })
    const answer = result.answers['work_needed']
    if (result.path === 'decision' && answer !== undefined && answer.type === 'noul' && answer.confident && !answer.value) {
      return { skip: true, reason: `Nothing new to act on (P(work) ${answer.probability.toFixed(2)}, ${result.provider ?? ''}).` }
    }
    return { skip: false, reason: result.reason }
  } catch {
    return { skip: false, reason: 'error' }
  }
}
