/**
 * A Hybrid Logical Clock stamp: wall-clock millis plus a counter, tagged with the device id.
 *
 * Port of reference/kotlin-shared/sync/Hlc.kt. Two devices can edit the same row while their clocks
 * disagree, and two edits can land in the same millisecond. The HLC keeps time close to wall-clock
 * but always moves strictly forward and breaks ties by device id, so every device independently
 * agrees on which edit wins.
 */

export interface HlcStamp {
  millis: number
  counter: number
  device: string
}

/** Compact, sortable string form: <millis>-<counter>-<device>. Device ids may contain dashes. */
export function encodeStamp(stamp: HlcStamp): string {
  return `${stamp.millis}-${stamp.counter}-${stamp.device}`
}

/** Null when the text is not a stamp. Mirrors Kotlin's HlcStamp.decode. */
export function decodeStamp(text: string): HlcStamp | null {
  const parts = text.split('-')
  if (parts.length < 3) return null
  const millisText = parts[0]
  const counterText = parts[1]
  if (millisText === undefined || counterText === undefined) return null
  if (!/^-?\d+$/.test(millisText) || !/^-?\d+$/.test(counterText)) return null
  const millis = Number(millisText)
  const counter = Number(counterText)
  if (!Number.isSafeInteger(millis) || !Number.isSafeInteger(counter)) return null
  return { millis, counter, device: parts.slice(2).join('-') }
}

/** Order by millis, then counter (numeric), then device (string), exactly as Kotlin compares. */
export function compareStamps(a: HlcStamp, b: HlcStamp): number {
  if (a.millis !== b.millis) return a.millis < b.millis ? -1 : 1
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1
  if (a.device === b.device) return 0
  return a.device < b.device ? -1 : 1
}

/** A monotonic clock for one device. */
export class Hlc {
  private millis = 0
  private counter = 0

  constructor(
    private readonly device: string,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A stamp for a local event happening now. Never repeats, even if the wall clock goes backwards. */
  now(): HlcStamp {
    const wall = this.clock()
    if (wall > this.millis) {
      this.millis = wall
      this.counter = 0
    } else {
      this.counter++
    }
    return { millis: this.millis, counter: this.counter, device: this.device }
  }

  /** Fold in a stamp seen from another device, so our next local stamp is greater than it. */
  observe(remote: HlcStamp): void {
    const wall = this.clock()
    const m = Math.max(wall, this.millis, remote.millis)
    if (m === this.millis && m === remote.millis) {
      this.counter = Math.max(this.counter, remote.counter) + 1
    } else if (m === this.millis) {
      this.counter = this.counter + 1
    } else if (m === remote.millis) {
      this.counter = remote.counter + 1
    } else {
      this.counter = 0
    }
    this.millis = m
  }
}
