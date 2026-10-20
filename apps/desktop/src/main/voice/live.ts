/**
 * One Gemini Live call over a websocket, in the main process.
 *
 * Protocol (BidiGenerateContent, v1beta), as the phone app and the standalone voice agent speak it:
 *   -> setup { model, generationConfig{responseModalities AUDIO, speechConfig}, systemInstruction, tools,
 *              inputAudioTranscription, outputAudioTranscription, realtimeInputConfig, compression, resumption }
 *   <- setupComplete
 *   -> realtimeInput { audio { data, mimeType "audio/pcm;rate=16000" } }   (and audioStreamEnd on mute)
 *   <- serverContent { modelTurn.parts[].inlineData (24 kHz PCM16), inputTranscription, outputTranscription,
 *                      interrupted, turnComplete }
 *   <- toolCall { functionCalls[{ id, name, args }] }  ->  toolResponse { functionResponses[{ id, name, response }] }
 *   <- sessionResumptionUpdate { newHandle }, goAway
 *
 * The socket is injected, so tests drive the whole thing with a fake and no network.
 */
import type { CallEvent, CallLine, CallState, JsonObject, ToolSpec } from '@agent/core'

import { INPUT_RATE } from './gemini'

/** The part of a WebSocket this class uses. Node's global WebSocket fits it. */
export interface SocketLike {
  binaryType?: string
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type SocketFactory = (url: string) => SocketLike

export interface LiveOptions {
  url: string
  key: string
  model: string
  voice: string
  systemPrompt: string
  tools: ToolSpec[]
  socket: SocketFactory
  emit: (event: CallEvent) => void
  /** Runs one tool the voice agent called. Returns the result text the model hears back. */
  runTool: (name: string, args: JsonObject) => Promise<string>
  now?: () => number
  /** The language the person speaks. Without it Gemini sometimes transcribes English as French. */
  languageCode?: string
}

const MAX_QUEUED_CHUNKS = 50
const MAX_RECONNECTS = 3

export class LiveSession {
  private readonly options: LiveOptions
  private readonly now: () => number
  private socket: SocketLike | null = null
  private ready = false
  private closing = false
  private muted = false
  private extras = true
  private resumeHandle = ''
  private reconnects = 0
  private queue: string[] = []
  private state: CallState = 'connecting'
  private current: { line: CallLine } | null = null
  private sequence = 0
  readonly lines: CallLine[] = []
  readonly startedAt: number

  constructor(options: LiveOptions) {
    this.options = options
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
  }

  /** Resolves once Gemini accepted the setup; rejects with plain words when it did not. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setState('connecting')
      this.open(resolve, reject)
    })
  }

  get live(): boolean {
    return this.socket !== null && !this.closing
  }

  /** One chunk of 16 kHz mono PCM16. Queued until the setup is accepted; dropped while muted. */
  audio(pcm: Buffer): void {
    if (this.muted || this.closing || pcm.length === 0) return
    const message = JSON.stringify({
      realtimeInput: { audio: { data: pcm.toString('base64'), mimeType: `audio/pcm;rate=${INPUT_RATE}` } },
    })
    if (!this.ready) {
      this.queue.push(message)
      if (this.queue.length > MAX_QUEUED_CHUNKS) this.queue.shift()
      return
    }
    this.socket?.send(message)
  }

  /** Muting tells Gemini the stream paused, or its voice detection waits for the end of a sentence forever. */
  mute(muted: boolean): void {
    this.muted = muted
    if (muted && this.ready) this.socket?.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
  }

  /** A note in the transcript (for example, "Handed to your agent"). */
  note(text: string): void {
    this.finishLine()
    const line: CallLine = { id: this.nextId(), who: 'note', text, at: this.now() }
    this.lines.push(line)
    this.options.emit({ type: 'caption', line, final: true })
  }

  end(): void {
    if (this.closing) return
    this.closing = true
    this.finishLine()
    try {
      this.socket?.close(1000, 'Hung up')
    } catch {
      // Already closed.
    }
    this.socket = null
    this.setState('ended')
  }

  // ---- the wire --------------------------------------------------------------------------

  private open(resolve?: () => void, reject?: (error: Error) => void): void {
    const { url, key } = this.options
    const socket = this.options.socket(`${url}?key=${encodeURIComponent(key)}`)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.ready = false

    socket.onopen = () => {
      socket.send(JSON.stringify(this.setupMessage()))
    }
    socket.onerror = () => {
      // The close event that follows carries the code; nothing to do here.
    }
    socket.onmessage = (event) => {
      const message = parseMessage(event.data)
      if (message === null) return
      if ('setupComplete' in message) {
        this.ready = true
        this.reconnects = 0
        for (const queued of this.queue) socket.send(queued)
        this.queue = []
        this.setState('listening')
        resolve?.()
        resolve = undefined
        reject = undefined
        return
      }
      void this.onMessage(message)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      const wasReady = this.ready
      this.ready = false
      this.socket = null
      if (this.closing) return
      // A rejected setup with the newer fields: try once more without them (the phone does the same).
      if (!wasReady && event.code === 1007 && this.extras) {
        this.extras = false
        this.resumeHandle = ''
        this.open(resolve, reject)
        return
      }
      if (!wasReady && reject !== undefined) {
        this.closing = true
        this.setState('error', closeReason(event.code))
        reject(new Error(closeReason(event.code)))
        return
      }
      if (this.reconnects < MAX_RECONNECTS) {
        this.reconnects += 1
        if (event.code === 1011) this.extras = false
        this.open()
        return
      }
      this.closing = true
      this.finishLine()
      this.setState('error', 'The call dropped.')
    }
  }

  private setupMessage(): JsonObject {
    const { model, voice, systemPrompt, tools } = this.options
    const setup: JsonObject = {
      model: model.startsWith('models/') ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode: this.options.languageCode ?? 'en-US',
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
        },
      },
      systemInstruction: { parts: [{ text: systemPrompt }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: { automaticActivityDetection: {} },
    }
    if (tools.length > 0) {
      setup['tools'] = [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: geminiSchema(tool.schema),
          })),
        },
      ]
    }
    if (this.extras) {
      setup['contextWindowCompression'] = { slidingWindow: {} }
      setup['sessionResumption'] = this.resumeHandle === '' ? {} : { handle: this.resumeHandle }
    }
    return { setup }
  }

  private async onMessage(message: Record<string, unknown>): Promise<void> {
    const update = message['sessionResumptionUpdate'] as { newHandle?: unknown; resumable?: unknown } | undefined
    if (update !== undefined && typeof update.newHandle === 'string' && update.newHandle !== '') {
      this.resumeHandle = update.newHandle
    }

    const content = message['serverContent'] as Record<string, unknown> | undefined
    if (content !== undefined) this.content(content)

    const toolCall = message['toolCall'] as { functionCalls?: unknown } | undefined
    if (toolCall !== undefined && Array.isArray(toolCall.functionCalls)) {
      await this.toolCalls(toolCall.functionCalls as Array<Record<string, unknown>>)
    }
  }

  private content(content: Record<string, unknown>): void {
    const heard = textField(content['inputTranscription'])
    if (heard !== '') {
      this.append('you', heard)
      if (this.state !== 'speaking') this.setState('listening')
    }

    const said = textField(content['outputTranscription'])
    if (said !== '') this.append('agent', said)

    const turn = content['modelTurn'] as { parts?: unknown } | undefined
    if (turn !== undefined && Array.isArray(turn.parts)) {
      for (const part of turn.parts as Array<{ inlineData?: { data?: unknown; mimeType?: unknown } }>) {
        const data = part.inlineData?.data
        if (typeof data === 'string' && data !== '') {
          this.setState('speaking')
          this.options.emit({ type: 'audio', data })
        }
      }
    }

    if (content['interrupted'] === true) {
      this.options.emit({ type: 'interrupted' })
      this.finishLine()
      this.setState('listening')
    }

    if (content['turnComplete'] === true) {
      const asked = this.current?.line.who === 'agent' && /\?\s*$/.test(this.current.line.text)
      this.finishLine()
      // Amber means one thing: the agent is waiting for the person. Only after it asked them something.
      this.setState(asked ? 'waiting' : 'listening')
    }
  }

  private async toolCalls(calls: Array<Record<string, unknown>>): Promise<void> {
    this.setState('thinking')
    // Each answer goes back as soon as it is ready, so a slow tool does not hold up a quick one.
    await Promise.all(
      calls.map(async (call) => {
        const id = typeof call['id'] === 'string' ? call['id'] : ''
        const name = typeof call['name'] === 'string' ? call['name'] : ''
        const args = (typeof call['args'] === 'object' && call['args'] !== null ? call['args'] : {}) as JsonObject
        let result: string
        try {
          result = await this.options.runTool(name, args)
        } catch (error) {
          result = error instanceof Error ? `That did not work: ${error.message}` : 'That did not work.'
        }
        if (this.closing || !this.ready) return
        this.socket?.send(
          JSON.stringify({ toolResponse: { functionResponses: [{ id, name, response: { result } }] } }),
        )
      }),
    )
    if (this.state === 'thinking') this.setState('listening')
  }

  // ---- captions --------------------------------------------------------------------------

  private append(who: 'you' | 'agent', chunk: string): void {
    if (this.current !== null && this.current.line.who !== who) this.finishLine()
    if (this.current === null) {
      this.current = { line: { id: this.nextId(), who, text: '', at: this.now() } }
    }
    const line = this.current.line
    line.text = joinChunk(line.text, chunk)
    this.options.emit({ type: 'caption', line: { ...line }, final: false })
  }

  private finishLine(): void {
    const current = this.current
    this.current = null
    if (current === null) return
    const line = { ...current.line, text: current.line.text.trim() }
    if (line.text === '') return
    this.lines.push(line)
    this.options.emit({ type: 'caption', line, final: true })
  }

  private setState(state: CallState, message?: string): void {
    if (this.state === state && message === undefined) return
    this.state = state
    this.options.emit(message === undefined ? { type: 'state', state } : { type: 'state', state, message })
  }

  private nextId(): string {
    this.sequence += 1
    return `line-${this.startedAt}-${this.sequence}`
  }
}

/** Transcription arrives in fragments, some with their own leading space and some without. */
export function joinChunk(text: string, chunk: string): string {
  if (text === '') return chunk.trimStart()
  return `${text}${chunk}`
}

function textField(value: unknown): string {
  if (typeof value !== 'object' || value === null) return ''
  const text = (value as { text?: unknown }).text
  return typeof text === 'string' ? text : ''
}

function parseMessage(data: unknown): Record<string, unknown> | null {
  let text: string
  if (typeof data === 'string') text = data
  else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
  else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  else return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function closeReason(code: number): string {
  if (code === 1008) return 'That Gemini key was not accepted for live calls.'
  if (code === 1007) return 'Gemini did not accept the call setup.'
  if (code === 1011) return 'Gemini had a problem starting the call. Try again.'
  return 'Could not connect the call.'
}

/** JSON schema (lowercase types) to Gemini's Schema (uppercase types). Unknown keys are dropped. */
export function geminiSchema(value: JsonObject): JsonObject {
  const out: JsonObject = {}
  const type = value['type']
  if (typeof type === 'string') out['type'] = type.toUpperCase()
  if (typeof value['description'] === 'string') out['description'] = value['description']
  if (Array.isArray(value['enum'])) out['enum'] = value['enum']
  if (Array.isArray(value['required'])) out['required'] = value['required']
  const properties = value['properties']
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    const mapped: JsonObject = {}
    for (const [name, child] of Object.entries(properties)) {
      if (typeof child === 'object' && child !== null && !Array.isArray(child)) mapped[name] = geminiSchema(child)
    }
    out['properties'] = mapped
  }
  const items = value['items']
  if (typeof items === 'object' && items !== null && !Array.isArray(items)) out['items'] = geminiSchema(items)
  return out
}
