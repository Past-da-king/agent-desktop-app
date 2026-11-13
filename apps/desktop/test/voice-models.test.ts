/** Voice models come from what the key lists, by what they do, newest first. */
import { describe, expect, it } from 'vitest'

import { chooseModels } from '../src/main/voice/gemini'

describe('chooseModels', () => {
  it('picks the newest live, speech and quick text models the key lists', () => {
    const choice = chooseModels([
      'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-4.0-flash-lite', 'gemini-4.0-flash',
      'gemini-3.8-flash-tts', 'gemini-4.1-flash-tts-preview', 'gemini-4.1-flash-tts',
      'gemini-3.8-live', 'gemini-4.2-live-preview', 'gemini-3.5-transcribe', 'gemini-3.6-transcribe',
      'text-embedding-004', 'imagen-5',
    ])
    // Transcription is the speech model, not the quickest text model (11 Nov 2026).
    expect(choice).toMatchObject({ live: 'gemini-4.2-live-preview', tts: 'gemini-4.1-flash-tts', transcribe: 'gemini-3.6-transcribe' })
    expect(choice.speech?.[0]).toBe('gemini-4.1-flash-tts')
  })

  it('never picks a live transcribing model for a recording, and never a lite one when a full model exists', () => {
    const choice = chooseModels([
      'gemini-2.5-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-transcribe-live', 'gemini-3.8-live',
    ])
    expect(choice.transcribe).toBe('gemini-3.5-flash')
  })

  it('falls back to the known names only when the key lists nothing that fits', () => {
    const choice = chooseModels([])
    expect(choice.tts).not.toBe('')
    expect(choice.live).not.toBe('')
  })
})
