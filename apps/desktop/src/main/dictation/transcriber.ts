/**
 * Live transcription for dictation: Google's dedicated speech-to-text model over the Gemini Live API.
 *
 * Protocol (BidiGenerateContent, v1beta, ai.google.dev/gemini-api/docs/live-api/live-transcribe, read 21 Oct 2026):
 *   -> setup { model "models/gemini-3.5-transcribe-live", generationConfig{responseModalities ["TEXT"]},
 *              inputAudioTranscription { languageCodes, mode "VERBATIM" } }
 *   <- setupComplete
 *   -> realtimeInput { audio { data, mimeType "audio/pcm;rate=16000" } }, then realtimeInput { audioStreamEnd: true }
 *   <- serverContent { interimInputTranscription { text } }   a quick guess at the words being said now
 *   <- serverContent { inputTranscription { text } }          the settled words of one stretch of speech
 *
 * This model only transcribes: it never answers, so nothing it says can end up typed. Sessions run up to ten
 * minutes. The socket is injected (Node's own WebSocket in the app), so tests run it against a fake.
 */
import type { JsonObject } from '@agent/core'

import { INPUT_RATE } from '../voice/gemini'
import type { SocketFactory, SocketLike } from '../voice/live'

/** Google's live speech-to-text models, newest first. */
export const TRANSCRIBE_LIVE_MODELS = ['gemini-3.5-transcribe-live']

/** The longest a live transcription session may run (Google's limit is ten minutes). */
export const MAX_SESSION_MS = 9 * 60 * 1000 + 30 * 1000

const MAX_QUEUED_CHUNKS = 600 // a minute of 100 ms chunks while the socket connects
const CONNECT_TIMEOUT_MS = 10_000
/** After the stream ends, this long with nothing new means every word is in. */
const SETTLE_MS = 700

export interface TranscriberOptions {
  url: string
  key: string
  model: string
  socket: SocketFactory
  /** BCP-47 hints; empty lets the model detect the language. */
  languageCodes?: string[]
  /** The words so far: settled text and the guess still being heard. */
  onUpdate: (text: string, interim: string) => void
  /** The socket dropped after it was up. The caller can fall back to the recorded audio. */
  onDrop?: (reason: string) => void
}

export class LiveTranscriber {
  private readonly options: TranscriberOptions
  private socket: SocketLike | null = null
  private ready = false
  private closed = false
  private ended = false
  private queue: string[] = []
  private committed = ''
  private interim = ''
  private settle: (() => void) | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(options: TranscriberOptions) {
    this.options = options
  }

  /** Resolves once Google accepted the setup; rejects with plain words when it did not. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = setTimeout(() => {
        this.close()
        done(new Error('Gemini took too long to start listening.'))
      }, CONNECT_TIMEOUT_MS)

      let socket: SocketLike
      try {
        socket = this.options.socket(`${this.options.url}?key=${encodeURIComponent(this.options.key)}`)
      } catch (error) {
        done(error instanceof Error ? error : new Error('Could not reach Gemini.'))
        return
      }
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      socket.onopen = () => socket.send(JSON.stringify(setupMessage(this.options)))
      socket.onerror = () => {
        // The close event that follows carries the code.
      }
      socket.onmessage = (event) => {
        const message = parseMessage(event.data)
        if (message === null) return
        if ('setupComplete' in message) {
          this.ready = true
          for (const queued of this.queue) socket.send(queued)
          this.queue = []
          done()
          return
        }
        this.onMessage(message)
      }
      socket.onclose = (event) => {
        if (this.socket !== socket) return
        const wasReady = this.ready
        this.socket = null
        this.ready = false
        if (this.closed) return
        this.closed = true
        if (!wasReady) {
          done(new Error(closeReason(event.code)))
          return
        }
        // Whatever was settled stays; the caller decides what to do with the rest.
        this.finishSettling()
        if (!this.ended) this.options.onDrop?.(closeReason(event.code))
      }
    })
  }

  get live(): boolean {
    return this.ready && !this.closed
  }

  /** Every word heard so far, the guess included. */
  text(): string {
    return joinSegment(this.committed, this.interim)
  }

  /** One chunk of 16 kHz mono PCM16. Held until the setup is accepted. */
  audio(pcm: Buffer): void {
    if (this.closed || this.ended || pcm.length === 0) return
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

  /**
   * The person stopped: tell Google the stream ended and wait for the last words to settle, at most `waitMs`.
   * Resolves with the whole text (a guess that never settled is kept). Rejects when the session never started.
   */
  async finish(waitMs: number): Promise<string> {
    if (!this.ready) {
      this.close()
      throw new Error('Gemini was not listening yet.')
    }
    this.ended = true
    try {
      this.socket?.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }))
    } catch {
      // A socket that is closing has nothing more to say.
    }
    await new Promise<void>((resolve) => {
      const cap = setTimeout(() => this.finishSettling(), waitMs)
      this.settle = () => {
        clearTimeout(cap)
        resolve()
      }
      this.armSettle()
    })
    const text = this.text()
    this.close()
    return text
  }

  /** Stop waiting: whatever has been heard is the answer. */
  flush(): void {
    this.finishSettling()
  }

  close(): void {
    this.closed = true
    this.ready = false
    this.queue = []
    const socket = this.socket
    this.socket = null
    try {
      socket?.close(1000, 'Done')
    } catch {
      // Already closed.
    }
    this.finishSettling()
  }

  private onMessage(message: Record<string, unknown>): void {
    const content = message['serverContent'] as Record<string, unknown> | undefined
    if (content === undefined) return
    let changed = false
    const guess = textField(content['interimInputTranscription'])
    if (guess !== null) {
      this.interim = guess
      changed = true
    }
    const settled = textField(content['inputTranscription'])
    if (settled !== null && settled !== '') {
      this.committed = joinSegment(this.committed, settled)
      this.interim = ''
      changed = true
    }
    if (changed) this.options.onUpdate(this.committed, this.interim)
    if (this.ended) {
      if (content['turnComplete'] === true && this.interim === '') this.finishSettling()
      else this.armSettle()
    }
  }

  /** After the stream ended: settle once nothing new has come for a moment and no guess is pending. */
  private armSettle(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer)
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      if (this.interim === '') this.finishSettling()
    }, SETTLE_MS)
  }

  private finishSettling(): void {
    if (this.settleTimer !== null) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    const settle = this.settle
    this.settle = null
    settle?.()
  }
}

export function setupMessage(options: Pick<TranscriberOptions, 'model' | 'languageCodes'>): JsonObject {
  const model = options.model.startsWith('models/') ? options.model : `models/${options.model}`
  return {
    setup: {
      model,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: options.languageCodes ?? [], mode: 'VERBATIM' },
    },
  }
}

/**
 * Settled stretches of speech arrive one at a time, without the space between them. A stretch that starts
 * with its own space, or with punctuation, is joined as it is.
 */
export function joinSegment(text: string, segment: string): string {
  if (segment === '') return text
  if (text === '') return segment.trimStart()
  if (/^[\s,.;:!?)]/.test(segment) || /\s$/.test(text)) return `${text}${segment}`
  return `${text} ${segment}`
}

/**
 * A hint for the language: the app's locale when Google lists that English, British English for other English
 * locales (South Africa, Australia), and automatic detection for everything else.
 */
export function languageHint(locale: string): string[] {
  const tag = locale.trim().replace('_', '-')
  if (!/^en\b/i.test(tag)) return []
  if (/^en-US$/i.test(tag)) return ['en-US']
  if (/^en-IN$/i.test(tag)) return ['en-IN']
  return ['en-GB']
}

function textField(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const text = (value as { text?: unknown }).text
  return typeof text === 'string' ? text : null
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
  if (code === 1008) return 'That Gemini key was not accepted for live transcription.'
  if (code === 1007) return 'Gemini did not accept the transcription setup.'
  if (code === 1011) return 'Gemini had a problem listening. Try again.'
  return 'Could not reach Gemini. Check the connection.'
}
