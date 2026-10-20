/**
 * Pure audio maths for voice, no Web Audio here so it is testable in Node.
 * Gemini takes 16 kHz mono PCM16 little-endian in and sends 24 kHz mono PCM16 out.
 */
export const IN_RATE = 16_000
export const OUT_RATE = 24_000

/** Averages each output sample's window (a light low-pass), so 48 kHz speech does not alias. */
export function downsample(input: Float32Array, fromRate: number, toRate: number = IN_RATE): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(input.length, Math.floor((index + 1) * ratio))
    let sum = 0
    for (let at = start; at < end; at += 1) sum += input[at] ?? 0
    out[index] = end > start ? sum / (end - start) : 0
  }
  return out
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
