/**
 * 19 Nov 2026: dictation is ONE pass over the whole audio, the live caption only a preview. A 188 s take (his 18 Nov
 * recording 20261118-222805-99e6) was cut into pieces because the rule stopped at 180 s; pieces cut words in half and
 * hide the context the model needs. Names and languages must reach that one request.
 */
import { describe, expect, it, vi } from 'vitest'

import type { MemoryRow } from '@agent/core'

import { respellNames } from '../src/main/dictation/respell'
import { transcribeWhole } from '../src/main/dictation/whole'
import { MAX_SPEECH_LANGUAGES, speechLanguages } from '../src/main/dictation/transcriber'
import { cleanVocabulary } from '../src/main/dictation/transcriber'
import { vocabularyFrom } from '../src/main/memory/vocabulary'
import { DEFAULT_CHOICE, INLINE_MAX_WAV_BYTES, transcribe } from '../src/main/voice/gemini'

const SECOND = 16_000 * 2
const pcmOf = (seconds: number): Buffer => Buffer.alloc(Math.round(seconds * SECOND), 1)
const NAMES = ['SEI', 'Strat Edge', 'Strat Edge ID', 'LondaCorp', 'Mthashana', 'Meqry', 'Impetix', 'Sinqobile', 'Phumzile', 'Guavas', 'Cosmiprint', 'Hina', 'Ayanda']

function row(title: string, extra: Partial<MemoryRow> = {}): MemoryRow {
  return { id: title, title, body: '', kind: 'project', topics: '', pinned: false, source: 'agent', updatedAt: 1, ...extra } as MemoryRow
}

describe('dictation: one pass over the whole audio', () => {
  it('a 188 s take is exactly one transcription request, not pieces', async () => {
    const one = vi.fn(async (pcm: Buffer) => ({ ok: true as const, text: `whole ${pcm.length}` }))
    const result = await transcribeWhole(pcmOf(188), new AbortController().signal, { one, log: () => undefined })
    expect(one).toHaveBeenCalledTimes(1)
    expect(one.mock.calls[0]?.[0].length).toBe(188 * SECOND)
    expect(result).toEqual({ ok: true, text: `whole ${188 * SECOND}` })
  })

  it('a 9 minute take is still one request', async () => {
    const one = vi.fn(async () => ({ ok: true as const, text: 'long' }))
    await transcribeWhole(pcmOf(540), new AbortController().signal, { one, log: () => undefined })
    expect(one).toHaveBeenCalledTimes(1)
  })

  it('one failure is tried once more as a whole; pieces only after it fails twice, and that is logged', async () => {
    const calls: number[] = []
    const logs: string[] = []
    const one = vi.fn(async (pcm: Buffer) => {
      calls.push(pcm.length)
      return calls.length <= 2 ? { ok: false as const, error: 'busy' } : { ok: true as const, text: 'piece' }
    })
    const result = await transcribeWhole(pcmOf(188), new AbortController().signal, { one, log: (m) => logs.push(m) })
    expect(calls.slice(0, 2)).toEqual([188 * SECOND, 188 * SECOND])
    expect(calls.length).toBeGreaterThan(2)
    expect(logs.some((m) => /in pieces/.test(m))).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('a retry that works is the whole pass, with no pieces', async () => {
    let n = 0
    const one = vi.fn(async () => (++n === 1 ? { ok: false as const, error: 'busy' } : { ok: true as const, text: 'ok' }))
    const result = await transcribeWhole(pcmOf(188), new AbortController().signal, { one, log: () => undefined })
    expect(one).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ ok: true, text: 'ok' })
  })

  it('a phone take (voice.transcribe over the link) is one pass over the whole audio', async () => {
    const one = vi.fn(async () => ({ ok: true as const, text: 'phone take' }))
    await transcribeWhole(pcmOf(188), new AbortController().signal, { one, log: () => undefined })
    expect(one).toHaveBeenCalledTimes(1)
  })
})

describe('the request to Google', () => {
  function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const impl = (async (url: string | URL, init: RequestInit = {}) => {
      seen.push({ url: String(url), init })
      return handler(String(url), init)
    }) as unknown as typeof fetch
    return { impl, seen }
  }
  const ok = (body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status: 200, headers })

  it('a 188 s recording is exactly one Interactions request carrying every name and the languages', async () => {
    const fetch = fakeFetch(() => ok({ output_text: 'Sinqobile and Phumzile at Strat Edge.' }))
    const languages = speechLanguages(['en-GB', 'en-US'], 'en-ZA')
    const text = await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, pcmOf(188), DEFAULT_CHOICE, { names: cleanVocabulary(NAMES), languageCodes: languages })
    expect(text).toBe('Sinqobile and Phumzile at Strat Edge.')
    expect(fetch.seen).toHaveLength(1)
    expect(fetch.seen[0]?.url).toMatch(/\/interactions$/)
    const body = JSON.parse(String(fetch.seen[0]?.init.body)) as { generation_config: { transcription_config: { custom_vocabulary: string[]; language_codes: string[]; mode: string } } }
    const config = body.generation_config.transcription_config
    for (const name of NAMES) expect(config.custom_vocabulary).toContain(name)
    expect(config.language_codes).toEqual(expect.arrayContaining(['en-GB', 'zu-ZA']))
    expect(config.language_codes.length).toBeLessThanOrEqual(MAX_SPEECH_LANGUAGES)
    expect(config.mode).toBe('verbatim')
  })

  it('a recording too long to go inline is uploaded once and read by reference, in one request', async () => {
    const seconds = Math.ceil(INLINE_MAX_WAV_BYTES / SECOND) + 30
    const fetch = fakeFetch((url, init) => {
      if (url.endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/session' } })
      if (url === 'https://upload.example/session') return ok({ file: { name: 'files/abc', uri: 'https://files.example/abc', state: 'ACTIVE' } })
      if (url.endsWith('/interactions')) return ok({ output_text: 'long take' })
      if (init.method === 'DELETE') return ok({})
      return new Response('?', { status: 404 })
    })
    const text = await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, pcmOf(seconds), DEFAULT_CHOICE, { names: NAMES, languageCodes: ['en-ZA', 'zu-ZA'] })
    expect(text).toBe('long take')
    const requests = fetch.seen.filter((call) => call.url.endsWith('/interactions'))
    expect(requests).toHaveLength(1)
    const body = String(requests[0]?.init.body)
    expect(body).toContain('https://files.example/abc')
    expect(body).not.toContain('"data"')
    expect(body).toContain('Mthashana')
  })

  it('the fallback general model is told to write what was said in the language said, with the names for spelling', async () => {
    const fetch = fakeFetch((url) => {
      if (url.endsWith('/interactions')) return new Response('{"error":{"message":"no"}}', { status: 404 })
      return ok({ candidates: [{ content: { parts: [{ text: 'fallback' }] } }] })
    })
    await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, pcmOf(10), DEFAULT_CHOICE, { names: NAMES, languageCodes: ['en-ZA', 'zu-ZA'] })
    const general = fetch.seen.find((call) => /generateContent/.test(call.url))
    const prompt = String(general?.init.body)
    expect(prompt).toContain('Mthashana')
    expect(prompt).toMatch(/never translate/)
    expect(prompt).toContain('zu-ZA')
  })
})

describe('names reach the pass from memory, not from code', () => {
  it('his core names survive a long memory full of newer noise', () => {
    // The pages he pinned and his people and organisations come before newer project pages when the list is capped.
    const rows: MemoryRow[] = NAMES.map((name, index) => row(name, { kind: index % 2 === 0 ? 'organisation' : 'person', pinned: index % 2 === 0, updatedAt: 1 }))
    for (let i = 0; i < 200; i += 1) rows.push(row(`Noise Page ${String.fromCharCode(65 + (i % 26))}${i}`, { kind: 'fact', aliases: 'x', updatedAt: 1000 + i }))
    const vocabulary = vocabularyFrom(rows)
    const sent = cleanVocabulary(['Ayanda', ...vocabulary.names])
    for (const name of NAMES) expect(sent).toContain(name)
  })
})

describe('Strat Edge said wrong next to company words (19 Nov 2026)', () => {
  const list = ['Strat Edge', 'Strat Edge Solutions', 'Strat Edge ID', 'Strat CMS', 'SEI', 'Strat Edge Intelligence']
  const fix = (text: string): string => respellNames(text, list).text
  it.each([
    ['the started edge letterhead is ready', 'the Strat Edge letterhead is ready'],
    ['the strata edge team met', 'the Strat Edge team met'],
    ['send it to strat-ed edge solutions today', 'send it to Strat Edge Solutions today'],
    ['we sent the start edge tender in', 'we sent the Strat Edge tender in'],
    ['the that edge website is live', 'the Strat Edge website is live'],
    ['ask that edge platform about it', 'ask Strat Edge platform about it'],
  ])('%s', (heard, expected) => {
    expect(fix(heard)).toBe(expected)
  })
  it('leaves a plain that edge alone when nothing company-like is near', () => {
    expect(fix('put the cup on that edge of the table')).toBe('put the cup on that edge of the table')
  })
  it('does not touch him talking about the mistake, nor a sentence that already has the name right', () => {
    const message =
      "And yeah, man, Strat Edge, 'cause that word always confuses you. Okay, it said started edge instead of Strat Edge. Again, it's saying strat- it's saying that edge now. But it's supposed to be S-T-R-A-T-E-D-G-E. Okay, yeah, yeah, this transcriber is okay, but not not that better."
    expect(fix(message)).toBe(message)
    expect(fix('Strat Edge team and the started edge letterhead')).toBe('Strat Edge team and the started edge letterhead')
  })
})

describe('names ranked by how often memory links them', () => {
  it('a name many pages link to comes before a newer page nobody links to', () => {
    const rows = [
      row('Rarely Used', { kind: 'organisation', updatedAt: 9000 }),
      row('Strat Edge', { kind: 'organisation', updatedAt: 1 }),
      ...Array.from({ length: 5 }, (_, i) => row(`Page ${i}`, { kind: 'fact', body: 'Works with [[Strat Edge]] daily', updatedAt: 2 })),
    ]
    expect(vocabularyFrom(rows).names.slice(0, 2)).toEqual(['Strat Edge', 'Rarely Used'])
  })
})

describe('multi-word names and their stems reach the pass', () => {
  it('Strat Edge Intelligence is in the list, and the stem Strat Edge shared by longer names is added', () => {
    const rows = ['Strat Edge Intelligence', 'Strat Edge Solutions', 'Strat Edge ID', 'LondaCorp'].map((title) => row(title, { kind: 'organisation' }))
    const names = vocabularyFrom(rows).names
    expect(names).toEqual(expect.arrayContaining(['Strat Edge Intelligence', 'Strat Edge Solutions', 'Strat Edge ID', 'Strat Edge', 'LondaCorp']))
    expect(vocabularyFrom([row('Strat Edge Intelligence', { kind: 'organisation' })]).names).toEqual(['Strat Edge Intelligence'])
  })
})

describe('the dictation model is a setting', () => {
  function fakeFetch(handler: (url: string) => Response) {
    const seen: string[] = []
    const impl = (async (url: string | URL) => {
      seen.push(String(url))
      return handler(String(url))
    }) as unknown as typeof fetch
    return { impl, seen }
  }
  const reply = (text: string): Response => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 })

  it('a general model chosen in settings reads the whole file itself, with the names and languages, one request', async () => {
    const fetch = fakeFetch(() => reply('Sawubona, Strat Edge.'))
    const text = await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, pcmOf(188), DEFAULT_CHOICE, { names: NAMES, languageCodes: ['en-ZA', 'zu-ZA'], model: 'gemini-3.1-flash-lite' })
    expect(text).toBe('Sawubona, Strat Edge.')
    expect(fetch.seen).toHaveLength(1)
    expect(fetch.seen[0]).toContain('/models/gemini-3.1-flash-lite:generateContent')
  })

  it('when that model is out of quota the speech model gets the same audio', async () => {
    const fetch = fakeFetch((url) => (url.endsWith('/interactions') ? new Response(JSON.stringify({ output_text: 'from the speech model' }), { status: 200 }) : new Response('{}', { status: 429 })))
    const text = await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, pcmOf(30), DEFAULT_CHOICE, { names: NAMES, model: 'gemini-3.1-flash-lite' })
    expect(text).toBe('from the speech model')
  })

  it('a speech model chosen in settings uses the Interactions request as before', async () => {
    const fetch = fakeFetch(() => new Response(JSON.stringify({ output_text: 'speech' }), { status: 200 }))
    await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, pcmOf(30), DEFAULT_CHOICE, { names: NAMES, model: 'gemini-3.5-transcribe' })
    expect(fetch.seen).toEqual([expect.stringMatching(/\/interactions$/)])
  })
})
