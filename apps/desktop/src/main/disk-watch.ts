/**
 * Keeps an eye on this node's own disk: every few minutes, and the instant a write fails because the drive is full.
 *
 * 27 Nov 2026: the computer's drive filled up and nobody was told. The phone kept sending to it, every message came
 * back with ENOSPC or "database or disk is full", and the same error was shown again and again. So a node now watches
 * its own drive (a few minutes apart), a full-disk write failure counts as a health failure at once, and the person
 * gets one clear notification naming the device and the room left, never a repeat of the same one.
 *
 * It does not read the file system itself: `stat` is handed in, so everything here can be tested without a full disk.
 */
import { statfs } from 'node:fs/promises'

import { isDiskFullError } from '@agent/core'

import { DiskHealth, type DiskState } from './disk-health'

export interface DiskWatchDeps {
  health: DiskHealth
  /** The folder whose drive matters (the app data folder). */
  path: () => string
  /** The one notification the person gets (main/notify.ts, or the node's device notification). */
  notify: (title: string, body: string) => void
  /** One chat line, so the window and the phone both show what happened. Only when the state moves. */
  note?: (text: string) => void
  /** The state moved: paired devices hear about it now instead of at their next probe. */
  onChange?: (state: DiskState) => void
  /** Free and total GB of the drive holding `path`. */
  stat?: (path: string) => Promise<{ freeGb: number; totalGb: number }>
  /** How often the drive is read (default 2 minutes: cheap, and the write guard catches what happens in between). */
  everyMs?: number
  /** The same level is not announced again within this (default 30 minutes). */
  repeatMs?: number
  now?: () => number
  log?: (line: string, detail?: Record<string, unknown>) => void
}

const GB = 1024 ** 3

/** Free and total GB of the drive holding `path`, as the operating system reports it. */
export async function freeDiskGb(path: string): Promise<{ freeGb: number; totalGb: number }> {
  const stats = await statfs(path)
  return { freeGb: (Number(stats.bavail) * Number(stats.bsize)) / GB, totalGb: (Number(stats.blocks) * Number(stats.bsize)) / GB }
}

export class DiskWatch {
  private timer: ReturnType<typeof setInterval> | null = null
  private lastNotified: { level: string; at: number } = { level: 'ok', at: 0 }
  private checking: Promise<DiskState> | null = null
  private readonly listeners = new Set<(state: DiskState) => void>()
  private readonly now: () => number

  constructor(private readonly deps: DiskWatchDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** Read the drive once now and then every `everyMs`. Returns before the first read: start-up must not wait. */
  start(): void {
    if (this.timer !== null) return
    void this.check('start').catch(() => undefined)
    const every = this.deps.everyMs ?? 120_000
    this.timer = setInterval(() => void this.check('timer').catch(() => undefined), Math.max(15_000, every))
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  state(): DiskState {
    return this.deps.health.state()
  }

  /** Told whenever the state moves (the node's devices service listens, so its phones hear at once). */
  onChangeState(listener: (state: DiskState) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Read the drive now (the timer, a start, or a path that is about to write something big). */
  async check(why = 'timer'): Promise<DiskState> {
    if (this.checking !== null) return this.checking
    const read = (async (): Promise<DiskState> => {
      try {
        const { freeGb, totalGb } = await (this.deps.stat ?? freeDiskGb)(this.deps.path())
        return this.sample(freeGb, totalGb, why)
      } catch (error) {
        this.deps.log?.('Disk check failed', { why, reason: error instanceof Error ? error.message : String(error) })
        return this.deps.health.state()
      }
    })()
    this.checking = read
    try {
      return await read
    } finally {
      this.checking = null
    }
  }

  /** Free space as someone else read it (the freeze supervisor reads it every 15 s while the app runs). */
  sample(freeGb: number, totalGb: number, why = 'sample'): DiskState {
    const before = this.deps.health.state()
    const { changed } = this.deps.health.sample(freeGb, totalGb)
    const after = this.deps.health.state()
    this.announce(before, after, changed, why)
    return after
  }

  /**
   * A write failed. A full disk is this node's own health failing, so it is treated as one at once: blocked, told to
   * paired devices, and announced once.
   */
  writeFailed(error: unknown): DiskState {
    if (!isDiskFullError(error)) return this.deps.health.state()
    const before = this.deps.health.state()
    const { changed } = this.deps.health.writeFailed(error)
    const after = this.deps.health.state()
    this.deps.log?.('A write failed because the disk is full', { freeGb: after.freeGb, blocked: after.blocked })
    this.announce(before, after, changed, 'write')
    // The figure beside the sentence comes from a real read, so it is true even when the failure came first.
    if (after.freeGb < 0) void this.check('write').catch(() => undefined)
    return after
  }

  private announce(before: DiskState, after: DiskState, changed: boolean, why: string): void {
    if (!changed) return
    this.deps.log?.('Disk state changed', { why, level: after.level, freeGb: after.freeGb })
    this.deps.onChange?.(after)
    for (const listener of this.listeners) {
      try {
        listener(after)
      } catch {
        // One listener must not stop the others (or the notice).
      }
    }
    const line = this.deps.health.notice()
    if (line !== '' && this.shouldNotify(after)) {
      this.lastNotified = { level: after.level, at: this.now() }
      this.deps.notify(after.level === 'critical' ? 'Disk full on this device' : 'Disk space low', line)
    }
    // One line in the chat, so the window and a phone both see it. A recovery clears it with a short line.
    const note =
      after.level === 'ok'
        ? before.blocked
          ? 'Disk space is back: this device answers again.'
          : 'Disk space is back to normal on this device.'
        : this.deps.health.notice()
    if (note !== '') this.deps.note?.(note)
  }

  /** The same level is announced once, and not again for a while: a full disk must not ring every two minutes. */
  private shouldNotify(state: DiskState): boolean {
    if (state.level === 'ok') return false
    if (state.level !== this.lastNotified.level) return true
    const repeat = this.deps.repeatMs ?? 30 * 60_000
    return this.now() - this.lastNotified.at >= repeat
  }
}
