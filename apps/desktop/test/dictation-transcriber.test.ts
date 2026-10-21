import { afterEach, describe, expect, it } from 'vitest'

import { LiveTranscriber, joinSegment, languageHint, setupMessage } from '../src/main/dictation/transcriber'
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

  it('joins settled stretches of speech with one space', () => {
    expect(joinSegment('', ' Hello there.')).toBe('Hello there.')
    expect(joinSegment('Hello there.', 'How are you?')).toBe('Hello there. How are you?')
    expect(joinSegment('Hello', ', you')).toBe('Hello, you')
    expect(joinSegment('Hello ', 'you')).toBe('Hello you')
  })

  it('hints English from the locale and lets other languages be detected', () => {
    expect(languageHint('en-ZA')).toEqual(['en-GB'])
    expect(languageHint('en-US')).toEqual(['en-US'])
    expect(languageHint('en_IN')).toEqual(['en-IN'])
    expect(languageHint('en')).toEqual(['en-GB'])
    expect(languageHint('af-ZA')).toEqual([])
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
})
