/** Guard the drive holding app data, with a recovery margin so small fluctuations do not move turns back and forth. */
export class DiskHealth {
  private level: 'ok' | 'low' | 'critical' = 'ok'
  private free = -1
  sample(freeGb: number, totalGb: number): { changed: boolean; blocked: boolean } {
    if (freeGb < 0 || totalGb <= 0) return { changed: false, blocked: this.blocked() }
    this.free = freeGb
    const stop = Math.max(2, Math.min(5, totalGb * 0.01))
    const warn = Math.max(5, Math.min(20, totalGb * 0.03))
    const next = freeGb < stop || (this.level === 'critical' && freeGb < stop * 1.5) ? 'critical' : freeGb < warn ? 'low' : 'ok'
    const changed = next !== this.level
    this.level = next
    return { changed, blocked: this.blocked() }
  }
  blocked(): boolean { return this.level === 'critical' }
  line(): string {
    if (this.level === 'ok') return ''
    return this.level === 'critical' ? `This device is not answering: app data drive has only ${this.free.toFixed(1)} GB free. New messages use another device until space is freed.` : `Low disk space on the app data drive: ${this.free.toFixed(1)} GB free. Free space before this device stops answering.`
  }
}
