import { describe, expect, it } from 'vitest'

import { IN_RATE, Resampler, downsample } from '../src/renderer/voice/pcm'

/** A sine at `hz` sampled at `rate`, `seconds` long. */
function sine(hz: number, rate: number, seconds: number): Float32Array {
  const length = Math.round(rate * seconds)
  const out = new Float32Array(length)
  for (let index = 0; index < length; index += 1) out[index] = 0.5 * Math.sin((2 * Math.PI * hz * index) / rate)
  return out
}

function rms(samples: Float32Array, from = 0, to = samples.length): number {
  let sum = 0
  for (let index = from; index < to; index += 1) sum += (samples[index] ?? 0) ** 2
  return Math.sqrt(sum / Math.max(1, to - from))
}

/** How much of `hz` is in the result: a single-bin goertzel. */
function tone(samples: Float32Array, hz: number, rate: number): number {
  let real = 0
  let imaginary = 0
  for (let index = 0; index < samples.length; index += 1) {
    const angle = (2 * Math.PI * hz * index) / rate
    real += (samples[index] ?? 0) * Math.cos(angle)
    imaginary += (samples[index] ?? 0) * Math.sin(angle)
  }
  return (2 * Math.hypot(real, imaginary)) / samples.length
}

describe('resampling to the 16 kHz speech rate', () => {
  it('keeps speech-band sound at its own level, at the right length', () => {
    const input = sine(1_000, 48_000, 0.1) // 4,800 samples at 48 kHz
    const out = downsample(input, 48_000)
    expect(out.length).toBeGreaterThan(1_560)
    expect(out.length).toBeLessThan(1_640)
    // Skip the filter's first few samples, which are still filling up.
    const body = rms(out, 40, out.length - 40)
    expect(body).toBeGreaterThan(0.5 * 0.707 * 0.9)
    expect(body).toBeLessThan(0.5 * 0.707 * 1.1)
    expect(tone(out.subarray(40), 1_000, IN_RATE)).toBeCloseTo(0.5, 1)
  })

  it('removes what is above the new Nyquist instead of folding it into the voice', () => {
    // 9 kHz through a 16 kHz stream has nowhere to go: a proper filter drops it, a plain average would fold it to 7 kHz.
    const out = downsample(sine(9_000, 48_000, 0.1), 48_000)
    const body = out.subarray(40)
    expect(tone(body, 9_000, IN_RATE)).toBeLessThan(0.02)
    expect(tone(body, 7_000, IN_RATE)).toBeLessThan(0.02)
    expect(rms(body)).toBeLessThan(0.02)
  })

  it('holds a 44.1 kHz microphone to the same rule', () => {
    const out = downsample(sine(1_000, 44_100, 0.1), 44_100)
    expect(out.length).toBeGreaterThan(1_400)
    expect(out.length).toBeLessThan(1_640)
    expect(tone(out.subarray(40), 1_000, IN_RATE)).toBeCloseTo(0.5, 1)
    expect(rms(downsample(sine(12_000, 44_100, 0.1), 44_100).subarray(40))).toBeLessThan(0.02)
  })

  it('gives the same sound whether the stream arrives in one block or many', () => {
    const input = sine(440, 48_000, 0.2)
    const whole = new Resampler(48_000).push(input)
    const streamed = new Resampler(48_000)
    const pieces: Float32Array[] = []
    for (let offset = 0; offset < input.length; offset += 4_096) {
      pieces.push(streamed.push(input.subarray(offset, Math.min(input.length, offset + 4_096))))
    }
    const joined = new Float32Array(pieces.reduce((sum, piece) => sum + piece.length, 0))
    let at = 0
    for (const piece of pieces) {
      joined.set(piece, at)
      at += piece.length
    }
    expect(Math.abs(joined.length - whole.length)).toBeLessThanOrEqual(1)
    // Past the first block every sample matches: no seam at a block boundary.
    for (let index = 1_400; index < Math.min(whole.length, joined.length); index += 37) {
      expect(Math.abs((joined[index] ?? 0) - (whole[index] ?? 0))).toBeLessThan(1e-4)
    }
  })

  it('leaves a stream that is already at 16 kHz alone', () => {
    const input = sine(500, IN_RATE, 0.05)
    expect(new Resampler(IN_RATE).push(input)).toBe(input)
  })
})
