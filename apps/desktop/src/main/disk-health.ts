/**
 * Whether this node can still save anything: the drive holding its app data, and a write that failed because that
 * drive was full.
 *
 * Two ways to be out: the free space falls under the stop threshold, or a write actually failed with a full-disk
 * error (27 Nov 2026: the phone kept sending to a computer whose drive was full, and nothing said so). Either way the
 * node is blocked at once, its health answer says not ready, its devices are told, and a screen talking to it is
 * handed to the next brain in the order. It comes back only when the drive shows free space again.
 */
import { isDiskFullError } from '@agent/core'

export type DiskLevel = 'ok' | 'low' | 'critical'

/** How long a failed write keeps this node out, whatever a reading taken just after it says. */
export const FULL_WRITE_HOLD_MS = 30_000

export interface DiskState {
  level: DiskLevel
  /** New work must not start here: messages go to another device. */
  blocked: boolean
  /** Free GB on the app data drive, or -1 before the first sample. */
  freeGb: number
  totalGb: number
  /** A write failed with a full-disk error since the drive last showed free space. */
  fullWrite: boolean
}

export interface DiskHealthOptions {
  now?: () => number
  /** The device's name, for the sentence the person reads. */
  name?: () => string
}

export class DiskHealth {
  private level: DiskLevel = 'ok'
  private free = -1
  private total = 0
  private fullWrite = false
  private failedAtMs = 0
  private readonly now: () => number
  private readonly name: () => string

  constructor(options: DiskHealthOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.name = options.name ?? (() => 'This computer')
  }

  /** Below this it is too late to write: this node stops taking new work. */
  private stopGb(totalGb: number): number {
    return Math.max(2, Math.min(5, totalGb * 0.03))
  }

  /** Below this the person is warned, before anything stops. */
  private warnGb(totalGb: number): number {
    return Math.max(5, Math.min(20, totalGb * 0.03))
  }

  /**
   * Free space (GB) as the drive reports it. `changed` is true when the state moved, so one notice goes out and not
   * one per sample (the supervisor samples every 15 s).
   */
  sample(freeGb: number, totalGb: number): { changed: boolean; blocked: boolean } {
    if (freeGb < 0 || totalGb <= 0) return { changed: false, blocked: this.blocked() }
    this.free = freeGb
    this.total = totalGb
    const stop = this.stopGb(totalGb)
    const warn = this.warnGb(totalGb)
    // Space really came back: a full write is forgotten, so the node answers again. Not on the very next sample (a
    // reading taken a moment after the failure may still be the old one, or another volume or a quota): hold it half a
    // minute, so a node never flaps between answering and not answering.
    if (freeGb >= warn && this.now() - this.failedAtMs >= FULL_WRITE_HOLD_MS) this.fullWrite = false
    const sampled: DiskLevel = freeGb < stop || (this.level === 'critical' && freeGb < stop * 1.5) ? 'critical' : freeGb < warn ? 'low' : 'ok'
    // A write that failed stays failed until the drive has shown room for a new one for half a minute, whatever a
    // sample taken meanwhile says.
    const next: DiskLevel = this.fullWrite ? 'critical' : sampled
    const changed = next !== this.level
    this.level = next
    return { changed, blocked: this.blocked() }
  }

  /**
   * A write failed. A full-disk error means this node is out at once: no waiting for the next sample, which may be
   * fifteen seconds away and is what let the phone keep sending to a full computer.
   */
  writeFailed(error: unknown): { changed: boolean; blocked: boolean; full: boolean } {
    if (!isDiskFullError(error)) return { changed: false, blocked: this.blocked(), full: false }
    this.failedAtMs = this.now()
    const changed = this.level !== 'critical'
    this.fullWrite = true
    this.level = 'critical'
    return { changed, blocked: true, full: true }
  }

  blocked(): boolean {
    return this.level === 'critical'
  }

  freeGb(): number {
    return this.free
  }

  totalGb(): number {
    return this.total
  }

  /** When a write last failed because the disk was full (0: never since this start). */
  failedAt(): number {
    return this.failedAtMs
  }

  state(): DiskState {
    return { level: this.level, blocked: this.blocked(), freeGb: this.free, totalGb: this.total, fullWrite: this.fullWrite }
  }

  /** What the devices catalogue and a refusal from another device say: no device name, the row already carries it. */
  line(): string {
    if (this.level === 'ok') return ''
    if (this.fullWrite) return 'This device is not answering: its app data disk is full. New messages use another device until space is freed.'
    const free = this.free >= 0 ? `${this.free.toFixed(1)} GB free` : 'almost no free space'
    return this.level === 'critical'
      ? `This device is not answering: app data drive has only ${free}. New messages use another device until space is freed.`
      : `Low disk space on the app data drive: ${free}. Free space before this device stops answering.`
  }

  /** The one sentence the person reads: which device, and how much room is left. */
  notice(): string {
    if (this.level === 'ok') return ''
    const device = this.name()
    if (this.fullWrite) {
      const free = this.free >= 0 ? ` (${this.free.toFixed(1)} GB free)` : ''
      return `${device} cannot save anything: its disk is full${free}. Messages go to your other devices until space is freed.`
    }
    const free = this.free >= 0 ? `${this.free.toFixed(1)} GB free` : 'almost no free space'
    return this.level === 'critical'
      ? `${device} has only ${free} on its app data drive, so it stopped taking new messages. Messages go to your other devices until space is freed.`
      : `${device} is low on disk space: ${free}. Free some space, or it stops answering.`
  }
}
