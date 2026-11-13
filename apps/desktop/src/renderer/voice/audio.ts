/**
 * The microphone and the speaker for voice. The renderer only moves audio: capture goes to the main
 * process as 16 kHz PCM16 over IPC, and what Gemini says comes back as 24 kHz PCM16 to play.
 *
 * Rewritten 11 Nov 2026, because what went to Google was not what he said:
 *
 *  1. The microphone's own processing is off. Chromium's noise suppressor and automatic gain control are tuned for
 *     speech that already sounds like the training data (and for calls, not dictation): they pump quiet syllables up,
 *     swallow the ends of words, and squash the pitch changes an isiZulu speaker leans on. They were on by default and
 *     no test ever looked at the sound. Echo cancellation stays on, so dictating while the app is speaking still works.
 *  2. Sound is taken from an AudioWorklet on its own thread, so a busy window (a chat streaming in, a repaint) can no
 *     longer stall the microphone and drop a block. The old ScriptProcessorNode ran on the main thread and lost whole
 *     buffers silently when it was busy: words that were simply never sent.
 *  3. 48 kHz (or 44.1) becomes 16 kHz through a proper band-limited filter (pcm.ts), not a three-sample average.
 */
import { IN_RATE, OUT_RATE, Resampler, base64ToBytes, floatToPcm16, level, pcm16ToFloat } from './pcm'

const CHUNK_SAMPLES = IN_RATE / 10 // 100 ms of 16 kHz speech per message
const BLOCK_SAMPLES = 4096 // what the worklet hands over at a time (about 85 ms at 48 kHz)

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

/**
 * The tap that runs on the audio thread: it only collects the microphone's blocks and posts them on, so nothing here
 * can be delayed by the page. Kept as source text on purpose: the packaged window loads from file://, where a module
 * file cannot be imported, and a blob is the one way to give Chromium a worklet from inside the app.
 */
const TAP_SOURCE = `
class CaptureTap extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const size = (options && options.processorOptions && options.processorOptions.size) || 4096
    this.size = size
    this.block = new Float32Array(size)
    this.filled = 0
    this.alive = true
    this.port.onmessage = (event) => { if (event.data === 'stop') this.alive = false }
  }
  process(inputs) {
    if (!this.alive) return false
    const channels = inputs[0]
    const channel = channels && channels[0]
    if (!channel) return true
    for (let at = 0; at < channel.length; at += 1) {
      this.block[this.filled] = channel[at]
      this.filled += 1
      if (this.filled === this.size) {
        const whole = this.block
        this.port.postMessage(whole, [whole.buffer])
        this.block = new Float32Array(this.size)
        this.filled = 0
      }
    }
    return true
  }
}
registerProcessor('capture-tap', CaptureTap)
`

interface Tap {
  stop(): void
}

/** The microphone sound on the audio thread, or null when this build of Chromium will not take a worklet. */
async function startTap(context: AudioContext, source: AudioNode, sink: AudioNode, onBlock: (block: Float32Array) => void): Promise<Tap | null> {
  const worklets = context.audioWorklet as AudioWorklet | undefined
  if (worklets === undefined) return null
  let url: string | null = null
  try {
    url = URL.createObjectURL(new Blob([TAP_SOURCE], { type: 'text/javascript' }))
    await worklets.addModule(url)
  } catch {
    return null
  } finally {
    if (url !== null) URL.revokeObjectURL(url)
  }
  const node = new AudioWorkletNode(context, 'capture-tap', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { size: BLOCK_SAMPLES },
  })
  node.port.onmessage = (event: MessageEvent) => onBlock(event.data as Float32Array)
  source.connect(node)
  node.connect(sink)
  return {
    stop: () => {
      node.port.postMessage('stop')
      node.port.onmessage = null
      node.disconnect()
    },
  }
}

/** Starts the microphone. Each 100 ms of speech arrives as PCM16 bytes at 16 kHz. */
export async function startCapture(onChunk: (pcm: Uint8Array) => void): Promise<Capture> {
  if (navigator.mediaDevices?.getUserMedia === undefined) throw new MicError('No microphone is available here.')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Off on purpose (see the top of this file): Google's model wants his voice, not a phone call's idea of it.
        noiseSuppression: false,
        autoGainControl: false,
        // On: so dictating while the app reads something aloud does not put the app's own voice in the transcript.
        echoCancellation: true,
      },
    })
  } catch {
    throw new MicError('The microphone is off or blocked. Allow it for Agent in your system settings.')
  }
  const context = audioContext()
  const source = context.createMediaStreamSource(stream)
  const sink = context.createGain()
  sink.gain.value = 0
  sink.connect(context.destination)
  let muted = false
  let current = 0
  const resampler = new Resampler(context.sampleRate)
  let pending: Float32Array[] = []
  let pendingLength = 0

  const take = (small: Float32Array): void => {
    if (small.length === 0) return
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

  const onBlock = (block: Float32Array): void => {
    current = muted ? 0 : level(block)
    if (muted) return
    take(resampler.push(block))
  }

  const tap = await startTap(context, source, sink, onBlock)
  // This build would not take the worklet: the script processor is the old path, and it loses blocks when the window is
  // busy, so it is the fallback and never the first choice.
  let processor: ScriptProcessorNode | null = null
  if (tap === null) {
    processor = context.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (event) => onBlock(event.inputBuffer.getChannelData(0).slice())
    source.connect(processor)
    processor.connect(sink)
  }

  return {
    level: () => current,
    setMuted: (value) => {
      muted = value
      for (const track of stream.getAudioTracks()) track.enabled = !value
    },
    stop: () => {
      tap?.stop()
      if (processor !== null) {
        processor.onaudioprocess = null
        processor.disconnect()
      }
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
