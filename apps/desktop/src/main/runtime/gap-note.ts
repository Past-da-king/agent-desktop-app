/**
 * One conversation, whichever brain answers (26 Nov 2026: "it's like I'm talking to a different agent").
 *
 * A plan engine (Claude, Codex) keeps its session on the computer that runs it, so a second brain that takes over a
 * chat starts a session that has never seen what the first one said or did. The chat rows replicate, so the second
 * brain can read them: before its turn, everything written in the chat since this computer's engine last finished
 * a turn here (what he said, what the other brain answered, and the tool steps it took) is handed over as one note.
 * A computer that answered every turn itself has nothing after its mark, so it gets no note.
 */
import type { ChatItem } from '@agent/core'

/** The conversation itself, and the steps of tools the other brain ran. */
export const GAP_KINDS = ['user', 'agent', 'report', 'activity'] as const

const MAX_CHARS = 14_000
const MAX_STEP_CHARS = 220
/** With no mark (first turn on this computer): this many of the newest lines of the conversation. */
export const FIRST_TURN_ROWS = 30
export const SEEN_ROWS = 200
const MAX_ROWS = 120

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`
}

function parse(meta: string): Record<string, unknown> {
  try {
    const value = JSON.parse(meta) as unknown
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** The note for the rows (oldest first), or '' when there is nothing the engine here has not seen. */
export function gapText(rows: ChatItem[]): string {
  const lines: string[] = []
  for (const row of rows) {
    const text = row.text.trim()
    if (text === '') continue
    if (row.kind === 'user') lines.push(`User: ${clip(text, 2_000)}`)
    else if (row.kind === 'agent' || row.kind === 'report') lines.push(`You: ${clip(text, 3_000)}`)
    else if (row.kind === 'activity') {
      const meta = parse(row.meta)
      // A helper's own steps are its card, not this conversation.
      if (typeof meta['helper'] === 'string' && meta['helper'] !== '') continue
      const tool = typeof meta['tool'] === 'string' ? meta['tool'] : ''
      const state = typeof meta['status'] === 'string' ? ` (${meta['status']})` : ''
      const run = typeof meta['run'] === 'object' && meta['run'] !== null ? (meta['run'] as Record<string, unknown>) : {}
      const out = typeof run['stdout'] === 'string' ? clip(run['stdout'], 160) : ''
      lines.push(`[Step${tool === '' ? '' : ` ${tool}`}${state}: ${clip(text, MAX_STEP_CHARS)}${out === '' ? '' : ` -> ${out}`}]`)
    }
  }
  if (!lines.some((line) => line.startsWith('User:') || line.startsWith('You:'))) return ''
  let body = lines.join('\n')
  if (body.length > MAX_CHARS) body = `...${body.slice(body.length - MAX_CHARS)}`
  return (
    '[This conversation carried on elsewhere since your last turn here: another computer of his answered while this one was away. ' +
    'What was said and done, oldest first. It is your own earlier conversation: carry on from it, do not repeat it back, and do not redo what the steps show was done.]\n' +
    `${body}\n[End of what happened while you were away.]`
  )
}

export interface GapReader {
  /** Rows of the chat created in (since, before), oldest first. */
  between(since: number | null, before: number): Promise<ChatItem[]>
}

export async function gapNote(reader: GapReader, since: number | null, before: number): Promise<string> {
  const rows = await reader.between(since, before)
  return gapText(rows.slice(-MAX_ROWS))
}
