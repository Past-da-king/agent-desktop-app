/**
 * Which Gemini key a voice note speaks with (27 Nov 2026).
 *
 * Google's free speech allowance is small: ten calls a day for each speech model of each key. When it is gone every
 * voice note fails with 429 / RESOURCE_EXHAUSTED until the allowance comes back at midnight in California, where
 * Google's day turns over. One exhausted key therefore took every voice note down for the rest of the day, although
 * the Vault already held backup keys made for exactly this.
 *
 * So a note now walks an ordered list: the person's own voice key first, then every Vault item named
 * "Gemini API key: A.O.S voice-note backup ...". A key that answers out of quota rests until its allowance is back
 * (the next Pacific midnight for a daily quota, a minute for a per-minute one) and the same script goes to the next
 * key. Only when every key is resting does the note fail.
 *
 * The keys themselves are read at runtime and never kept: this module remembers a fingerprint of each resting key and
 * nothing else, and the values are read again from the key store and the Vault on every call.
 */
import { createHash } from 'node:crypto'

/** The name every backup voice key in the Vault starts with (the rest names whose account it is). */
export const BACKUP_PREFIX = 'Gemini API key: A.O.S voice-note backup'

/** How long a key rests after a per-minute limit: the next note a minute later tries it again. */
export const SHORT_REST_MS = 60_000

/** The longest rest a provider's own "retry in" hint may ask for; anything longer is a daily quota. */
export const MAX_REST_MS = 10 * 60_000

/** A key is out of allowance: 'day' until the daily quota resets, 'minute' for a short wait. */
export type QuotaKind = 'day' | 'minute'

const PACIFIC = 'America/Los_Angeles'

/** A key by a short fingerprint, so nothing here ever holds the key itself. */
export function fingerprint(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex').slice(0, 16)
}

/** The local hour at an instant, in Pacific time. */
function pacificHour(at: number): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: PACIFIC, hour: '2-digit', hourCycle: 'h23' }).format(at))
}

/**
 * When Google's free allowance resets: the next midnight in Pacific time. Los Angeles is always a whole number of
 * hours from UTC, so that midnight falls on an exact hour and the walk below lands on it.
 */
export function nextPacificMidnight(now: number): number {
  const hour = 3_600_000
  let at = Math.floor(now / hour) * hour + hour
  for (let step = 0; step < 26; step += 1) {
    if (pacificHour(at) === 0) return at
    at += hour
  }
  return Math.floor(now / hour) * hour + 24 * hour
}

/** Until when a key that just ran out waits. */
export function restUntil(kind: QuotaKind, now: number, retryAfterMs?: number): number {
  if (kind === 'day') return nextPacificMidnight(now)
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) return now + Math.min(retryAfterMs, MAX_REST_MS)
  return now + SHORT_REST_MS
}

export interface VoiceKeyringDeps {
  /** The voice key in Settings (the `geminiKey` secret). */
  primary: () => string | null
  /** The Vault's backup keys, in the order they should be tried. */
  backups: () => string[]
  now?: () => number
}

/**
 * The voice keys in the order a note tries them, with the ones resting after a quota left out. Cheap and stateless
 * apart from the fingerprints and the time each resting key is free again.
 */
export class VoiceKeyring {
  private readonly resting = new Map<string, number>()
  private readonly deps: VoiceKeyringDeps
  private readonly now: () => number

  constructor(deps: VoiceKeyringDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /** The keys to try, main voice key first, then the Vault backups; a key still resting is not among them. */
  keys(): string[] {
    const now = this.now()
    const seen = new Set<string>()
    const keys: string[] = []
    for (const candidate of [this.deps.primary(), ...this.deps.backups()]) {
      const key = typeof candidate === 'string' ? candidate.trim() : ''
      if (key === '') continue
      const print = fingerprint(key)
      if (seen.has(print)) continue
      seen.add(print)
      const until = this.resting.get(print)
      if (until !== undefined && until > now) continue
      // Its allowance is back: forget it ever rested.
      if (until !== undefined) this.resting.delete(print)
      keys.push(key)
    }
    return keys
  }

  /** A key answered out of quota: hold it until then. */
  exhausted(key: string, until: number): void {
    this.resting.set(fingerprint(key), until)
  }

  /** When the first resting key is free again, for telling the person how long the wait is. */
  freeAt(): number | null {
    const now = this.now()
    let soonest: number | null = null
    for (const until of this.resting.values()) {
      if (until <= now) continue
      if (soonest === null || until < soonest) soonest = until
    }
    return soonest
  }

  /** Everything rests again: a new key in Settings, or a test. */
  forget(): void {
    this.resting.clear()
  }
}

/** The Vault side this needs: the items without values, and one item's value by ref. */
export interface VaultKeySource {
  list(): Array<{ name: string; ref: string }>
  resolve(text: string): { value: string } | { error: string } | { item: unknown; field: string; value: string }
}

/**
 * The Vault's backup voice keys, in the order the Vault lists them. Read on every call, never copied anywhere: a key
 * added to the Vault works for the next note with no restart, and one taken out stops being tried.
 */
export function vaultBackupKeys(vault: VaultKeySource): string[] {
  const keys: string[] = []
  for (const item of vault.list()) {
    if (!item.name.trim().startsWith(BACKUP_PREFIX)) continue
    const hit = vault.resolve(item.ref)
    if (!('value' in hit)) continue
    const value = typeof hit.value === 'string' ? hit.value.trim() : ''
    if (value !== '') keys.push(value)
  }
  return keys
}
