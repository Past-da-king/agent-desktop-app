/**
 * What this computer has to spare, for starting helpers (30 Oct 2026). Eleven helpers on a 16 GB, 8-core PC left
 * 0.5 to 3 GB of memory and 2 GB of disk; every main-thread read and write then waited on a disk the system was
 * paging to, and the app hung. New local helpers now wait (visibly) while memory or disk is short, at most
 * `helpersAtOnce` run here at once (0 = chosen from the cores and memory), and a job that does not need this
 * computer goes to a linked server while this one is busy.
 *
 * Sampling is async and every few seconds; reads of it are instant.
 */
import { cpus, freemem, totalmem } from 'node:os'
import { statfs } from 'node:fs/promises'

export interface ResourceSample {
  freeRamGb: number
  totalRamGb: number
  /** Free space on the drive that holds the app's data, or -1 when unknown. */
  freeDiskGb: number
  /** All cores busy, 0..100, over the last interval. */
  cpuPercent: number
  at: number
}

export interface ResourceLimits {
  /** Below this much free memory, no new helper starts here (0 = no check). */
  minFreeRamGb: number
  /** Below this much free disk, no new helper starts here (0 = no check). */
  minFreeDiskGb: number
  /** Above this CPU, the computer counts as busy for placement (0 = no check). */
  busyCpuPercent: number
}

export const DEFAULT_LIMITS: ResourceLimits = { minFreeRamGb: 1.5, minFreeDiskGb: 5, busyCpuPercent: 90 }

const GB = 1024 ** 3

/** Helpers at once when the setting is 0: one per two cores, one per 4 GB of memory, between 2 and 8. */
export function autoHelperCap(cores: number, totalRamGb: number): number {
  const byCores = Math.floor(Math.max(1, cores) / 2)
  const byRam = Math.floor(Math.max(0, totalRamGb) / 4)
  return Math.max(2, Math.min(8, byCores, byRam))
}

/** Why no new helper should start here now, or '' when one may. */
export function shortOf(sample: ResourceSample | null, limits: ResourceLimits): string {
  if (sample === null) return ''
  if (limits.minFreeRamGb > 0 && sample.freeRamGb < limits.minFreeRamGb) return `this computer is low on memory (${sample.freeRamGb.toFixed(1)} GB free)`
  if (limits.minFreeDiskGb > 0 && sample.freeDiskGb >= 0 && sample.freeDiskGb < limits.minFreeDiskGb) return `this computer is low on disk space (${sample.freeDiskGb.toFixed(1)} GB free)`
  return ''
}

/** Why this computer is busy for placing new work (short of memory or disk, or CPU high), or ''. */
export function busyReason(sample: ResourceSample | null, limits: ResourceLimits): string {
  const short = shortOf(sample, limits)
  if (short !== '') return short
  if (sample !== null && limits.busyCpuPercent > 0 && sample.cpuPercent >= limits.busyCpuPercent) return `this computer is busy (CPU ${Math.round(sample.cpuPercent)}%)`
  return ''
}

export interface ResourceSource {
  freeRam(): number
  totalRam(): number
  cpuTimes(): { idle: number; total: number }
  freeDisk(path: string): Promise<number>
  cores(): number
}

export const osResources: ResourceSource = {
  freeRam: () => freemem(),
  totalRam: () => totalmem(),
  cores: () => cpus().length,
  cpuTimes: () => {
    let idle = 0
    let total = 0
    for (const cpu of cpus()) {
      const t = cpu.times
      idle += t.idle
      total += t.user + t.nice + t.sys + t.idle + t.irq
    }
    return { idle, total }
  },
  freeDisk: async (path) => {
    const s = await statfs(path)
    return Number(s.bavail) * Number(s.bsize)
  },
}

export class ResourceMonitor {
  private last: ResourceSample | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private prevCpu: { idle: number; total: number } | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly dataPath: string,
    private readonly source: ResourceSource = osResources,
    private readonly everyMs = 5_000,
  ) {}

  start(): void {
    if (this.timer !== null) return
    void this.sample()
    this.timer = setInterval(() => void this.sample(), this.everyMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** The newest sample (null before the first). */
  now(): ResourceSample | null {
    return this.last
  }

  cores(): number {
    return this.source.cores()
  }

  totalRamGb(): number {
    return this.source.totalRam() / GB
  }

  /** Called after each sample (the helper queue re-checks whether a waiting helper may start). */
  onSample(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async sample(): Promise<ResourceSample> {
    const times = this.source.cpuTimes()
    let cpuPercent = 0
    if (this.prevCpu !== null) {
      const total = times.total - this.prevCpu.total
      const idle = times.idle - this.prevCpu.idle
      cpuPercent = total > 0 ? Math.max(0, Math.min(100, (100 * (total - idle)) / total)) : 0
    }
    this.prevCpu = times
    let disk = -1
    try {
      disk = (await this.source.freeDisk(this.dataPath)) / GB
    } catch {
      disk = -1
    }
    this.last = { freeRamGb: this.source.freeRam() / GB, totalRamGb: this.source.totalRam() / GB, freeDiskGb: disk, cpuPercent, at: Date.now() }
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // one listener must not stop the others
      }
    }
    return this.last
  }
}
