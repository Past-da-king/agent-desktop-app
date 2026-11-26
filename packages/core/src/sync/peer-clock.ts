/**
 * This device's wall clock, corrected against the other devices it replicates with.
 *
 * A device whose own clock is wrong stamps every row it writes with the wrong time, and every other device sorts by
 * that time: on 26 Nov 2026 the PC's Windows clock was 35 minutes slow (w32time stopped, Local CMOS Clock), so its
 * chat replies landed 35 minutes up the phone's chat, out of view. Replication stamps (HLC) were fine; createdAt
 * was not.
 *
 * Every sync answer carries the answering node's own time, how long it held the request (a long poll), and whether
 * its operating system says its clock is synced. From that, NTP style, each link gives one offset sample:
 *
 *   transit = (receivedAt - sentAt) - heldMs          the time on the wire, both ways
 *   offset  = peerNow - (receivedAt - transit / 2)     how far the peer's clock is ahead of ours
 *
 * Whose clock is right? One peer against us is one vote each, so a correction needs evidence:
 * - our own OS says our clock is synced: no correction, ever;
 * - one or more peers whose OS says they are synced: the median of their offsets;
 * - our own OS says we are NOT synced: the median of every fresh peer;
 * - otherwise two or more peers that agree with each other (within a minute): their median;
 * - otherwise none.
 * Offsets under a second are noise and are not applied; offsets over a week are not believed.
 */

export interface ClockSample {
  peer: string
  name: string
  /** How far the peer's clock is ahead of our raw clock, ms (negative: behind). */
  offsetMs: number
  /** Time on the wire, ms. Smaller is a better sample. */
  transitMs: number
  /** The peer's OS says its clock is synced (true), not synced (false), or it did not say (null). */
  synced: boolean | null
  /** Our raw clock when it was taken. */
  at: number
}

/** What Settings shows. */
export interface ClockReport {
  /** The correction applied to this device's clock, ms (positive: our clock is slow and we add this). */
  correctionMs: number
  /** This device's OS says its clock is synced. */
  selfSynced: boolean | null
  /** Each peer with a fresh sample: how far its clock is ahead of our RAW clock. */
  peers: Array<{ id: string; name: string; offsetMs: number; synced: boolean | null }>
  /** This device's clock differs from the peers' by more than WARN_MS (the correction, or a peer that is off). */
  warn: boolean
  /** One plain line for Settings, '' when there is nothing to say. */
  line: string
}

export const CLOCK_WARN_MS = 2 * 60_000
const FRESH_MS = 15 * 60_000
const MAX_TRANSIT_MS = 10_000
const DEADBAND_MS = 1_000
const MAX_BELIEVED_MS = 7 * 24 * 3_600_000
const AGREE_MS = 60_000
const KEEP_PER_PEER = 5

export class PeerClock {
  private readonly samples = new Map<string, ClockSample[]>()
  private selfSynced: boolean | null = null

  constructor(private readonly raw: () => number = Date.now) {}

  /** Our own OS's verdict on our clock (main/clock/os-sync.ts), refreshed now and then. */
  setSelfSynced(synced: boolean | null): void {
    this.selfSynced = synced
  }

  isSelfSynced(): boolean | null {
    return this.selfSynced
  }

  /** The raw clock, uncorrected. */
  rawNow(): number {
    return this.raw()
  }

  /**
   * One answer from a peer. `sentAt` and `receivedAt` are OUR raw clock around the request; `peerNow` the peer's
   * clock when it answered; `heldMs` how long it held the request before answering. False when the sample is not used.
   */
  sample(input: { peer: string; name?: string; sentAt: number; receivedAt: number; peerNow: number; heldMs?: number; synced?: boolean | null }): boolean {
    const held = Math.max(0, input.heldMs ?? 0)
    const transit = input.receivedAt - input.sentAt - held
    if (!Number.isFinite(input.peerNow) || input.peerNow <= 0) return false
    if (!Number.isFinite(transit) || transit < -50 || transit > MAX_TRANSIT_MS) return false
    const offset = input.peerNow - (input.receivedAt - Math.max(0, transit) / 2)
    if (Math.abs(offset) > MAX_BELIEVED_MS) return false
    const list = this.samples.get(input.peer) ?? []
    list.push({ peer: input.peer, name: input.name ?? input.peer, offsetMs: Math.round(offset), transitMs: Math.max(0, transit), synced: input.synced ?? null, at: input.receivedAt })
    while (list.length > KEEP_PER_PEER) list.shift()
    this.samples.set(input.peer, list)
    return true
  }

  /** The best fresh sample of each peer: the newest few, the one with the least time on the wire. */
  private fresh(): ClockSample[] {
    const now = this.raw()
    const out: ClockSample[] = []
    for (const list of this.samples.values()) {
      const recent = list.filter((s) => now - s.at <= FRESH_MS && s.at - now <= FRESH_MS)
      if (recent.length === 0) continue
      const best = recent.reduce((a, b) => (b.transitMs < a.transitMs ? b : a))
      // Newest synced flag wins: a peer that turned its sync on (or off) says so on its next answer.
      const newest = recent[recent.length - 1]
      out.push({ ...best, synced: newest?.synced ?? best.synced })
    }
    return out
  }

  /** The correction to add to our raw clock, ms. */
  correction(): number {
    if (this.selfSynced === true) return 0
    const fresh = this.fresh()
    if (fresh.length === 0) return 0
    const trusted = fresh.filter((s) => s.synced === true)
    let offset = 0
    if (trusted.length > 0) offset = median(trusted.map((s) => s.offsetMs))
    // Our OS says our clock is not synced: any peer that does not say the same of itself is better evidence.
    else if (this.selfSynced === false) offset = median(fresh.filter((s) => s.synced !== false).map((s) => s.offsetMs))
    else if (fresh.length >= 2) {
      const values = fresh.map((s) => s.offsetMs)
      if (Math.max(...values) - Math.min(...values) <= AGREE_MS) offset = median(values)
    }
    if (!Number.isFinite(offset) || Math.abs(offset) < DEADBAND_MS) return 0
    return Math.round(offset)
  }

  /** Our clock, corrected. */
  now(): number {
    return this.raw() + this.correction()
  }

  report(): ClockReport {
    const correctionMs = this.correction()
    const peers = this.fresh().map((s) => ({ id: s.peer, name: s.name, offsetMs: s.offsetMs, synced: s.synced }))
    let line = ''
    let warn = false
    if (Math.abs(correctionMs) > CLOCK_WARN_MS) {
      warn = true
      const by = this.fresh().filter((s) => s.synced === true)
      const ref = (by.length > 0 ? by : this.fresh()).map((s) => s.name).join(', ')
      line = `This device's clock is ${span(correctionMs)} ${correctionMs > 0 ? 'slow' : 'fast'} compared with ${ref}. New chat rows use the corrected time; turn on Set time automatically to fix the clock itself.`
    } else {
      // Our clock is trusted (or corrected), so a peer far from it is the one that is off: say which.
      const off = peers.filter((p) => Math.abs(p.offsetMs - correctionMs) > CLOCK_WARN_MS)
      if (off.length > 0) {
        warn = true
        line = off.map((p) => `${p.name}'s clock is ${span(p.offsetMs - correctionMs)} ${p.offsetMs - correctionMs > 0 ? 'ahead of' : 'behind'} this device.`).join(' ')
        if (this.selfSynced !== true && this.correction() === 0 && off.length === peers.length && peers.every((p) => p.synced !== true)) {
          line += ' It is not clear which clock is wrong: check Set time automatically on both.'
        }
      }
    }
    return { correctionMs, selfSynced: this.selfSynced, peers, warn, line }
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function span(ms: number): string {
  const abs = Math.abs(ms)
  if (abs < 90_000) return `${Math.round(abs / 1000)} seconds`
  if (abs < 90 * 60_000) return `${Math.round(abs / 60_000)} minutes`
  if (abs < 36 * 3_600_000) return `${Math.round(abs / 3_600_000)} hours`
  return `${Math.round(abs / 86_400_000)} days`
}
