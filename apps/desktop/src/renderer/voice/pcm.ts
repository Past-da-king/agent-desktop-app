/**
 * Pure audio maths for voice, no Web Audio here so it is testable in Node.
 * Gemini takes 16 kHz mono PCM16 little-endian in and sends 24 kHz mono PCM16 out.
 */
export const IN_RATE = 16_000
export const OUT_RATE = 24_000

/**
 * Band-limited resampling (11 Nov 2026).
 *
 * The microphone runs at the sound card's own rate (48 kHz, and 44.1 kHz on plenty of laptops). Turning that into the
 * 16 kHz the speech models want means throwing away two thirds of the samples, and a stream may only be thinned after
 * everything above the new half-rate has been removed. Averaging a few neighbours (what this file used to do) is a
 * two- or three-tap filter: it leaves most of the 8-16 kHz band in place, and every bit of that folds back down into
 * the speech band as false sound on top of his voice (a 9 kHz hiss lands on 7 kHz, a 12 kHz one on 4 kHz). That is
 * mush to a recogniser, and one of the reasons words came back wrong.
 *
 * So: a windowed-sinc low-pass at the new Nyquist, evaluated at the exact fractional positions the output needs, with
 * the tail of the last block kept so that a block boundary is not a seam.
 */
const TAPS = 48 // half-width of the filter, in input samples: every output sample looks this far either way
const ROLLOFF = 0.82 // cutoff below the new Nyquist, so the whole transition band sits under it and nothing folds back
const FRACTIONS = 256 // the fractional offsets the kernel is precomputed for

/** A Blackman-windowed sinc kernel for one fractional offset, normalised to sum to 1. */
export function resampleKernel(frac: number, cutoff: number, halfWidth = TAPS): Float32Array {
  const out = new Float32Array(halfWidth * 2)
  let sum = 0
  for (let tap = 0; tap < out.length; tap += 1) {
    const offset = tap - (halfWidth - 1) - frac
    const x = cutoff * offset
    const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    const w = (offset + halfWidth) / (2 * halfWidth)
    const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * w) + 0.08 * Math.cos(4 * Math.PI * w)
    const value = cutoff * sinc * window
    out[tap] = value
    sum += value
  }
  if (sum !== 0) for (let tap = 0; tap < out.length; tap += 1) out[tap] = (out[tap] ?? 0) / sum
  return out
}

/**
 * One stream's worth of resampling state: push blocks of any length, get them back at [to], continuous across blocks.
 * `passthrough` streams (rate already right) hand the input straight back.
 */
export class Resampler {
  readonly from: number
  readonly to: number
  private readonly ratio: number
  private readonly cutoff: number
  private readonly weights: Float32Array[] = []
  /** The last TAPS samples of what came before, so the next block's first outputs are whole. */
  private history: Float32Array
  /** Where the next output sits, counted from the start of `history`. */
  private position: number

  constructor(from: number, to: number = IN_RATE) {
    this.from = from > 0 ? from : to
    this.to = to > 0 ? to : from
    this.ratio = this.from / this.to
    // In input-sample units the new Nyquist sits at 0.5 * to/from; below that is kept, above it goes.
    this.cutoff = 0.5 * Math.min(1, this.to / this.from) * ROLLOFF
    this.history = new Float32Array(TAPS)
    this.position = TAPS
    for (let step = 0; step < FRACTIONS; step += 1) this.weights.push(resampleKernel(step / FRACTIONS, this.cutoff))
  }

  get passthrough(): boolean {
    return this.from === this.to
  }

  push(input: Float32Array): Float32Array {
    if (this.passthrough || input.length === 0) return input
    const data = new Float32Array(this.history.length + input.length)
    data.set(this.history, 0)
    data.set(input, this.history.length)
    const out: number[] = []
    const span = TAPS * 2
    while (true) {
      const at = this.position
      const first = Math.floor(at) - TAPS + 1
      if (first + span - 1 > data.length - 1) break
      const frac = at - Math.floor(at)
      const weights = this.weights[Math.min(FRACTIONS - 1, Math.round(frac * FRACTIONS))] ?? this.weights[0]
      let sum = 0
      for (let tap = 0; tap < span; tap += 1) sum += (data[first + tap] ?? 0) * (weights?.[tap] ?? 0)
      out.push(sum)
      this.position += this.ratio
    }
    // Keep the tail for the next block, and carry the fractional position over with it.
    if (data.length > TAPS) {
      this.history = data.slice(data.length - TAPS)
      this.position -= data.length - TAPS
    }
    return Float32Array.from(out)
  }
}

/** 48 kHz (or 44.1) to 16 kHz in one go, filtered properly. Kept for tests and one-shot use. */
export function downsample(input: Float32Array, fromRate: number, toRate: number = IN_RATE): Float32Array {
  if (fromRate === toRate) return input
  return new Resampler(fromRate, toRate).push(input)
}

export function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Uint8Array(input.length * 2)
  const view = new DataView(out.buffer)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index] ?? 0))
    view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return out
}

export function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const count = Math.floor(bytes.byteLength / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2)
  const out = new Float32Array(count)
  for (let index = 0; index < count; index += 1) out[index] = view.getInt16(index * 2, true) / 0x8000
  return out
}

export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data)
  const out = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index)
  return out
}

/** Loudness for the orb, 0 to 1: the RMS, lifted so normal speech fills most of the range. */
export function level(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0
    sum += sample * sample
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 3.2)
}

/** Joins chunks of PCM16 into one buffer (for a whole dictation). */
export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * A damped spring, one step. The orb uses it so the size overshoots a little and settles, the same
 * feel as the phone's spring(dampingRatio 0.6). Returns the new [value, velocity].
 */
export function springStep(
  value: number,
  velocity: number,
  target: number,
  dt: number,
  stiffness = 420,
  damping = 24,
): [number, number] {
  const step = Math.min(dt, 1 / 30)
  const force = stiffness * (target - value) - damping * velocity
  const nextVelocity = velocity + force * step
  return [value + nextVelocity * step, nextVelocity]
}
