/**
 * What the device server says in the log about connections it refused, dropped or saw come and go, without
 * flooding it. 22 Oct 2026: a phone reconnected about 15 times a second for hours and main.log said nothing at all,
 * so the cause had to be found from netstat. Now each kind of event is logged the first time it happens in a
 * minute (with its reason, never a pass), and repeats are counted and summed up once the minute is over.
 */

export type LogFn = (message: string, detail?: Record<string, unknown>) => void

export const WINDOW_MS = 60_000
/** More short links than this from one device in a minute is a reconnect storm worth saying so. */
export const STORM_LINKS = 10
/** A link that ends sooner than this counts as short-lived. */
export const SHORT_LINK_MS = 5_000

interface Bucket {
  message: string
  detail: Record<string, unknown>
  first: number
  repeats: number
}

export class ConnectionLog {
  private readonly buckets = new Map<string, Bucket>()
  private readonly links = new Map<string, number[]>()
  private readonly stormSaid = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly log: LogFn | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /** Logs `message` the first time `key` happens in a minute; later ones are counted and summed up. */
  note(key: string, message: string, detail: Record<string, unknown> = {}): void {
    if (this.log === undefined) return
    const at = this.now()
    const bucket = this.buckets.get(key)
    if (bucket !== undefined && at - bucket.first < WINDOW_MS) {
      bucket.repeats += 1
      return
    }
    if (bucket !== undefined) this.summarise(bucket)
    this.buckets.set(key, { message, detail, first: at, repeats: 0 })
    this.log(message, detail)
    this.schedule()
  }

  /** A device's link ended after `lifetimeMs`. Says so once a minute when it keeps reconnecting quickly. */
  linkEnded(deviceId: string, lifetimeMs: number, detail: Record<string, unknown>): void {
    if (this.log === undefined) return
    const at = this.now()
    if (lifetimeMs < SHORT_LINK_MS) {
      const recent = (this.links.get(deviceId) ?? []).filter((t) => at - t < WINDOW_MS)
      recent.push(at)
      this.links.set(deviceId, recent)
      const said = this.stormSaid.get(deviceId)
      if (recent.length > STORM_LINKS && (said === undefined || at - said >= WINDOW_MS)) {
        this.stormSaid.set(deviceId, at)
        this.log('Device reconnecting fast', { device: deviceId, linksLastMinute: recent.length, ...detail })
      }
    } else {
      this.links.delete(deviceId)
    }
    this.note(`closed:${deviceId}:${String(detail['code'])}`, 'Device link closed', { device: deviceId, ms: lifetimeMs, ...detail })
  }

  /** Sums up every minute that is over (the timer calls it). */
  flush(): void {
    const at = this.now()
    for (const [key, bucket] of [...this.buckets]) {
      if (at - bucket.first < WINDOW_MS) continue
      this.summarise(bucket)
      this.buckets.delete(key)
    }
    if (this.buckets.size === 0) this.clearTimer()
  }

  /** Sums up everything still counting (the server is stopping). */
  stop(): void {
    this.clearTimer()
    for (const bucket of this.buckets.values()) this.summarise(bucket)
    this.buckets.clear()
  }

  private summarise(bucket: Bucket): void {
    if (bucket.repeats > 0) this.log?.(`${bucket.message} (repeats)`, { ...bucket.detail, repeats: bucket.repeats, overMs: this.now() - bucket.first })
    bucket.repeats = 0
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => this.flush(), WINDOW_MS / 4)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }
}

/** The far end of a socket for the log: its address only. */
export function peerOf(socket: { remoteAddress?: string | undefined } | null | undefined): string {
  const address = socket?.remoteAddress ?? ''
  if (address === '') return 'unknown'
  return address.startsWith('::ffff:') ? address.slice(7) : address
}
