/**
 * A Live voice call is written into the main chat AS IT HAPPENS (17 Nov 2026: the main agent only ever saw the hand-off's
 * paraphrase, so "what did I ask on the call?" had no answer). One `call` row per session (shown as one collapsed "Live call"
 * block, hand-offs folded inside, never user bubbles); every turn the phone finalises is merged into that row by its index, and
 * the final voice.callSave replaces the same lines instead of adding a second row. The main agent reads the recent calls in
 * full on its next turn (liveCallSection).
 */
import type { ChatItem } from '@agent/core'

export interface LiveTurn {
  session: string
  startedAt: number
  index: number
  who: 'you' | 'agent'
  text: string
  at: number
}

export interface CallLine {
  who: 'you' | 'agent'
  text: string
  at: number
}

const MAX_TURN = 8_000
const MAX_TURNS = 2_000

/** A turn from the wire, checked: the device is trusted to be paired, not to send well-formed data. */
export function liveTurn(value: unknown): LiveTurn {
  if (typeof value !== 'object' || value === null) throw new Error('turn must be an object')
  const v = value as Record<string, unknown>
  const session = typeof v['session'] === 'string' ? v['session'].trim().slice(0, 80) : ''
  if (session === '') throw new Error('session must be an id')
  const index = Number(v['index'])
  if (!Number.isInteger(index) || index < 0 || index >= MAX_TURNS) throw new Error('index must be a position')
  const who = v['who']
  if (who !== 'you' && who !== 'agent') throw new Error('who must be you or agent')
  const text = typeof v['text'] === 'string' ? v['text'].slice(0, MAX_TURN) : ''
  if (text.trim() === '') throw new Error('text must not be empty')
  const startedAt = Number(v['startedAt'])
  if (!Number.isFinite(startedAt) || startedAt <= 0) throw new Error('startedAt must be a time')
  const at = Number.isFinite(Number(v['at'])) ? Number(v['at']) : startedAt
  return { session, startedAt, index, who, text, at }
}

function parse(meta: string): Record<string, unknown> {
  try {
    const value = JSON.parse(meta) as unknown
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The session a call row belongs to ('' when it is not a Live call). */
export function sessionOf(row: ChatItem): string {
  if (row.kind !== 'call') return ''
  const meta = parse(row.meta)
  return meta['source'] === 'live' && typeof meta['session'] === 'string' ? meta['session'] : ''
}

/** The call's meta with this turn merged in by its index (a re-send of the same index updates it). Lines stay in order. */
export function mergeTurn(meta: string, turn: LiveTurn): Record<string, unknown> {
  const old = parse(meta)
  const turns = typeof old['turns'] === 'object' && old['turns'] !== null ? { ...(old['turns'] as Record<string, CallLine>) } : {}
  turns[String(turn.index)] = { who: turn.who, text: turn.text, at: turn.at }
  const lines = Object.keys(turns)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => turns[String(index)] as CallLine)
  const endedAt = Math.max(turn.at, typeof old['endedAt'] === 'number' ? old['endedAt'] : 0)
  return {
    visuals: 0,
    handoffs: 0,
    ...old,
    device: true,
    source: 'live',
    session: turn.session,
    durationMs: Math.max(0, endedAt - turn.startedAt),
    endedAt,
    turns,
    lines,
  }
}

/** How many characters of calls the main agent is given, and how many calls. */
export const CALL_CHARS = 6_000
export const CALL_COUNT = 3
/** A call older than this is not background any more. */
export const CALL_FRESH_MS = 24 * 3_600_000

/**
 * What the main agent reads about his recent Live calls, in full, oldest call first (rows are newest first). The words are
 * his and the voice's, as transcribed: the voice may have heard a name wrong, so the agent resolves names from memory.
 */
export function liveCallSection(rows: ChatItem[], now: number): string {
  const calls = rows
    .filter((row) => sessionOf(row) !== '' && now - row.createdAt <= CALL_FRESH_MS)
    .slice(0, CALL_COUNT)
    .reverse()
  if (calls.length === 0) return ''
  const blocks: string[] = []
  for (const call of calls) {
    const meta = parse(call.meta)
    const lines = (Array.isArray(meta['lines']) ? meta['lines'] : []) as CallLine[]
    const when = new Date(call.createdAt).toISOString().slice(0, 16).replace('T', ' ')
    const body = lines
      .filter((line) => typeof line.text === 'string' && line.text.trim() !== '')
      .map((line) => `${line.who === 'you' ? 'He said' : 'The voice said'}: ${line.text.replace(/\s+/g, ' ').trim()}`)
    blocks.push(`Live call at ${when} UTC (session ${String(meta['session'])}):\n${body.join('\n')}`)
  }
  let text = blocks.join('\n\n')
  if (text.length > CALL_CHARS) text = `...${text.slice(text.length - CALL_CHARS)}`
  return (
    '\n\n## His recent Live voice calls (what was really said, as transcribed)\n' +
    'These are the words from the phone call itself, kept in this chat. A hand-off is only the assistant\'s paraphrase; this is what he said. ' +
    'Transcription can mishear names: work out who or what he meant from memory. Answer questions about the call from this.\n\n' +
    text
  )
}
