/**
 * The decision service: one place that decides whether a decision model may be asked, asks the chosen backend, and says
 * which path answered. Off by default. Off, no key, an error, a timeout or a low confidence all fall back to the normal
 * path (the app's own model, or the caller's own work): a decision never makes anything fail that worked without it.
 */
import { geminiProvider } from './providers/gemini'
import { jevProvider } from './providers/jev'
import { llmProvider, type Complete } from './providers/llm'
import { openAiProvider } from './providers/openai'
import { DecisionError, type Answer, type BackendId, type DecisionInput, type DecisionProvider, type FetchLike, type Questions } from './types'

export interface DecisionSettings {
  enabled: boolean
  backend: BackendId
  /** 0.5 to 0.99: an answer counts only when its confidence is at least this. */
  threshold: number
}

export interface DecisionKeys {
  gemini: () => string | null
  openai: () => string | null
  jev: () => string | null
}

export interface DecisionServiceDeps {
  settings: () => DecisionSettings
  keys: DecisionKeys
  /** The HTTP call; tests pass a mock. Default: the global fetch. */
  fetchImpl?: FetchLike
  /** The app's own model for one question set (Runner.oneShot). Absent: there is no LLM fallback. */
  complete?: () => Complete | null
  log?: (message: string, fields: Record<string, string | number | boolean>) => void
  /** How long one decision call may take before the normal path runs instead. Default 5 s. */
  timeoutMs?: number
  now?: () => number
  /** Tests: use these instead of the real adapters. */
  providers?: Partial<Record<BackendId, DecisionProvider>>
  models?: Partial<Record<BackendId, string>>
  urls?: Partial<Record<BackendId, string>>
}

export type DecisionPath = 'decision' | 'decision+llm' | 'llm' | 'none'

export type ResolvedAnswer = Answer & {
  /** Who produced this answer. */
  via: 'decision' | 'llm'
  /** Its confidence reached the threshold (an LLM answer, the normal path, always counts). */
  confident: boolean
}

export interface DecisionResult {
  path: DecisionPath
  /** The backend that answered, or null when none did. */
  provider: BackendId | null
  latencyMs: number
  /** Why the normal path ran instead: off, no_key, error:<kind>, low_confidence, no_llm. */
  reason: string
  threshold: number
  answers: Record<string, ResolvedAnswer>
  /** Every asked question has a confident answer. False means the caller does its normal work. */
  allConfident: boolean
}

export interface DecideOptions {
  /** Overrides the setting for this one call. */
  threshold?: number
  /** 'llm' (default): ask the app's own model for what the decision model was not sure of. 'none': leave it to the caller. */
  fallback?: 'llm' | 'none'
  signal?: AbortSignal
}

/** From the live eval: at 0.9 every answer it let through was right (100 of 100); see docs/decisions.md. */
export const DEFAULT_THRESHOLD = 0.9
export const DEFAULT_TIMEOUT_MS = 5000

function globalFetch(): FetchLike {
  return (url, init) => fetch(url, init)
}

function clampThreshold(value: number): number {
  return Number.isFinite(value) ? Math.min(0.99, Math.max(0.5, value)) : DEFAULT_THRESHOLD
}

export class DecisionService {
  private readonly deps: DecisionServiceDeps

  constructor(deps: DecisionServiceDeps) {
    this.deps = deps
  }

  /** True when the toggle is on. Callers check this first so an off app does no work at all. */
  enabled(): boolean {
    return this.deps.settings().enabled
  }

  settings(): DecisionSettings {
    const s = this.deps.settings()
    return { ...s, threshold: clampThreshold(s.threshold) }
  }

  private provider(id: BackendId): DecisionProvider | null {
    const given = this.deps.providers?.[id]
    if (given !== undefined) return given
    const fetchImpl = this.deps.fetchImpl ?? globalFetch()
    const model = this.deps.models?.[id]
    const url = this.deps.urls?.[id]
    const extra = { ...(model === undefined ? {} : { model }), ...(url === undefined ? {} : { url }) }
    if (id === 'gemini') return geminiProvider({ key: this.deps.keys.gemini, fetchImpl, ...extra })
    if (id === 'jev') return jevProvider({ key: this.deps.keys.jev, fetchImpl, ...extra })
    if (id === 'openai') return openAiProvider({ key: this.deps.keys.openai, fetchImpl, ...extra })
    const complete = this.deps.complete?.() ?? null
    return complete === null ? null : llmProvider({ complete })
  }

  private log(message: string, fields: Record<string, string | number | boolean>): void {
    try {
      this.deps.log?.(message, fields)
    } catch {
      // A log that cannot be written must not change an answer.
    }
  }

  async decide(input: DecisionInput, questions: Questions, options: DecideOptions = {}): Promise<DecisionResult> {
    const now = this.deps.now ?? Date.now
    const started = now()
    const s = this.settings()
    const threshold = options.threshold === undefined ? s.threshold : clampThreshold(options.threshold)
    const ids = Object.keys(questions)
    const done = (path: DecisionPath, provider: BackendId | null, reason: string, answers: Record<string, ResolvedAnswer>): DecisionResult => {
      const allConfident = ids.length > 0 && ids.every((id) => answers[id]?.confident === true)
      const result: DecisionResult = { path, provider, latencyMs: now() - started, reason, threshold, answers, allConfident }
      this.log('Decision', { path, provider: provider ?? '', reason, questions: ids.length, latencyMs: result.latencyMs, allConfident })
      return result
    }

    // Off: nothing is read, nothing is sent.
    if (!s.enabled) return done('none', null, 'off', {})

    const signal = options.signal === undefined ? AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) : AbortSignal.any([options.signal, AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS)])
    const primary = this.provider(s.backend)
    if (primary === null) return done('none', null, s.backend === 'llm' ? 'no_llm' : 'no_key', {})

    const llmFallback = async (reason: string, only: string[], answers: Record<string, ResolvedAnswer>, via: DecisionPath): Promise<DecisionResult> => {
      const llm = s.backend === 'llm' ? null : this.provider('llm')
      if (options.fallback === 'none' || llm === null || only.length === 0) return done(via === 'decision' ? 'decision' : 'none', via === 'decision' ? s.backend : null, reason, answers)
      const subset: Questions = Object.fromEntries(only.map((id) => [id, questions[id] as Questions[string]]))
      try {
        const raw = await llm.decide(input, subset, options.signal)
        const merged = { ...answers }
        for (const [id, a] of Object.entries(raw.answers)) merged[id] = { ...a, via: 'llm', confident: true }
        return done(via === 'decision' ? 'decision+llm' : 'llm', via === 'decision' ? s.backend : 'llm', reason, merged)
      } catch (error) {
        return done(via === 'decision' ? 'decision' : 'none', via === 'decision' ? s.backend : null, `${reason};llm_error:${error instanceof DecisionError ? error.kind : 'unknown'}`, answers)
      }
    }

    // The LLM backend is the normal path already; there is nothing to fall back to.
    if (s.backend === 'llm') {
      try {
        const raw = await primary.decide(input, questions, signal)
        const answers: Record<string, ResolvedAnswer> = {}
        for (const [id, a] of Object.entries(raw.answers)) answers[id] = { ...a, via: 'llm', confident: true }
        return done('llm', 'llm', raw.refused.length > 0 ? 'partial' : 'ok', answers)
      } catch (error) {
        return done('none', null, `error:${error instanceof DecisionError ? error.kind : 'unknown'}`, {})
      }
    }

    let raw
    try {
      raw = await primary.decide(input, questions, signal)
    } catch (error) {
      const kind = error instanceof DecisionError ? error.kind : 'unknown'
      return llmFallback(`error:${kind}`, ids, {}, 'none')
    }
    const answers: Record<string, ResolvedAnswer> = {}
    const unsure: string[] = []
    for (const id of ids) {
      const a = raw.answers[id]
      if (a === undefined) {
        unsure.push(id)
        continue
      }
      const confident = a.confidence >= threshold
      answers[id] = { ...a, via: 'decision', confident }
      if (!confident) unsure.push(id)
    }
    if (unsure.length === 0) return done('decision', s.backend, 'ok', answers)
    return llmFallback('low_confidence', unsure, answers, 'decision')
  }
}
