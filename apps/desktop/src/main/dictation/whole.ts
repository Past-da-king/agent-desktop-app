/**
 * A recording to text: ONE pass over the whole audio (19 Nov 2026).
 *
 * The model hears everything at once and infers what a real-time pass gets wrong, so there is no 3-minute rule and no
 * 2-minute cut: one request however long (voice/gemini.ts sends it inline, or uploads it first when it is too big to go
 * inline). If that fails twice (a quota blip, a busy service) the recording is cut at quiet moments as a last resort,
 * and that is logged, so a long take is never lost to one bad call.
 */
import { transcribeInChunks } from './chunks'
import type { BatchResult } from './controller'

/** A recording shorter than this is never cut into pieces: a cut costs more than it saves. */
const PIECE_FALLBACK_MIN_BYTES = 16_000 * 2 * 60 * 2

export interface WholeOptions {
  /** One transcription request over `pcm` (voice.transcribe with his names and languages). */
  one: (pcm: Buffer, signal: AbortSignal) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  log: (message: string, fields?: Record<string, string | number | boolean>) => void
  onUpdate?: (text: string, interim: string) => void
}

export async function transcribeWhole(pcm: Buffer, signal: AbortSignal, options: WholeOptions): Promise<BatchResult> {
  let reason = 'Could not transcribe that.'
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const whole = await options.one(pcm, signal)
    if (whole.ok) return { ok: true, text: whole.text }
    if (signal.aborted) return { ok: false, error: 'Cancelled.' }
    reason = whole.error
    options.log('Dictation whole transcribe failed', { attempt, reason })
  }
  if (pcm.length <= PIECE_FALLBACK_MIN_BYTES) return { ok: false, error: reason }
  options.log('Dictation whole pass failed twice, trying in pieces', { bytes: pcm.length })
  return transcribeInChunks(pcm, (piece, pieceSignal) => options.one(piece, pieceSignal), {
    signal,
    ...(options.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
    log: options.log,
  })
}
