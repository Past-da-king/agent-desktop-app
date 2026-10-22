/**
 * Voice: the Gemini Live protocol against a faithful fake websocket, the REST calls against a fake
 * fetch, the service end to end against a real Store, and the pure audio maths. No network.
 *
 * `any` appears only as `Record<string, any>` when reading deep JSON wire messages in assertions:
 * typing every Gemini message shape here would test the types, not the protocol.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS, type CallEvent, type Settings } from '@agent/core'

import { Store } from '../src/main/db'
import { visualFrom, visualMarkdown, voiceTools } from '../src/main/tools/voice'
import { DEFAULT_CHOICE, LIVE_TOKEN_START_MS, LIVE_TOKEN_TTL_MS, LIVE_TOKEN_URL, checkKey, mintLiveToken, plainForSpeech, speak, stripWav, transcribe, wavFromPcm } from '../src/main/voice/gemini'
import { LiveSession, geminiSchema, joinChunk, type SocketLike } from '../src/main/voice/live'
import { mediaAllowed } from '../src/main/voice/permissions'
import { deviceCall } from '../src/main/voice/ipc'
import { VoiceService } from '../src/main/voice/service'
import { RPC_ALLOWED } from '../src/shared/rpc-methods'
import { SettingsStore } from '../src/main/settings'
import { downsample, floatToPcm16, level, pcm16ToFloat, springStep } from '../src/renderer/voice/pcm'

// ---- a fake Gemini Live websocket -------------------------------------------------------------

class FakeSocket implements SocketLike {
  binaryType?: string
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onclose: SocketLike['onclose'] = null
  onerror: SocketLike['onerror'] = null
  readonly sent: Array<Record<string, unknown>> = []
  closed: number | null = null
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code = 1000): void {
    this.closed = code
  }
  // Server side.
  open(): void {
    this.onopen?.({})
  }
  /** Gemini sends JSON in binary frames; this sends it as bytes, as the real server does. */
  push(message: unknown): void {
    this.onmessage?.({ data: new TextEncoder().encode(JSON.stringify(message)).buffer })
  }
  drop(code: number): void {
    this.onclose?.({ code })
  }
}

function harness(options: { runTool?: (name: string, args: Record<string, unknown>) => Promise<string> } = {}) {
  const sockets: FakeSocket[] = []
  const events: CallEvent[] = []
  const session = new LiveSession({
    url: 'wss://live.test/ws',
    key: 'test-key',
    model: 'gemini-test-live',
    voice: 'Kore',
    systemPrompt: 'You are on a call.',
    tools: [{ name: 'show_on_screen', description: 'Show', schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }],
    socket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    emit: (event) => events.push(event),
    runTool: async (name, args) => (options.runTool ? options.runTool(name, args as Record<string, unknown>) : 'done'),
    now: () => 1_000,
  })
  return { session, sockets, events }
}

async function connected() {
  const h = harness()
  const started = h.session.start()
  const socket = h.sockets[0]!
  socket.open()
  socket.push({ setupComplete: {} })
  await started
  return { ...h, socket }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('Gemini Live session', () => {
  it('sends a setup with the model, audio out, the voice, transcription and tools in Gemini schema', async () => {
    const { sockets, session } = harness()
    void session.start()
    const socket = sockets[0]!
    expect(socket.url).toBe('wss://live.test/ws?key=test-key')
    socket.open()
    const setup = socket.sent[0]?.['setup'] as Record<string, any>
    expect(setup['model']).toBe('models/gemini-test-live')
    expect(setup['generationConfig'].responseModalities).toEqual(['AUDIO'])
    expect(setup['generationConfig'].speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore')
    expect(setup['systemInstruction']).toEqual({ parts: [{ text: 'You are on a call.' }] })
    expect(setup['inputAudioTranscription']).toEqual({})
    expect(setup['outputAudioTranscription']).toEqual({})
    const declaration = setup['tools'][0].functionDeclarations[0]
    expect(declaration.name).toBe('show_on_screen')
    expect(declaration.parameters).toEqual({ type: 'OBJECT', properties: { title: { type: 'STRING' } }, required: ['title'] })
  })

  it('queues microphone audio until the setup is accepted, then streams 16 kHz PCM', async () => {
    const { sockets, session, events } = harness()
    const started = session.start()
    const socket = sockets[0]!
    socket.open()
    session.audio(Buffer.from([1, 2, 3, 4]))
    expect(socket.sent).toHaveLength(1) // only the setup
    socket.push({ setupComplete: {} })
    await started
    const audio = socket.sent[1]?.['realtimeInput'] as { audio: { data: string; mimeType: string } }
    expect(audio.audio.mimeType).toBe('audio/pcm;rate=16000')
    expect(Buffer.from(audio.audio.data, 'base64')).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(events).toContainEqual({ type: 'state', state: 'listening' })
  })

  it('builds captions from transcription fragments and finishes them on turnComplete', async () => {
    const { socket, events, session } = await connected()
    socket.push({ serverContent: { inputTranscription: { text: 'What is' } } })
    socket.push({ serverContent: { inputTranscription: { text: ' due?' } } })
    socket.push({ serverContent: { outputTranscription: { text: 'Three' } } })
    socket.push({ serverContent: { outputTranscription: { text: ' things.' } } })
    socket.push({ serverContent: { turnComplete: true } })
    await flush()
    const finals = events.filter((event) => event.type === 'caption' && event.final)
    expect(finals.map((event) => (event.type === 'caption' ? [event.line.who, event.line.text] : []))).toEqual([
      ['you', 'What is due?'],
      ['agent', 'Three things.'],
    ])
    expect(session.lines.map((line) => line.text)).toEqual(['What is due?', 'Three things.'])
  })

  it('turns amber (waiting) only after the agent asked the person something', async () => {
    const { socket, events } = await connected()
    socket.push({ serverContent: { outputTranscription: { text: 'Shall I book it?' } } })
    socket.push({ serverContent: { turnComplete: true } })
    await flush()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'waiting' })
    socket.push({ serverContent: { outputTranscription: { text: 'Done.' } } })
    socket.push({ serverContent: { turnComplete: true } })
    await flush()
    expect(events.at(-1)).toEqual({ type: 'state', state: 'listening' })
  })

  it('passes model audio through and drops it when the person interrupts', async () => {
    const { socket, events } = await connected()
    socket.push({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'AAAA' } }] } } })
    socket.push({ serverContent: { interrupted: true } })
    await flush()
    expect(events).toContainEqual({ type: 'state', state: 'speaking' })
    expect(events).toContainEqual({ type: 'audio', data: 'AAAA' })
    expect(events).toContainEqual({ type: 'interrupted' })
  })

  it('runs tool calls and answers each one with its id and name', async () => {
    const calls: string[] = []
    const h = harness({
      runTool: async (name, args) => {
        calls.push(`${name}:${JSON.stringify(args)}`)
        return 'It is on screen.'
      },
    })
    const started = h.session.start()
    const socket = h.sockets[0]!
    socket.open()
    socket.push({ setupComplete: {} })
    await started
    socket.push({ toolCall: { functionCalls: [{ id: 'call-1', name: 'show_on_screen', args: { title: 'Plan' } }] } })
    await flush()
    await flush()
    expect(calls).toEqual(['show_on_screen:{"title":"Plan"}'])
    expect(socket.sent.at(-1)).toEqual({
      toolResponse: { functionResponses: [{ id: 'call-1', name: 'show_on_screen', response: { result: 'It is on screen.' } }] },
    })
  })

  it('tells Gemini the stream paused on mute and sends nothing while muted', async () => {
    const { socket, session } = await connected()
    session.mute(true)
    expect(socket.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } })
    const before = socket.sent.length
    session.audio(Buffer.from([9, 9]))
    expect(socket.sent).toHaveLength(before)
    session.mute(false)
    session.audio(Buffer.from([9, 9]))
    expect(socket.sent).toHaveLength(before + 1)
  })

  it('retries once without the newer setup fields when Gemini rejects the setup (1007)', async () => {
    const { sockets, session } = harness()
    const started = session.start()
    sockets[0]!.open()
    expect(sockets[0]!.sent[0]?.['setup']).toHaveProperty('contextWindowCompression')
    sockets[0]!.drop(1007)
    const retry = sockets[1]!
    retry.open()
    expect(retry.sent[0]?.['setup']).not.toHaveProperty('contextWindowCompression')
    expect(retry.sent[0]?.['setup']).not.toHaveProperty('sessionResumption')
    retry.drop(1008)
    await expect(started).rejects.toThrow('not accepted')
  })

  it('reconnects a dropped call with the resumption handle Gemini gave it', async () => {
    const { socket, sockets } = await connected()
    socket.push({ sessionResumptionUpdate: { newHandle: 'handle-7', resumable: true } })
    await flush()
    socket.drop(1006)
    const again = sockets[1]!
    again.open()
    expect((again.sent[0]?.['setup'] as Record<string, unknown>)['sessionResumption']).toEqual({ handle: 'handle-7' })
  })

  it('hangs up cleanly and keeps the transcript', async () => {
    const { socket, session, events } = await connected()
    socket.push({ serverContent: { inputTranscription: { text: 'Bye' } } })
    await flush()
    session.end()
    expect(socket.closed).toBe(1000)
    expect(session.lines.map((line) => line.text)).toEqual(['Bye'])
    expect(events.at(-1)).toEqual({ type: 'state', state: 'ended' })
  })
})

describe('Gemini schema and captions', () => {
  it('maps JSON schema types to Gemini types, nested arrays included', () => {
    expect(
      geminiSchema({ type: 'object', properties: { items: { type: 'array', items: { type: 'string' }, description: 'Points' } } }),
    ).toEqual({ type: 'OBJECT', properties: { items: { type: 'ARRAY', description: 'Points', items: { type: 'STRING' } } } })
  })

  it('joins transcription fragments without doubling or losing spaces', () => {
    expect(joinChunk('', '  Hello')).toBe('Hello')
    expect(joinChunk('Hello', ' there')).toBe('Hello there')
    expect(joinChunk('Hel', 'lo')).toBe('Hello')
  })
})

// ---- the REST side ----------------------------------------------------------------------------

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const { status, body } = handler(url, init)
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, calls }
}

describe('Gemini REST: check, speak, transcribe', () => {
  it('checks the key with one model listing and picks models the key can reach, key in a header only', async () => {
    const fetch = fakeFetch(() => ({
      status: 200,
      body: { models: [{ name: 'models/gemini-3.1-flash-live-preview' }, { name: 'models/gemini-2.5-flash-preview-tts' }] },
    }))
    const result = await checkKey({ key: () => 'secret-key', fetchImpl: fetch.impl })
    expect(result.ok).toBe(true)
    expect(result.choice?.live).toBe('gemini-3.1-flash-live-preview')
    expect(result.choice?.tts).toBe('gemini-2.5-flash-preview-tts')
    expect(fetch.calls).toHaveLength(1)
    expect(fetch.calls[0]!.url).not.toContain('secret-key')
    expect((fetch.calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key')
  })

  it('says plainly when the key is missing or refused', async () => {
    expect((await checkKey({ key: () => null })).message).toBe('Add a Gemini key first.')
    const fetch = fakeFetch(() => ({ status: 400, body: { error: { message: 'API key not valid. Please pass a valid API key.' } } }))
    const result = await checkKey({ key: () => 'bad', fetchImpl: fetch.impl })
    expect(result).toEqual({ ok: false, message: 'That Gemini key was not accepted.' })
  })

  it('speaks with the chosen voice, skips a model that 404s, and strips a WAV header', async () => {
    const pcm = Buffer.from([1, 0, 2, 0])
    const wav = wavFromPcm(pcm, 24_000)
    const fetch = fakeFetch((url, init) => {
      if (url.includes('gemini-3.8-flash-tts')) return { status: 404, body: { error: { message: 'not found' } } }
      const body = JSON.parse(String(init.body)) as Record<string, any>
      expect(body['generationConfig'].speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck')
      expect(body['contents'][0].parts[0].text).toBe('Hello there')
      return { status: 200, body: { candidates: [{ content: { parts: [{ inlineData: { data: wav.toString('base64') } }] } }] } }
    })
    const out = await speak({ key: () => 'k', fetchImpl: fetch.impl }, '**Hello** [there](https://example.com)', 'Puck', DEFAULT_CHOICE)
    expect(out).toEqual(pcm)
    expect(fetch.calls.map((call) => call.url.split('/models/')[1])).toEqual([
      'gemini-3.8-flash-tts:generateContent',
      'gemini-3.1-flash-tts-preview:generateContent',
    ])
  })

  it('transcribes a dictation as one WAV attachment', async () => {
    const fetch = fakeFetch((_url, init) => {
      const part = (JSON.parse(String(init.body)) as Record<string, any>)['contents'][0].parts[1]
      expect(part.inlineData.mimeType).toBe('audio/wav')
      const bytes = Buffer.from(part.inlineData.data, 'base64')
      expect(bytes.toString('ascii', 0, 4)).toBe('RIFF')
      expect(bytes.readUInt32LE(24)).toBe(16_000)
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: ' Call the bank tomorrow. ' }] } }] } }
    })
    const text = await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, Buffer.alloc(3200), DEFAULT_CHOICE)
    expect(text).toBe('Call the bank tomorrow.')
  })

  it('tells the one-call transcription the names to spell, and moves on from a busy model', async () => {
    const fetch = fakeFetch((url, init) => {
      if (url.includes('gemini-3.5-flash-lite')) return { status: 503, body: { error: { message: 'high demand' } } }
      const prompt = (JSON.parse(String(init.body)) as Record<string, any>)['contents'][0].parts[0].text as string
      expect(prompt).toContain('LondaCorp, Mthashana')
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Call Mthashana at LondaCorp.' }] } }] } }
    })
    const text = await transcribe({ key: () => 'k', fetchImpl: fetch.impl }, Buffer.alloc(3200), DEFAULT_CHOICE, { names: ['LondaCorp', 'Mthashana'] })
    expect(text).toBe('Call Mthashana at LondaCorp.')
    expect(fetch.calls).toHaveLength(2)
  })

  it('a transcription that never answers gives up at its time limit with plain words', async () => {
    const hanging: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })
    const started = Date.now()
    await expect(transcribe({ key: () => 'k', fetchImpl: hanging }, Buffer.alloc(3200), DEFAULT_CHOICE, { signal: AbortSignal.timeout(150) })).rejects.toMatchObject({
      status: -1,
    })
    expect(Date.now() - started).toBeLessThan(2000)
    const { explain } = await import('../src/main/voice/gemini')
    const { GeminiError } = await import('../src/main/voice/gemini')
    expect(explain(new GeminiError(-1, 'timeout'))).toBe('Gemini took too long to answer.')
  })

  it('reads markdown as plain speech and leaves bare PCM alone', () => {
    expect(plainForSpeech('# Plan\n- **one** item\n- `two`')).toBe('Plan one item two')
    const raw = Buffer.from([5, 6, 7, 8])
    expect(stripWav(raw)).toBe(raw)
  })
})

// ---- the service, end to end against a real store --------------------------------------------

describe('VoiceService', () => {
  let dir = ''
  let store: Store
  let settings: SettingsStore
  let secrets: Map<string, string>
  let sent: string[]
  let events: CallEvent[]
  let sockets: FakeSocket[]
  let clock = 0

  const secretsLike = {
    get: (name: string) => secrets.get(name) ?? null,
    set: (name: string, value: string) => void secrets.set(name, value),
    delete: (name: string) => void secrets.delete(name),
  }

  function service(): VoiceService {
    return new VoiceService({
      secrets: secretsLike,
      settings,
      store,
      runner: {
        send: async (text) => {
          sent.push(text)
          // A real run takes a long time; the call must not wait for it.
          await new Promise(() => undefined)
        },
        state: () => ({ running: false, waiting: [] }),
      },
      emit: (event) => events.push(event),
      socket: (url) => {
        const socket = new FakeSocket(url)
        sockets.push(socket)
        setTimeout(() => {
          socket.open()
          socket.push({ setupComplete: {} })
        }, 0)
        return socket
      },
      now: () => clock,
      platform: 'linux',
      timeZone: 'UTC',
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-voice-'))
    store = new Store(join(dir, 'agent.db'))
    settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test' })
    secrets = new Map()
    sent = []
    events = []
    sockets = []
    clock = 1_700_000_000_000
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps the key in secrets only and shows a calm message without one', async () => {
    const voice = service()
    expect(await voice.callStart()).toEqual({ ok: false, message: 'Add a Gemini key in Settings to talk.' })
    expect(await voice.transcribe(Buffer.alloc(10))).toEqual({ ok: false, error: 'Add a Gemini key in Settings to talk.' })
    voice.setKey('  gem-key  ')
    expect(secrets.get('geminiKey')).toBe('gem-key')
    expect(settings.get().hasVoiceKey).toBe(true)
    expect(JSON.stringify(settings.get())).not.toContain('gem-key')
    voice.setKey('')
    expect(secrets.has('geminiKey')).toBe(false)
    expect(settings.get().hasVoiceKey).toBe(false)
  })

  it('knows the person from memory and the chat, hands work to the main agent and saves the call', async () => {
    settings.save({ userName: 'Sam', agentName: 'Nova', voiceName: 'Puck' })
    await store.upsert('memory', { title: 'Sam prefers window seats', body: 'Always book a window seat.', kind: 'preference', pinned: true })
    await store.upsert('chat_item', { kind: 'user', text: 'Find me a flight to Durban', meta: '{}' })
    const voice = service()
    voice.setKey('gem-key')
    const started = await voice.callStart()
    expect(started.ok).toBe(true)

    const socket = sockets[0]!
    const setup = socket.sent[0]?.['setup'] as Record<string, any>
    const prompt = setup['systemInstruction'].parts[0].text as string
    expect(prompt).toContain('window seat')
    expect(prompt).toContain('live voice call')
    expect(prompt).toContain('Find me a flight to Durban')
    expect(setup['generationConfig'].speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Puck')
    const names = setup['tools'][0].functionDeclarations.map((tool: { name: string }) => tool.name)
    expect(names).toEqual(expect.arrayContaining(['hand_to_agent', 'show_on_screen', 'memory_search', 'task_list']))

    socket.push({ serverContent: { inputTranscription: { text: 'Book the 06:05 and show me the plan' } } })
    socket.push({
      toolCall: {
        functionCalls: [
          { id: 'a', name: 'hand_to_agent', args: { task: 'Book SkyHop SH 151 for Sam, window seat' } },
          { id: 'b', name: 'show_on_screen', args: { kind: 'list', title: 'The plan', items: ['Book the flight', 'Send the receipt'] } },
        ],
      },
    })
    await flush()
    await flush()
    await flush()
    expect(sent).toEqual(['From our voice call: Book SkyHop SH 151 for Sam, window seat'])
    const responses = socket.sent.filter((message) => 'toolResponse' in message)
    expect(responses).toHaveLength(2)
    const visual = events.find((event) => event.type === 'visual')
    expect(visual?.type === 'visual' && visual.visual.items).toEqual(['Book the flight', 'Send the receipt'])

    clock += 3 * 60_000
    const summary = await voice.callEnd()
    expect(summary?.durationMs).toBe(180_000)
    const rows = await store.list('chat_item')
    const call = rows.find((row) => row.kind === 'call')
    expect(call?.text).toBe('Call, 3 min')
    expect(call?.createdAt).toBe(1_700_000_000_000)
    const meta = JSON.parse(call?.meta ?? '{}') as { lines: Array<{ who: string; text: string }> }
    expect(meta.lines.map((line) => line.who)).toEqual(['you', 'note'])
    const shown = rows.find((row) => row.kind === 'agent' && row.text.includes('The plan'))
    expect(shown?.text).toContain('- Book the flight')
    expect(await voice.callEnd()).toBeNull()
  })
})

// ---- keyless calls from a paired device ---------------------------------------------------------

describe('Live tokens for a paired device with no key', () => {
  let dir = ''
  let store: Store
  let settings: SettingsStore
  let secrets: Map<string, string>

  const models = { models: [{ name: 'models/gemini-3.1-flash-live-preview' }] }

  function service(fetchImpl: typeof fetch): VoiceService {
    return new VoiceService({
      secrets: {
        get: (name) => secrets.get(name) ?? null,
        set: (name, value) => void secrets.set(name, value),
        delete: (name) => void secrets.delete(name),
      },
      settings,
      store,
      runner: { send: async () => undefined, state: () => ({ running: false, waiting: [] }) },
      emit: () => undefined,
      fetchImpl,
      now: () => 1_700_000_000_000,
      platform: 'linux',
      timeZone: 'UTC',
    })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-livetoken-'))
    store = new Store(join(dir, 'agent.db'))
    settings = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test' })
    secrets = new Map()
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('mints a one-use token locked to the Live model, key in a header only', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: { name: 'auth_tokens/abc123' } }))
    const minted = await mintLiveToken({ key: () => 'secret-key', fetchImpl: fetch.impl }, 'gemini-3.8-live', 1_000_000)
    expect(minted).toEqual({ token: 'auth_tokens/abc123', expiresAt: 1_000_000 + LIVE_TOKEN_TTL_MS })
    const call = fetch.calls[0]!
    expect(call.url).toBe('https://generativelanguage.googleapis.com/v1beta/auth_tokens')
    expect(call.url).not.toContain('secret-key')
    expect((call.init.headers as Record<string, string>)['x-goog-api-key']).toBe('secret-key')
    const body = JSON.parse(String(call.init.body)) as Record<string, any>
    expect(body['uses']).toBe(1)
    expect(body['bidiGenerateContentSetup']).toEqual({ model: 'models/gemini-3.8-live' })
    expect(Date.parse(body['expireTime'])).toBe(1_000_000 + LIVE_TOKEN_TTL_MS)
    expect(Date.parse(body['newSessionExpireTime'])).toBe(1_000_000 + LIVE_TOKEN_START_MS)
    expect(LIVE_TOKEN_URL).toMatch(/BidiGenerateContentConstrained$/)
  })

  it('tells the device to add the key on the computer when there is none, and never returns the key', async () => {
    const fetch = fakeFetch((url) => (url.includes('/models') ? { status: 200, body: models } : { status: 200, body: { name: 'auth_tokens/t1' } }))
    const voice = service(fetch.impl)
    const none = await voice.liveToken()
    expect(none).toMatchObject({ ok: false, needsKey: true })
    expect(fetch.calls).toHaveLength(0)

    voice.setKey('gem-key')
    settings.save({ voiceName: 'Puck' })
    const result = await voice.liveToken()
    expect(result).toEqual({
      ok: true,
      token: 'auth_tokens/t1',
      url: LIVE_TOKEN_URL,
      model: 'gemini-3.1-flash-live-preview',
      voice: 'Puck',
      expiresAt: 1_700_000_000_000 + LIVE_TOKEN_TTL_MS,
    })
    expect(JSON.stringify(result)).not.toContain('gem-key')
  })

  it('says plainly when Google refuses the token', async () => {
    const fetch = fakeFetch((url) => (url.includes('/models') ? { status: 200, body: models } : { status: 429, body: { error: { message: 'quota' } } }))
    const voice = service(fetch.impl)
    voice.setKey('gem-key')
    expect(await voice.liveToken()).toEqual({ ok: false, needsKey: false, error: 'Gemini says this key is out of quota for now. Try again later.' })
  })

  it("saves a device's call in this chat as one call row, dropping malformed lines", async () => {
    const voice = service(fakeFetch(() => ({ status: 200, body: {} })).impl)
    const record = deviceCall({
      startedAt: 1_700_000_000_000,
      durationMs: 125_000,
      lines: [
        { who: 'you', text: 'Book the dentist', at: 1_700_000_001_000 },
        { who: 'agent', text: 'On it.', at: 1_700_000_002_000 },
        { who: 'system', text: 'nope', at: 1 },
        { who: 'you', text: '   ', at: 1 },
        'junk',
      ],
    })
    expect(record.lines).toHaveLength(2)
    const saved = await voice.callSave(record)
    const row = (await store.list('chat_item')).find((item) => item.kind === 'call')
    expect(saved?.itemId).toBe(row?.id)
    expect(row?.text).toBe('Call, 2 min')
    expect(row?.createdAt).toBe(1_700_000_000_000)
    const meta = JSON.parse(row?.meta ?? '{}') as { lines: Array<{ who: string; text: string }>; device: boolean }
    expect(meta.lines).toEqual([
      { who: 'you', text: 'Book the dentist', at: 1_700_000_001_000 },
      { who: 'agent', text: 'On it.', at: 1_700_000_002_000 },
    ])
    expect(meta.device).toBe(true)
    expect(await voice.callSave({ startedAt: 1, durationMs: 0, lines: [] })).toBeNull()
    expect(() => deviceCall({ startedAt: 'x', durationMs: 1, lines: [] })).toThrow()
  })

  it('lets a paired device ask for a token and save a call, but never set the key', () => {
    expect(RPC_ALLOWED.has('voice.liveToken')).toBe(true)
    expect(RPC_ALLOWED.has('voice.callSave')).toBe(true)
    expect(RPC_ALLOWED.has('voice.setKey')).toBe(false)
  })
})

// ---- tools, permissions, settings, audio maths -------------------------------------------------

describe('voice tools and guards', () => {
  it('validates what may go on screen: https images only, lists need items', () => {
    expect(visualFrom({ kind: 'image', title: 'Map', image_url: 'http://example.com/a.png' })).toBe('image_url must be an https address.')
    expect(visualFrom({ kind: 'list', title: 'Steps', items: [] })).toBe('A list needs at least one item.')
    expect(visualFrom({ kind: 'card', title: 'Fare', body: 'R 899', footnote: 'SkyHop' })).toEqual({
      kind: 'card',
      title: 'Fare',
      body: 'R 899',
      footnote: 'SkyHop',
    })
    expect(visualMarkdown({ kind: 'image', title: 'Map', imageUrl: 'https://example.com/a.png' })).toBe(
      '**Map**\n\n![Map](https://example.com/a.png)',
    )
  })

  it('gives the voice agent only its own tools', () => {
    const fake = { list: async () => [], get: async () => null, upsert: async () => ({}) as never, remove: async () => undefined }
    const names = voiceTools({ store: fake, handToAgent: async () => ({ queued: false }), show: async () => undefined }).map(
      (tool) => tool.spec.name,
    )
    expect(names.sort()).toEqual(['hand_to_agent', 'memory_get', 'memory_search', 'now', 'show_on_screen', 'task_list'])
  })

  it('grants the microphone only to the app window and never the camera', () => {
    expect(mediaAllowed(true, ['audio'])).toBe(true)
    expect(mediaAllowed(true, ['audio', 'video'])).toBe(false)
    expect(mediaAllowed(false, ['audio'])).toBe(false)
    expect(mediaAllowed(true, [])).toBe(false)
  })

  it('stores a known voice and ignores an unknown one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-voice-settings-'))
    try {
      const store = new SettingsStore(join(dir, 'settings.json'), { hostname: () => 'test' })
      expect(store.get().voiceName).toBe(DEFAULT_SETTINGS.voiceName)
      store.save({ voiceName: 'Charon', speakReplies: true } as Partial<Settings>)
      store.save({ voiceName: 'Not a voice' })
      expect(store.get().voiceName).toBe('Charon')
      expect(store.get().speakReplies).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('audio maths', () => {
  it('downsamples 48 kHz to 16 kHz and round-trips PCM16', () => {
    const input = new Float32Array(4800).map((_, index) => Math.sin(index / 10) * 0.5)
    const small = downsample(input, 48_000)
    expect(small.length).toBe(1600)
    const back = pcm16ToFloat(floatToPcm16(small))
    expect(back.length).toBe(1600)
    for (let index = 0; index < back.length; index += 97) expect(Math.abs((back[index] ?? 0) - (small[index] ?? 0))).toBeLessThan(0.001)
  })

  it('meters silence as zero and speech as most of the range', () => {
    expect(level(new Float32Array(256))).toBe(0)
    expect(level(new Float32Array(256).fill(0.25))).toBeCloseTo(0.8)
    expect(level(new Float32Array(256).fill(1))).toBe(1)
  })

  it('springs past its target and settles on it', () => {
    let value = 1
    let velocity = 0
    let peak = 1
    for (let frame = 0; frame < 240; frame += 1) {
      ;[value, velocity] = springStep(value, velocity, 1.2, 1 / 60)
      peak = Math.max(peak, value)
    }
    expect(peak).toBeGreaterThan(1.2)
    expect(value).toBeCloseTo(1.2, 3)
  })
})
