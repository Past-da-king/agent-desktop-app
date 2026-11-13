/**
 * The final transcript comes from the speech model, with his languages and his names (11 Nov 2026).
 * These pin what goes up in the request and what is read back, and that the general model is only the fallback.
 */
import { describe, expect, it } from 'vitest'

import {
  cleanTerms,
  DEFAULT_CHOICE,
  SPEECH_MODEL,
  speechBody,
  speechTextOf,
  transcribe,
  type ModelChoice,
} from '../src/main/voice/gemini'

const PCM = Buffer.alloc(16_000 * 2) // one second of silence, long enough for the body

const CHOICE: ModelChoice = { ...DEFAULT_CHOICE, transcribe: SPEECH_MODEL, live: 'gemini-3.8-live', tts: 'gemini-3.8-flash-tts' }

/** A fetch that answers by address, and keeps what it was asked. */
function fakeFetch(answers: Array<{ match: (url: string) => boolean; status?: number; body: unknown }>) {
  const sent: Array<{ url: string; body: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    sent.push({ url, body: String(init?.body ?? '') })
    const answer = answers.find((candidate) => candidate.match(url))
    if (answer === undefined) throw new Error(`unexpected ${url}`)
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(answer.body),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

describe('the speech-to-text request', () => {
  it('asks the speech model with his languages, his vocabulary and the mode', () => {
    const body = speechBody('gemini-3.5-transcribe', 'AAAA', {
      languageCodes: ['en-ZA', 'zu-ZA'],
      vocabulary: ['Ayanda', 'Strat Edge', 'Impetix', '  ', 'Ayanda'],
      mode: 'verbatim',
    })
    expect(body['model']).toBe('models/gemini-3.5-transcribe')
    expect(body['input']).toEqual([
      { type: 'user_input', content: [{ type: 'audio', data: 'AAAA', mime_type: 'audio/wav' }] },
    ])
    const config = (body['generation_config'] as { transcription_config: Record<string, unknown> })['transcription_config']
    expect(config['language_codes']).toEqual(['en-ZA', 'zu-ZA'])
    expect(config['custom_vocabulary']).toEqual(['Ayanda', 'Strat Edge', 'Impetix'])
    expect(config['mode']).toBe('verbatim')
  })

  it('sends no empty lists, which the model rejects', () => {
    const config = (speechBody('gemini-3.5-transcribe', 'AAAA', {})['generation_config'] as { transcription_config: Record<string, unknown> })[
      'transcription_config'
    ]
    expect(config).toEqual({ mode: 'verbatim' })
  })

  it('read the transcript out of every shape the API answers with', () => {
    expect(speechTextOf({ output_text: ' Hello there. ' })).toBe('Hello there.')
    expect(
      speechTextOf({ steps: [{ type: 'model_output', content: [{ text: 'One. ' }, { text: 'Two.' }] }] }),
    ).toBe('One. Two.')
    expect(speechTextOf({ steps: [{ content: [{ audioTranscription: { text: 'Spoken words.' } }] }] })).toBe('Spoken words.')
    expect(speechTextOf({ steps: [] })).toBe('')
  })

  it('keeps the vocabulary short, distinct and in order', () => {
    const many = Array.from({ length: 130 }, (_, index) => `Name${index}`)
    expect(cleanTerms(many)).toHaveLength(100)
    expect(cleanTerms(['Meqry', 'meqry', ' Guavas '])).toEqual(['Meqry', 'Guavas'])
    expect(cleanTerms(['a', 'x'.repeat(80)])).toEqual([])
  })
})

describe('transcribing a recording', () => {
  it('uses the speech model first and reads its transcript', async () => {
    const { fetchImpl, sent } = fakeFetch([
      { match: (url) => url.endsWith('/v1beta/interactions'), body: { steps: [{ type: 'model_output', content: [{ text: 'Yes, but watching the latest build created this issue.' }] }] } },
    ])
    const text = await transcribe({ key: () => 'k', fetchImpl }, PCM, CHOICE, {
      names: ['Ayanda', 'Opus', 'Sonnet'],
      languageCodes: ['en-ZA', 'zu-ZA'],
    })
    expect(text).toBe('Yes, but watching the latest build created this issue.')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toContain('interactions')
    expect(sent[0]?.body).toContain('custom_vocabulary')
    expect(sent[0]?.body).toContain('en-ZA')
  })

  it('falls back to a strong general model with the same names when the speech model is out of reach', async () => {
    const { fetchImpl, sent } = fakeFetch([
      { match: (url) => url.endsWith('/v1beta/interactions'), status: 429, body: { error: { message: 'quota' } } },
      { match: (url) => url.includes(':generateContent'), body: { candidates: [{ content: { parts: [{ text: 'Opus and Sonnet.' }] } }] } },
    ])
    const text = await transcribe({ key: () => 'k', fetchImpl }, PCM, CHOICE, { names: ['Opus', 'Sonnet'], languageCodes: ['en-ZA'] })
    expect(text).toBe('Opus and Sonnet.')
    expect(sent).toHaveLength(2)
    expect(sent[1]?.url).toContain('gemini-3.6-flash:generateContent')
    expect(sent[1]?.body).toContain('Opus, Sonnet')
    // Never the lite model that used to guess at his words.
    expect(sent[1]?.url).not.toContain('lite')
  })

  it('reads a speech model that answers in audioTranscription', async () => {
    const { fetchImpl } = fakeFetch([
      { match: (url) => url.includes(':generateContent'), body: { candidates: [{ content: { parts: [{ audioTranscription: { text: 'Spoken here.' } }] } }] } },
    ])
    const text = await transcribe({ key: () => 'k', fetchImpl }, PCM, { ...CHOICE, transcribe: 'gemini-2.5-flash' }, {})
    expect(text).toBe('Spoken here.')
  })

  it('gives nothing for an empty recording, and asks nothing', async () => {
    const { fetchImpl, sent } = fakeFetch([])
    expect(await transcribe({ key: () => 'k', fetchImpl }, Buffer.alloc(0), CHOICE, {})).toBe('')
    expect(sent).toHaveLength(0)
  })
})
