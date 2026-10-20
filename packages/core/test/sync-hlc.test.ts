import { describe, expect, it } from 'vitest'

import { Hlc, compareStamps, decodeStamp, encodeStamp, type HlcStamp } from '../src/sync/hlc'

describe('Hlc', () => {
  it('round-trips a stamp whose device id contains dashes', () => {
    const stamp: HlcStamp = { millis: 1_700_000_000_123, counter: 4, device: 'aa-bb-cc-dd' }
    const text = encodeStamp(stamp)
    expect(text).toBe('1700000000123-4-aa-bb-cc-dd')
    expect(decodeStamp(text)).toEqual(stamp)
  })

  it('decodes a UUID device id', () => {
    const stamp: HlcStamp = {
      millis: 10,
      counter: 0,
      device: '8b3f0a2c-0d9e-4b1a-9f77-2d5f3a6c1e42',
    }
    expect(decodeStamp(encodeStamp(stamp))).toEqual(stamp)
  })

  it('returns null for malformed stamps', () => {
    expect(decodeStamp('')).toBeNull()
    expect(decodeStamp('abc')).toBeNull()
    expect(decodeStamp('1-2')).toBeNull()
    expect(decodeStamp('x-0-device')).toBeNull()
    expect(decodeStamp('1-x-device')).toBeNull()
  })

  it('compares millis numerically, not as text', () => {
    const nine: HlcStamp = { millis: 9, counter: 0, device: 'a' }
    const ten: HlcStamp = { millis: 10, counter: 0, device: 'a' }
    expect(compareStamps(nine, ten)).toBe(-1)
    expect(compareStamps(ten, nine)).toBe(1)
  })

  it('breaks a tie by device id', () => {
    const a: HlcStamp = { millis: 1_000, counter: 2, device: 'device-a' }
    const b: HlcStamp = { millis: 1_000, counter: 2, device: 'device-b' }
    expect(compareStamps(a, b)).toBe(-1)
    expect(compareStamps(b, a)).toBe(1)
    expect(compareStamps(a, { ...a })).toBe(0)
  })

  it('stays monotonic when the wall clock goes backwards', () => {
    let wall = 10_000
    const hlc = new Hlc('device-a', () => wall)

    const first = hlc.now()
    expect(first).toEqual({ millis: 10_000, counter: 0, device: 'device-a' })

    wall = 5_000
    const second = hlc.now()
    expect(second.millis).toBe(10_000)
    expect(second.counter).toBe(1)
    expect(compareStamps(second, first)).toBe(1)
  })

  it('increments the counter within one millisecond', () => {
    const hlc = new Hlc('device-a', () => 7_000)
    const stamps = [hlc.now(), hlc.now(), hlc.now()]
    expect(stamps.map((s) => s.counter)).toEqual([0, 1, 2])
  })

  it('observing a remote stamp makes the next local stamp greater', () => {
    let wall = 1_000
    const hlc = new Hlc('device-a', () => wall)
    const remote: HlcStamp = { millis: 5_000, counter: 3, device: 'device-b' }

    hlc.observe(remote)
    const next = hlc.now()
    expect(compareStamps(next, remote)).toBe(1)
    expect(next.millis).toBe(5_000)
    expect(next.counter).toBe(5)
  })

  it('folds a remote stamp on the same millisecond with the higher counter', () => {
    const hlc = new Hlc('device-a', () => 5_000)
    hlc.now()
    hlc.now()
    const remote: HlcStamp = { millis: 5_000, counter: 7, device: 'device-b' }

    hlc.observe(remote)
    const next = hlc.now()
    expect(next.millis).toBe(5_000)
    expect(next.counter).toBe(9)
    expect(compareStamps(next, remote)).toBe(1)
  })

  it('observing is idempotent enough: a second fold still moves forward', () => {
    const hlc = new Hlc('device-a', () => 1_000)
    const remote: HlcStamp = { millis: 2_000, counter: 0, device: 'device-b' }
    hlc.observe(remote)
    hlc.observe(remote)
    const next = hlc.now()
    expect(compareStamps(next, remote)).toBe(1)
  })
})
