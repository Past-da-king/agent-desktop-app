/**
 * The app's one corrected clock (core sync/peer-clock.ts). The store stamps rows with it, the sync routes report
 * this node's raw time and OS sync state from it, and every replication link feeds it the peers' times.
 *
 * Why: on 26 Nov 2026 the PC's Windows clock ran 35 minutes slow (w32time stopped, Local CMOS Clock) and its chat
 * replies landed 35 minutes up the phone's chat. docs/devices/clock-skew.md.
 */
import { execFile } from 'node:child_process'

import { PeerClock } from '@agent/core'

export const appClock = new PeerClock()

const RECHECK_MS = 10 * 60_000

type Run = (file: string, args: string[]) => Promise<string>

const run: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      // w32tm answers "The service has not been started" with a non-zero exit: that is an answer, not a failure.
      const text = `${String(stdout)}\n${String(stderr)}`
      if (error !== null && text.trim() === '') reject(error)
      else resolve(text)
    })
  })

/**
 * Does the operating system say its clock is kept in sync? null when it cannot say.
 * - Windows: `w32tm /query /status`. Stopped service, Local CMOS Clock or Free-running System Clock: not synced.
 * - Linux: `timedatectl show -p NTPSynchronized --value`: yes or no.
 * - Other systems: null (peers that agree still correct it, see PeerClock).
 */
export async function osClockSynced(platform: NodeJS.Platform = process.platform, exec: Run = run): Promise<boolean | null> {
  try {
    if (platform === 'win32') return parseW32tm(await exec('w32tm', ['/query', '/status']))
    if (platform === 'linux') {
      const out = (await exec('timedatectl', ['show', '-p', 'NTPSynchronized', '--value'])).trim().toLowerCase()
      if (out.startsWith('yes')) return true
      if (out.startsWith('no')) return false
      return null
    }
  } catch {
    // No tool, no answer.
  }
  return null
}

/** `w32tm /query /status` (any language for the error, English for the Source line). */
export function parseW32tm(text: string): boolean | null {
  if (/has not been started|0x80070426/i.test(text)) return false
  const source = /^\s*Source:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? ''
  if (source === '') return null
  if (/Local CMOS Clock|Free-running System Clock/i.test(source)) return false
  return true
}

let timer: ReturnType<typeof setInterval> | null = null

/** Ask the OS now and every ten minutes. Idempotent. */
export function watchOsClock(clock: PeerClock = appClock, check: () => Promise<boolean | null> = () => osClockSynced()): () => void {
  const once = (): void => {
    void check().then(
      (synced) => clock.setSelfSynced(synced),
      () => undefined,
    )
  }
  if (timer === null) {
    once()
    timer = setInterval(once, RECHECK_MS)
    timer.unref?.()
  }
  return () => {
    if (timer !== null) clearInterval(timer)
    timer = null
  }
}
