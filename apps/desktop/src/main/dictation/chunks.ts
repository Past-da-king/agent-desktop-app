/**
 * A long recording transcribed in pieces: cut at quiet moments into pieces of at most about 30 seconds, a few
 * transcribed at once, joined in order. One call with 90 seconds of audio can take longer than the finishing limit
 * (29 Oct 2026: 74 s and aborted); 30-second pieces come back in a few seconds each.
 */
import type { BatchResult } from './controller'

const BYTES_PER_SECOND = 16_000 * 2
/** The longest piece. */
export const CHUNK_MAX_BYTES = BYTES_PER_SECOND * 30
/** How far back from the longest point a quiet moment is looked for. */
const QUIET_SEARCH_BYTES = BYTES_PER_SECOND * 6
/** The step the quiet moment is measured in (100 ms). */
const FRAME_BYTES = 3200
/** Pieces at once: quicker than one by one, gentle on the key's quota. */
const CONCURRENCY = 3

/** Where to cut: offsets (even, in bytes) of each piece's start. A piece is never longer than maxBytes. */
export function splitAtQuiet(pcm: Buffer, maxBytes = CHUNK_MAX_BYTES, searchBytes = QUIET_SEARCH_BYTES): Buffer[] {
  const pieces: Buffer[] = []
  let start = 0
  while (pcm.length - start > maxBytes) {
    const latest = start + maxBytes
    const earliest = Math.max(start + FRAME_BYTES, latest - searchBytes)
    let best = latest
    let bestLevel = Number.POSITIVE_INFINITY
    // The quietest 100 ms in the search window, the later one on a tie (longer pieces, fewer calls).
    for (let at = latest - FRAME_BYTES; at >= earliest; at -= FRAME_BYTES) {
      const level = rms(pcm, at, Math.min(at + FRAME_BYTES, pcm.length))
      if (level < bestLevel - 1e-9) {
        bestLevel = level
        best = at + FRAME_BYTES / 2
      }
    }
    best -= best % 2
    pieces.push(pcm.subarray(start, best))
    start = best
  }
  if (start < pcm.length) pieces.push(pcm.subarray(start))
  return pieces
}

export interface ChunkedOptions {
  signal: AbortSignal
  onUpdate?: (text: string, interim: string) => void
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void
  concurrency?: number
  maxBytes?: number
}

/**
 * Every piece through `one` (a one-call transcription), a few at once, each tried twice. The words so far show as
 * pieces come back in order. Any piece that still fails fails the whole (the recording stays for Retry).
 */
export async function transcribeInChunks(pcm: Buffer, one: (piece: Buffer, signal: AbortSignal) => Promise<BatchResult>, options: ChunkedOptions): Promise<BatchResult> {
  const pieces = splitAtQuiet(pcm, options.maxBytes ?? CHUNK_MAX_BYTES)
  const texts: Array<string | null> = pieces.map(() => null)
  const started = Date.now()
  let failure: string | null = null
  let next = 0
  const shown = (): void => {
    const done: string[] = []
    for (const text of texts) {
      if (text === null) break
      if (text.trim() !== '') done.push(text.trim())
    }
    options.onUpdate?.(done.join(' '), '')
  }
  const worker = async (): Promise<void> => {
    while (failure === null && !options.signal.aborted) {
      const index = next
      next += 1
      const piece = pieces[index]
      if (piece === undefined) return
      let result: BatchResult = { ok: false, error: 'Could not transcribe that.' }
      for (let attempt = 0; attempt < 2 && !options.signal.aborted; attempt += 1) {
        result = await one(piece, options.signal).catch((error: unknown): BatchResult => ({ ok: false, error: error instanceof Error ? error.message : 'Could not transcribe that.' }))
        if (result.ok) break
        options.log?.('Dictation piece failed', { piece: index + 1, of: pieces.length, attempt: attempt + 1, reason: result.error.slice(0, 200) })
      }
      if (!result.ok) {
        failure ??= result.error
        return
      }
      texts[index] = result.text
      shown()
    }
  }
  const workers = Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, pieces.length) }, () => worker())
  await Promise.all(workers)
  if (options.signal.aborted) return { ok: false, error: 'Cancelled.' }
  if (failure !== null) return { ok: false, error: failure }
  options.log?.('Dictation transcribed in pieces', { pieces: pieces.length, bytes: pcm.length, ms: Date.now() - started })
  return { ok: true, text: texts.map((text) => (text ?? '').trim()).filter((text) => text !== '').join(' ') }
}

function rms(pcm: Buffer, from: number, to: number): number {
  const count = Math.floor((to - from) / 2)
  if (count <= 0) return 0
  let sum = 0
  for (let index = 0; index < count; index += 1) {
    const sample = pcm.readInt16LE(from + index * 2) / 0x8000
    sum += sample * sample
  }
  return Math.sqrt(sum / count)
}
