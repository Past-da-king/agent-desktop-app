/**
 * A run that failed because the AI plan or provider is at its limit (rate limit, quota, usage limit) fails the same
 * way when it is sent straight back. It waits for the limit to reset instead: growing waits, a few tries, and whoever
 * started it is told once. Used by helpers (runtime/helpers.ts) and by routine desks (workers/router.ts).
 */

/** Waits before each automatic retry: the first after 5 minutes, then 15, then an hour. */
export const LIMIT_WAITS_MS: readonly number[] = [5 * 60_000, 15 * 60_000, 60 * 60_000]

/** True for the words a failure carries when the AI is at its limit: the app's own plain messages and the raw ones. */
export function isLimitFailure(text: string): boolean {
  return /usage limit|rate.?limit|limit reached|reached its limit|out of credit|quota|too many requests|\b429\b/i.test(text)
}

/** How long to wait after the nth limit failure in a row (1 = the first). The last wait repeats. */
export function limitWaitMs(hit: number): number {
  const index = Math.min(Math.max(1, Math.floor(hit)), LIMIT_WAITS_MS.length) - 1
  return LIMIT_WAITS_MS[index] ?? 60 * 60_000
}

/** True while automatic retries are left after the nth limit failure in a row. */
export function limitRetryLeft(hit: number): boolean {
  return hit <= LIMIT_WAITS_MS.length
}

/** "5 min", "1 h": a wait in plain words. */
export function waitWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`
}
