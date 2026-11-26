import { describe, expect, it } from 'vitest'
import { seekPosition, spokenPosition, wavDurationMs } from '../src/renderer/voice/seek'
describe('voice seek', () => {
  it('never returns non-finite or out-of-range positions', () => {
    expect(seekPosition(NaN, 14000, 'ArrowRight')).toBe(5000)
    expect(seekPosition(42000, 14000, NaN)).toBe(14000)
    expect(seekPosition(0, 0, 'End')).toBe(0)
  })
  it('describes the position for screen readers', () => {
    expect(spokenPosition(42000)).toBe('42 seconds')
    expect(spokenPosition(118000)).toBe('1 minute 58 seconds')
    expect(spokenPosition(Infinity)).toBe('0 seconds')
  })
  it('rejects non-WAV or incomplete audio', () => {
    expect(wavDurationMs(new Uint8Array())).toBe(0)
    expect(wavDurationMs(new Uint8Array(44))).toBe(0)
  })
  it('clamps pointer positions and ignores invalid durations', () => {
    expect(seekPosition(0, 118000, 1.5)).toBe(118000)
    expect(seekPosition(0, 118000, -1)).toBe(0)
    expect(seekPosition(0, Infinity, .5)).toBe(0)
  })
  it('moves five seconds and supports the endpoints', () => {
    expect(seekPosition(42000, 118000, 'ArrowRight')).toBe(47000)
    expect(seekPosition(2000, 118000, 'ArrowDown')).toBe(0)
    expect(seekPosition(42000, 118000, 'Home')).toBe(0)
    expect(seekPosition(42000, 118000, 'End')).toBe(118000)
  })
  it('reads WAV byte rate and data size, rejecting truncated data', () => {
    const b = new Uint8Array(48); const v = new DataView(b.buffer)
    for (const [at, text] of [[0,'RIFF'],[8,'WAVE'],[12,'fmt '],[36,'data']] as const)
      for(let i=0;i<text.length;i++) b[at+i]=text.charCodeAt(i)
    v.setUint32(16,16,true); v.setUint32(28,4,true); v.setUint32(40,4,true)
    expect(wavDurationMs(b)).toBe(1000)
    expect(wavDurationMs(b.slice(0,45))).toBe(0)
  })
})
