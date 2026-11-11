import { afterEach, describe, expect, it } from 'vitest'

import { LiveTranscriber, cleanVocabulary, joinSegment, normaliseTag, replayRecording, setupMessage, speechLanguages } from '../src/main/dictation/transcriber'
import type { SocketLike } from '../src/main/voice/live'
import { startFakeLive, type FakeLive } from './fake-live'

let live: FakeLive | null = null

afterEach(async () => {
  await live?.close()
  live = null
})

/** Node's own WebSocket, as the app uses it. */
const nodeSocket = (url: string): SocketLike => new (globalThis as unknown as { WebSocket: new (url: string) => SocketLike }).WebSocket(url)

function transcriber(url: string, updates: Array<[string, string]> = [], drops: string[] = []): LiveTranscriber {
  return new LiveTranscriber({
    url,
    key: 'test-key',
    model: 'gemini-3.5-transcribe-live',
    socket: nodeSocket,
    languageCodes: ['en-GB'],
    onUpdate: (text, interim) => updates.push([text, interim]),
    onDrop: (reason) => drops.push(reason),
  })
}

describe('the live transcription setup', () => {
  it('asks the transcription model for text, verbatim, with the language hint', () => {
    expect(setupMessage({ model: 'gemini-3.5-transcribe-live', languageCodes: ['en-GB'] })).toEqual({
      setup: {
        model: 'models/gemini-3.5-transcribe-live',
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: { languageCodes: ['en-GB'], mode: 'VERBATIM' },
      },
    })
    expect(setupMessage({ model: 'models/x' })).toMatchObject({ setup: { model: 'models/x', inputAudioTranscription: { languageCodes: [] } } })
  })

  it('sends the names to listen for as custom vocabulary, distinct and at most 100', () => {
    expect(setupMessage({ model: 'm', languageCodes: [], vocabulary: ['Initech', ' Northwind ', 'initech', 'x'] })).toMatchObject({
      setup: { inputAudioTranscription: { customVocabulary: ['Initech', 'Northwind'] } },
    })
    const many = Array.from({ length: 150 }, (_, index) => `Name ${index}`)
    expect(cleanVocabulary(many)).toHaveLength(100)
    expect(cleanVocabulary(many)[0]).toBe('Name 0')
    expect(JSON.stringify(setupMessage({ model: 'm', vocabulary: [] }))).not.toContain('customVocabulary')
  })

  it('joins settled stretches of speech with one space', () => {
    expect(joinSegment('', ' Hello there.')).toBe('Hello there.')
    expect(joinSegment('Hello there.', 'How are you?')).toBe('Hello there. How are you?')
    expect(joinSegment('Hello', ', you')).toBe('Hello, you')
    expect(joinSegment('Hello ', 'you')).toBe('Hello you')
  })

  it('tells the model the languages he actually speaks, from his own system', () => {
    // South African English goes up with the isiZulu that runs through it, instead of being called British English.
    expect(speechLanguages([], 'en-ZA')).toEqual(['en-ZA', 'zu-ZA'])
    expect(speechLanguages(['en-ZA', 'zu-ZA'], 'en-ZA')).toEqual(['en-ZA', 'zu-ZA'])
    expect(speechLanguages(['en-ZA', 'af-ZA'], 'en-ZA')).toEqual(['en-ZA', 'af-ZA'])
    // Nothing is invented for a language he does not speak, and English stays first.
    expect(speechLanguages(['en-US'], 'en-US')).toEqual(['en-US'])
    expect(speechLanguages(['af-ZA'], 'af-ZA')).toEqual(['af-ZA'])
    expect(speechLanguages(['zu-ZA', 'en-ZA'], 'en-ZA')).toEqual(['en-ZA', 'zu-ZA'])
    // Any English that is not South African is just itself: no guessing at isiZulu.
    expect(speechLanguages([], 'en-GB')).toEqual(['en-GB'])
    expect(speechLanguages([], '')).toEqual([])
    expect(speechLanguages(['not a language', 'en_ZA'], 'en-ZA')).toEqual(['en-ZA', 'zu-ZA'])
  })

  it('normalises a language tag and drops what is not one', () => {
    expect(normaliseTag('en_us')).toBe('en-US')
    expect(normaliseTag(' EN-za ')).toBe('en-ZA')
    expect(normaliseTag('zu')).toBe('zu')
    expect(normaliseTag('')).toBeNull()
    expect(normaliseTag('English (South Africa)')).toBeNull()
  })
})

describe('LiveTranscriber over a real socket', () => {
  it('streams audio after the setup, shows guesses, and settles the words after the stream ends', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) {
        connection.send({ setupComplete: {} })
        return
      }
      const input = message['realtimeInput'] as Record<string, unknown> | undefined
      if (input?.['audio'] !== undefined && connection.received.length === 2) {
        connection.send({ serverContent: { interimInputTranscription: { text: 'Send the' } } })
        connection.send({ serverContent: { interimInputTranscription: { text: 'Send the proposal' } } })
        connection.send({ serverContent: { inputTranscription: { text: 'Send the proposal to Thandi.' } } })
        connection.send({ serverContent: { interimInputTranscription: { text: 'Before Friday' } } })
      }
      if (input?.['audioStreamEnd'] === true) {
        setTimeout(() => connection.send({ serverContent: { inputTranscription: { text: 'Before Friday.' } } }), 50)
        setTimeout(() => connection.send({ serverContent: { turnComplete: true } }), 80)
      }
    })
    const updates: Array<[string, string]> = []
    const session = transcriber(live.url, updates)
    // Audio before the setup is accepted is held, not lost.
    session.audio(Buffer.alloc(3200, 1))
    await session.start()
    session.audio(Buffer.alloc(3200, 2))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(updates.at(-1)).toEqual(['Send the proposal to Thandi.', 'Before Friday'])
    expect(session.text()).toBe('Send the proposal to Thandi. Before Friday')

    const started = Date.now()
    const text = await session.finish(3000)
    expect(text).toBe('Send the proposal to Thandi. Before Friday.')
    expect(Date.now() - started).toBeLessThan(1500)

    const connection = live.connections[0]
    expect(connection?.url).toBe('/ws?key=test-key')
    expect(connection?.received[0]).toMatchObject({ setup: { model: 'models/gemini-3.5-transcribe-live', generationConfig: { responseModalities: ['TEXT'] } } })
    const audio = connection?.received.filter((message) => 'realtimeInput' in message && (message['realtimeInput'] as Record<string, unknown>)['audio'] !== undefined) ?? []
    expect(audio).toHaveLength(2)
    expect(audio[0]).toMatchObject({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000' } } })
    expect(connection?.received.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
  })

  it('keeps the last guess when the final words never come, within the wait', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) connection.send({ setupComplete: {} })
      else if (connection.received.length === 2) connection.send({ serverContent: { interimInputTranscription: { text: 'half a thought' } } })
    })
    const session = transcriber(live.url)
    await session.start()
    session.audio(Buffer.alloc(320, 1))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const started = Date.now()
    expect(await session.finish(600)).toBe('half a thought')
    expect(Date.now() - started).toBeGreaterThanOrEqual(550)
  })

  it('stops waiting when asked (the shortcut pressed again)', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) connection.send({ setupComplete: {} })
      else if (connection.received.length === 2) connection.send({ serverContent: { interimInputTranscription: { text: 'quick' } } })
    })
    const session = transcriber(live.url)
    await session.start()
    session.audio(Buffer.alloc(320, 1))
    await new Promise((resolve) => setTimeout(resolve, 80))
    const finishing = session.finish(5000)
    setTimeout(() => session.flush(), 50)
    const started = Date.now()
    expect(await finishing).toBe('quick')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('rejects in plain words when the key is refused, and reports a drop after it was up', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) connection.close(1008)
    })
    await expect(transcriber(live.url).start()).rejects.toThrow('That Gemini key was not accepted for live transcription.')
    await live.close()

    live = await startFakeLive((connection, message) => {
      if ('setup' in message) {
        connection.send({ setupComplete: {} })
        setTimeout(() => connection.close(1011), 30)
      }
    })
    const drops: string[] = []
    const session = transcriber(live.url, [], drops)
    await session.start()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(drops).toEqual(['Gemini had a problem listening. Try again.'])
  })

  it('says it could not reach Gemini when nothing is listening', async () => {
    await expect(transcriber('ws://127.0.0.1:1/ws').start()).rejects.toThrow('Could not reach Gemini. Check the connection.')
  })

  it('replays a kept recording and waits past a quiet spell for the settled words', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) {
        connection.send({ setupComplete: {} })
        return
      }
      const input = message['realtimeInput'] as Record<string, unknown> | undefined
      // The final words come well after the stream ends, longer than the usual quiet that settles a live session.
      if (input?.['audioStreamEnd'] === true) setTimeout(() => connection.send({ serverContent: { inputTranscription: { text: 'Call Initech.' } } }), 1200)
    })
    const text = await replayRecording({
      url: live.url,
      key: 'test-key',
      model: 'gemini-3.5-transcribe-live',
      socket: nodeSocket,
      vocabulary: ['Initech'],
      pcm: Buffer.alloc(3200 * 5, 1),
      signal: new AbortController().signal,
    })
    expect(text).toBe('Call Initech.')
    const received = live.connections[0]?.received ?? []
    expect(received[0]).toMatchObject({ setup: { inputAudioTranscription: { customVocabulary: ['Initech'] } } })
    expect(received.filter((message) => (message['realtimeInput'] as Record<string, unknown> | undefined)?.['audio'] !== undefined)).toHaveLength(5)
  })

  it('a replay stops when it is cancelled', async () => {
    live = await startFakeLive((connection, message) => {
      if ('setup' in message) connection.send({ setupComplete: {} })
    })
    const abort = new AbortController()
    const replay = replayRecording({
      url: live.url,
      key: 'test-key',
      model: 'm',
      socket: nodeSocket,
      pcm: Buffer.alloc(3200 * 40, 1),
      signal: abort.signal,
    })
    setTimeout(() => abort.abort(), 150)
    const started = Date.now()
    await expect(replay).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
