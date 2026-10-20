/**
 * The microphone and the speaker for voice. The renderer only moves audio: capture goes to the main
 * process as 16 kHz PCM16 over IPC, and what Gemini says comes back as 24 kHz PCM16 to play.
 *
 * Capture uses a ScriptProcessorNode rather than an AudioWorklet: the page's CSP allows scripts from
 * 'self' only and a packaged file:// worklet is fragile, while this node works everywhere Chromium runs.
 */
import { IN_RATE, OUT_RATE, base64ToBytes, downsample, floatToPcm16, level, pcm16ToFloat } from './pcm'

const CHUNK_SAMPLES = IN_RATE / 10 // 100 ms

export interface Capture {
  level(): number
  setMuted(muted: boolean): void
  stop(): void
}

export class MicError extends Error {}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

function audioContext(options?: AudioContextOptions): AudioContext {
  const Ctor = (window.AudioContext ??
    (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined
  if (Ctor === undefined) throw new MicError('This window cannot play or record audio.')
  return new Ctor(options)
}

/** Starts the microphone. Each 100 ms of speech arrives as PCM16 bytes. */
export async function startCapture(onChunk: (pcm: Uint8Array) => void): Promise<Capture> {
  if (navigator.mediaDevices?.getUserMedia === undefined) throw new MicError('No microphone is available here.')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch {
    throw new MicError('The microphone is off or blocked. Allow it for Agent in your system settings.')
  }
  const context = audioContext()
  const source = context.createMediaStreamSource(stream)
  const processor = context.createScriptProcessor(4096, 1, 1)
  const sink = context.createGain()
  sink.gain.value = 0
  let muted = false
  let current = 0
  let pending: Float32Array[] = []
  let pendingLength = 0

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    current = muted ? 0 : level(input)
    if (muted) return
    const small = downsample(input, context.sampleRate)
    pending.push(small)
    pendingLength += small.length
    while (pendingLength >= CHUNK_SAMPLES) {
      const joined = new Float32Array(pendingLength)
      let offset = 0
      for (const part of pending) {
        joined.set(part, offset)
        offset += part.length
      }
      onChunk(floatToPcm16(joined.subarray(0, CHUNK_SAMPLES)))
      const rest = joined.slice(CHUNK_SAMPLES)
      pending = rest.length > 0 ? [rest] : []
      pendingLength = rest.length
    }
  }
  source.connect(processor)
  processor.connect(sink)
  sink.connect(context.destination)

  return {
    level: () => current,
    setMuted: (value) => {
      muted = value
      for (const track of stream.getAudioTracks()) track.enabled = !value
    },
    stop: () => {
      processor.onaudioprocess = null
      processor.disconnect()
      source.disconnect()
      for (const track of stream.getTracks()) track.stop()
      void context.close().catch(() => undefined)
    },
  }
}

/** Plays Gemini's 24 kHz PCM16 chunks back to back, and meters them for the orb. */
export class Player {
  private context: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private nextStart = 0
  private sources = new Set<AudioBufferSourceNode>()
  private readonly samples = new Float32Array(512)
  onIdle: (() => void) | null = null

  private ensure(): { context: AudioContext; analyser: AnalyserNode } {
    if (this.context === null || this.analyser === null) {
      this.context = audioContext()
      this.analyser = this.context.createAnalyser()
      this.analyser.fftSize = 1024
      this.analyser.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined)
    return { context: this.context, analyser: this.analyser }
  }

  enqueue(data: string | Uint8Array): void {
    const bytes = typeof data === 'string' ? base64ToBytes(data) : data
    const floats = pcm16ToFloat(bytes)
    if (floats.length === 0) return
    const { context, analyser } = this.ensure()
    const buffer = context.createBuffer(1, floats.length, OUT_RATE)
    buffer.copyToChannel(floats, 0)
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(analyser)
    const start = Math.max(this.nextStart, context.currentTime + 0.02)
    source.start(start)
    this.nextStart = start + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      if (this.sources.size === 0) this.onIdle?.()
    }
  }

  /** The person spoke over it: stop now and forget what was queued. */
  flush(): void {
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // Already finished.
      }
    }
    this.sources.clear()
    this.nextStart = 0
  }

  get playing(): boolean {
    return this.sources.size > 0
  }

  level(): number {
    if (this.analyser === null || this.sources.size === 0) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    return level(this.samples)
  }

  close(): void {
    this.flush()
    void this.context?.close().catch(() => undefined)
    this.context = null
    this.analyser = null
  }
}
