/** All positions are milliseconds. Invalid media never produces an invalid seek. */
export function seekPosition(at: number, duration: number, input: number | string): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  const start = Number.isFinite(at) ? Math.max(0, Math.min(duration, at)) : 0
  const target = typeof input === 'number' ? input * duration
    : input === 'Home' ? 0 : input === 'End' ? duration
    : input === 'ArrowRight' || input === 'ArrowUp' ? start + 5000
    : input === 'ArrowLeft' || input === 'ArrowDown' ? start - 5000 : start
  return Number.isFinite(target) ? Math.max(0, Math.min(duration, target)) : start
}

/** Walk RIFF chunks, including optional chunks and padding, without assuming a 44-byte header. */
export function wavDurationMs(bytes: Uint8Array): number {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return 0
  let rate = 0
  let size = 0
  for (let at = 12; at + 8 <= bytes.length;) {
    const n = v.getUint32(at + 4, true)
    if (at + 8 + n > bytes.length) return 0
    if (tag(at) === 'fmt ' && n >= 16) rate = v.getUint32(at + 16, true)
    if (tag(at) === 'data') size += n
    at += 8 + n + (n % 2)
  }
  return rate > 0 ? size / rate * 1000 : 0
}

export function spokenPosition(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes} minute${minutes === 1 ? '' : 's'} ${seconds % 60} seconds` : `${seconds} seconds`
}
