/**
 * node.json's brains follow their device rows (26 Nov 2026).
 *
 * A headless node writes the brains it paired with, and their addresses, into node.json at pairing time. Those
 * addresses were never looked at again: a computer that moved to another LAN address or got a
 * relay address kept being tried at the old one forever, every link and every relay call first waiting on a dead
 * address. Now, whenever a brain's replicated device row changes (and once a minute), its entry is brought up to date:
 *  - the addresses its row publishes now are taken, in the row's order;
 *  - an address the row published before and no longer does is gone, and is dropped;
 *  - an address that came from somewhere else (the pairing link, a hand edit) is kept while it may still work, and
 *    dropped only once it is proven dead: no answer from /v1/health on DEAD_AFTER checks in a row spread over at
 *    least DEAD_SPAN_MS, with the brain itself answering on another address meanwhile;
 *  - `pinned` addresses (set by hand in node.json) are always kept, first.
 * Nothing needs a restart: every reader of node.json reads the file each time.
 */
import type { DeviceRow } from '@agent/core'

import type { BrainRef } from '../main/devices/types'
import { readConfig, writeConfig } from './node-config'

/** One brain as node.json keeps it: BrainRef plus what this refresher needs to remember. */
export interface BrainEntry extends BrainRef {
  /** Addresses the person pinned by hand: never dropped, tried first. */
  pinned?: string[]
  /** The row's own addresses at the last refresh: one that leaves the row later is gone, not hand-added. */
  learned?: string[]
}

/** What the health checks have said about an address. */
export interface UrlHealth {
  fails: number
  firstFailAt: number
  okAt: number
}

export const DEAD_AFTER = 5
export const DEAD_SPAN_MS = 10 * 60_000

export function provenDead(health: UrlHealth | undefined, brainAnswers: boolean): boolean {
  if (health === undefined || !brainAnswers) return false
  return health.fails >= DEAD_AFTER && health.firstFailAt > 0 && Date.now() - health.firstFailAt >= DEAD_SPAN_MS && health.okAt < health.firstFailAt
}

/**
 * The entry's next addresses. `alive(url)` is false only for an address proven dead. Returns the same entry when
 * nothing changed.
 */
export function refreshEntry(
  entry: BrainEntry,
  row: Pick<DeviceRow, 'urls' | 'fp' | 'revoked'> | undefined,
  dead: (url: string) => boolean,
  answering: (url: string) => boolean = () => false,
): BrainEntry {
  const pinned = [...new Set(entry.pinned ?? [])]
  const learnedBefore = new Set(entry.learned ?? [])
  // No row yet, a row with another certificate (a different install), or a taken-out device: leave the entry.
  if (row === undefined || row.revoked || (entry.fp !== '' && row.fp !== '' && row.fp !== entry.fp)) {
    const urls = [...pinned, ...entry.urls.filter((url) => !pinned.includes(url) && !dead(url))]
    return same(entry.urls, urls) ? entry : { ...entry, urls }
  }
  const fromRow = row.urls.filter((url) => typeof url === 'string' && url !== '')
  // Kept from before: neither in the row now nor published by it before (so not gone), and not proven dead.
  const others = entry.urls.filter((url) => !fromRow.includes(url) && !pinned.includes(url) && !learnedBefore.has(url) && !dead(url))
  // Pinned first; then a kept address that answers now (a relay the person added while the row's addresses fail);
  // then the row's own; then kept addresses not yet known to work (a stale pairing address waits at the back).
  const live = others.filter((url) => answering(url))
  const unknown = others.filter((url) => !live.includes(url))
  const urls = [...pinned, ...live, ...fromRow.filter((url) => !pinned.includes(url) && !others.includes(url)), ...unknown]
  const next: BrainEntry = { ...entry, urls, learned: fromRow, ...(entry.fp === '' && row.fp !== '' ? { fp: row.fp } : {}) }
  return same(entry.urls, urls) && same(entry.learned ?? [], fromRow) && next.fp === entry.fp ? entry : next
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
}

export interface BrainUrlRefresherDeps {
  dataDir: string
  rows: () => Promise<DeviceRow[]>
  /** Whether the brain answers /v1/health at this address (pinned to its certificate). */
  probe: (url: string, fp: string) => Promise<boolean>
  log?: (line: string, detail?: Record<string, unknown>) => void
}

export class BrainUrlRefresher {
  private readonly health = new Map<string, UrlHealth>()
  private running: Promise<boolean> | null = null
  private again = false

  constructor(private readonly deps: BrainUrlRefresherDeps) {}

  /** Brings node.json up to date now; true when it changed. Calls made while one runs fold into one more run. */
  refresh(): Promise<boolean> {
    if (this.running !== null) {
      this.again = true
      return this.running
    }
    this.running = this.once()
      .catch(() => false)
      .finally(() => {
        this.running = null
        if (this.again) {
          this.again = false
          void this.refresh()
        }
      })
    return this.running
  }

  /** Checks the addresses that are neither the row's nor pinned, so a dead one can be proven dead. */
  async probeOthers(): Promise<void> {
    const config = readConfig(this.deps.dataDir)
    const rows = new Map((await this.deps.rows()).map((row) => [row.id, row]))
    for (const brain of config.brains as BrainEntry[]) {
      const row = rows.get(brain.id)
      if (row === undefined || brain.fp === '') continue
      const candidates = brain.urls.filter((url) => !row.urls.includes(url) && !(brain.pinned ?? []).includes(url))
      if (candidates.length === 0) continue
      // Only addresses that need a verdict, and the row's first answer (is the brain up at all?), all at once.
      const checks = await Promise.all([...candidates, ...row.urls.slice(0, 3)].map(async (url) => [url, await this.deps.probe(url, brain.fp).catch(() => false)] as const))
      const now = Date.now()
      for (const [url, ok] of checks) {
        const key = `${brain.id} ${url}`
        const was = this.health.get(key) ?? { fails: 0, firstFailAt: 0, okAt: 0 }
        this.health.set(key, ok ? { fails: 0, firstFailAt: 0, okAt: now } : { fails: was.fails + 1, firstFailAt: was.firstFailAt === 0 ? now : was.firstFailAt, okAt: was.okAt })
      }
    }
  }

  private brainAnswers(brain: BrainEntry, row: DeviceRow | undefined): boolean {
    const urls = [...brain.urls, ...(row?.urls ?? [])]
    return urls.some((url) => (this.health.get(`${brain.id} ${url}`)?.okAt ?? 0) > 0 && (this.health.get(`${brain.id} ${url}`)?.fails ?? 0) === 0)
  }

  private async once(): Promise<boolean> {
    const rows = new Map((await this.deps.rows()).map((row) => [row.id, row]))
    const config = readConfig(this.deps.dataDir)
    let changed = false
    const brains = (config.brains as BrainEntry[]).map((brain) => {
      const row = rows.get(brain.id)
      const answers = this.brainAnswers(brain, row)
      const next = refreshEntry(
        brain,
        row,
        (url) => provenDead(this.health.get(`${brain.id} ${url}`), answers),
        (url) => {
          const health = this.health.get(`${brain.id} ${url}`)
          return health !== undefined && health.fails === 0 && health.okAt > 0
        },
      )
      if (next !== brain) {
        changed = true
        const dropped = brain.urls.filter((url) => !next.urls.includes(url))
        const added = next.urls.filter((url) => !brain.urls.includes(url))
        this.deps.log?.('Brain addresses brought up to date from its device row', { brain: brain.id, added, dropped })
      }
      return next
    })
    if (!changed) return false
    // Read again just before writing: a pairing or a `config` command may have written meanwhile.
    const latest = readConfig(this.deps.dataDir)
    const byId = new Map(brains.map((brain) => [brain.id, brain]))
    writeConfig(this.deps.dataDir, { ...latest, brains: latest.brains.map((brain) => byId.get(brain.id) ?? brain) })
    return true
  }
}
