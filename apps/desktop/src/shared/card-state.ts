import { parseRequestSource, type RequestSource } from './request-source'
/**
 * What a card row says about whose it is and whether it still stands ("Agent acts for me on approvals", 23 Nov 2026).
 *
 * A card (an approval or a question) lives on a chat_item row; everything here is stored in its meta, so it syncs
 * with the row and every device, the phone included, reads the same thing:
 *   origin, asker      stamped by the app when the card was raised (the real tool call, who asked)
 *   lane, laneRule     the verdict of approval-policy at that moment (a record only: the answer path recomputes it)
 *   routedAt           handed to the main agent to answer for him (Acts for me was on, the lane was the agent's)
 *   escalatedAt/Why    brought back to him (the main agent judged it worth his eyes, it did not answer in time, or
 *                      the setting went off)
 *   closedAt/Reason    the card stopped standing by itself (run ended, answered elsewhere, replaced, already done)
 *   autoAnswer         the main agent answered it for him: kept as the "Answered for you" record
 *
 * Only `needsHim` puts a card in front of him.
 */
import { classifyCard, type Asker, type CardFacts, type CardOrigin, type Verdict } from './approval-policy'

/** How long the main agent has to answer a card routed to it before it is brought to him. */
export const ROUTE_TIMEOUT_MS = 10 * 60_000

export type AutoDecision = 'approve' | 'decline' | 'answer'
export type UndoKind = 'none' | 'retry' | 'reask' | 'revert-setting'

/** The record of a card the main agent answered for him. */
export interface AutoAnswer {
  at: number
  by: string
  decision: AutoDecision
  /** The answer text of a question. */
  answer?: string
  reason: string
  /** Who asked, as the list shows it. */
  asker: string
  /** What the card was about, one line. */
  summary: string
  undo: UndoKind
  /** For revert-setting: the values to put back. */
  revert?: Record<string, unknown>
  undone?: number
}

export type CardLike = { kind?: unknown; meta?: unknown; text?: unknown }

export function metaOfCard(row: CardLike): Record<string, unknown> {
  if (typeof row.meta !== 'string') return {}
  try {
    const value: unknown = JSON.parse(row.meta)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function isCardRow(row: CardLike): boolean {
  return row.kind === 'approval' || row.kind === 'question'
}

/** Decided or answered by someone (or something). */
export function isDecidedCard(row: CardLike): boolean {
  const meta = metaOfCard(row)
  if (row.kind === 'question') return textOf(meta['answer']) !== ''
  if (row.kind === 'approval') return textOf(meta['decision']) !== ''
  return false
}

export function closedOf(row: CardLike): { at: number; reason: string; why: string } | null {
  const meta = metaOfCard(row)
  const at = numberOf(meta['closedAt'])
  if (at === 0) return null
  return { at, reason: textOf(meta['closedReason']), why: textOf(meta['closedWhy']) }
}

/** Handed to the main agent and not yet answered, escalated or closed. */
export function isRoutedPending(row: CardLike): boolean {
  const meta = metaOfCard(row)
  return numberOf(meta['routedAt']) > 0 && numberOf(meta['escalatedAt']) === 0
}

/** A card that still stands: nobody decided it and it did not close itself. */
export function isLiveCard(row: CardLike): boolean {
  return isCardRow(row) && !isDecidedCard(row) && closedOf(row) === null
}

/** The only test for "is this on his Needs you panel": it stands, and it is not waiting on the main agent. */
export function needsHim(row: CardLike): boolean {
  return isLiveCard(row) && !isRoutedPending(row)
}

export function autoAnswerOf(row: CardLike): AutoAnswer | null {
  const raw = metaOfCard(row)['autoAnswer']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const decision = value['decision']
  if (decision !== 'approve' && decision !== 'decline' && decision !== 'answer') return null
  const undo = value['undo']
  return {
    at: numberOf(value['at']),
    by: textOf(value['by']) || 'main agent',
    decision,
    ...(textOf(value['answer']) === '' ? {} : { answer: textOf(value['answer']) }),
    reason: textOf(value['reason']),
    asker: textOf(value['asker']),
    summary: textOf(value['summary']),
    undo: undo === 'retry' || undo === 'reask' || undo === 'revert-setting' ? undo : 'none',
    ...(typeof value['revert'] === 'object' && value['revert'] !== null ? { revert: value['revert'] as Record<string, unknown> } : {}),
    ...(numberOf(value['undone']) > 0 ? { undone: numberOf(value['undone']) } : {}),
  }
}

// ---- stamping ------------------------------------------------------------------------------------------------

// Never silently drop authorization evidence: a bounded snapshot that omitted input
// carries a protected marker, so reclassification cannot authorize only a subset.
function clip(value: unknown, depth = 0): unknown {
  const omitted = { secretAuthorizationEvidenceOmitted: true }
  if (typeof value === 'string') return value.length > 1500 ? omitted : value
  if (Array.isArray(value)) return depth > 8 || value.length > 20 ? omitted : value.map((each) => clip(each, depth + 1))
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (depth > 8 || entries.length > 30) return omitted
    const out: Record<string, unknown> = {}
    for (const [key, each] of entries) out[key] = /password|secret|token|api.?key|authorization|cookie/i.test(key) ? '[redacted]' : clip(each, depth + 1)
    return out
  }
  return value
}

export interface StampInput {
  request?: RequestSource | undefined
  kind: 'approval' | 'question'
  asker: Asker
  origin?: CardOrigin | undefined
  summary: string
  details?: string
  options?: string[]
  /** Acts for me is on right now. */
  actsForMe: boolean
  /** This asker's next cards are his, whatever they are (an Undo withdrew its last answer). */
  holdForHim?: boolean
  now: number
}

/** The meta the app adds to a card it raises: the real tool call, who asked, the verdict and whether it is routed. */
export function stampCard(input: StampInput): Record<string, unknown> {
  const facts: CardFacts = {
    kind: input.kind,
    asker: input.asker,
    ...(input.request === undefined ? {} : { request: input.request }),
    summary: input.summary,
    ...(input.details === undefined ? {} : { details: input.details }),
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.origin === undefined ? {} : { origin: input.origin }),
  }
  const held = input.holdForHim === true
  const verdict: Verdict = held ? { lane: 'him', rule: 'undo-hold', why: 'Ayanda undid an earlier answer, so this one is his.' } : classifyCard(facts)
  return {
    asker: input.asker,
    ...(input.origin === undefined ? {} : { callOrigin: { tool: input.origin.tool, input: clip(input.origin.input) } }),
    lane: verdict.lane,
    laneRule: verdict.rule,
    laneWhy: verdict.why,
    ...(input.actsForMe && !held && (verdict.lane === 'agent' || (verdict.rule === 'unknown' && input.origin !== undefined && ['helper', 'project', 'routine'].includes(input.asker))) ? { routedAt: input.now } : {}),
  }
}

/** The facts the answer path recomputes the verdict from: the stamped origin and asker, never the lane that was stored. */
export function factsOfRow(row: CardLike & { text?: unknown }): CardFacts | null {
  if (row.kind !== 'approval' && row.kind !== 'question') return null
  const meta = metaOfCard(row)
  const asker = textOf(meta['asker'])
  const askers: Asker[] = ['main', 'helper', 'project', 'routine', 'device', 'unknown']
  const origin = meta['callOrigin']
  const parsedOrigin =
    typeof origin === 'object' && origin !== null && typeof (origin as Record<string, unknown>)['tool'] === 'string'
      ? { tool: String((origin as Record<string, unknown>)['tool']), input: (typeof (origin as Record<string, unknown>)['input'] === 'object' && (origin as Record<string, unknown>)['input'] !== null ? ((origin as Record<string, unknown>)['input'] as Record<string, unknown>) : {}) }
      : undefined
  const options = Array.isArray(meta['options']) ? meta['options'].filter((each): each is string => typeof each === 'string') : []
  return {
    kind: row.kind,
    asker: askers.includes(asker as Asker) ? (asker as Asker) : 'unknown',
    summary: textOf(meta['summary']) || textOf(row.text),
    details: textOf(meta['details']),
    options,
    ...(parsedOrigin === undefined ? {} : { origin: parsedOrigin }),
    ...(parseRequestSource(meta['request']) === null ? {} : { request: parseRequestSource(meta['request'])! }),
  }
}

/** Recomputed from the facts on the row; a row with none is the person's. */
export function verdictOfRow(row: CardLike & { text?: unknown }): Verdict {
  const facts = factsOfRow(row)
  if (facts === null) return { lane: 'him', rule: 'unknown', why: 'It is not a card.' }
  return classifyCard(facts)
}
