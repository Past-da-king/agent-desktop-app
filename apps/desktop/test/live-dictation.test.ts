/**
 * Real Gemini, only when GEMINI_API_KEY is set (it is never printed). Makes a short spoken clip with Gemini's own
 * speech model, streams it at real time through the live transcriber to gemini-3.5-transcribe-live, then cleans a
 * messy line with the clean-up model. Run:
 *   GEMINI_API_KEY=... npx vitest run apps/desktop/test/live-dictation.test.ts
 */
import { describe, expect, it } from 'vitest'

import { cleanUp } from '../src/main/dictation/cleanup'
import { LiveTranscriber, TRANSCRIBE_LIVE_MODELS } from '../src/main/dictation/transcriber'
import { DEFAULT_CHOICE, LIVE_URL, speak } from '../src/main/voice/gemini'
import type { SocketLike } from '../src/main/voice/live'

const key = process.env['GEMINI_API_KEY']?.trim() ?? ''

/** 24 kHz PCM16 to 16 kHz PCM16, by averaging (the same idea as the renderer's downsample). */
function to16k(pcm: Buffer): Buffer {
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  const ratio = 24_000 / 16_000
  const length = Math.floor(input.length / ratio)
  const out = Buffer.alloc(length * 2)
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let at = start; at < end; at += 1) sum += input[at] ?? 0
    out.writeInt16LE(Math.round(sum / Math.max(1, end - start)), index * 2)
  }
  return out
}

describe.skipIf(key === '')('dictation against the real Gemini API', () => {
  it('transcribes a spoken clip live, then cleans up a messy line', async () => {
    const sentence = 'Please send the quarterly report to Thandi before Friday afternoon.'
    const spoken = await speak({ key: () => key }, sentence, 'Kore', DEFAULT_CHOICE)
    const pcm = to16k(spoken)
    expect(pcm.length).toBeGreaterThan(16_000)

    const updates: string[] = []
    const transcriber = new LiveTranscriber({
      url: LIVE_URL,
      key,
      model: TRANSCRIBE_LIVE_MODELS[0] ?? '',
      socket: (url) => new (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket(url),
      languageCodes: ['en-GB'],
      onUpdate: (text, interim) => updates.push(`${text} | ${interim}`),
    })
    const connectAt = performance.now()
    await transcriber.start()
    const connectMs = performance.now() - connectAt
    const chunk = 3200 // 100 ms
    for (let offset = 0; offset < pcm.length; offset += chunk) {
      transcriber.audio(pcm.subarray(offset, offset + chunk))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    // Half a second of silence, as a person pausing before pressing the shortcut again.
    for (let index = 0; index < 5; index += 1) {
      transcriber.audio(Buffer.alloc(chunk))
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const stopAt = performance.now()
    const text = await transcriber.finish(3000)
    const settleMs = performance.now() - stopAt
    console.log(`live transcription: connect ${Math.round(connectMs)} ms, settle after stop ${Math.round(settleMs)} ms, ${updates.length} updates`)
    console.log(`heard: ${text}`)
    expect(text.toLowerCase()).toContain('thandi')
    expect(text.toLowerCase()).toContain('friday')

    const cleanAt = performance.now()
    const cleaned = await cleanUp({ key: () => key }, 'so um I I think we should uh move the the launch to, like, the second week of November')
    console.log(`clean-up ${Math.round(performance.now() - cleanAt)} ms: ${cleaned}`)
    expect(cleaned.toLowerCase()).not.toMatch(/\bum\b|\buh\b/)
    expect(cleaned.toLowerCase()).toContain('november')
  }, 90_000)
})
