/**
 * Whether a plan's login (Claude, ChatGPT) still works, without spending a turn on it.
 *
 * 12 Nov 2026: the server node kept a Claude login file whose session had expired for good. The file was there, so the
 * node said it could run a plan, said it was ready on /v1/health, and the phone (which picks the first ready brain)
 * sent its message there when the computer dropped for a moment. The turn then ended with "Claude is not signed in".
 * The file alone proves nothing; the engine's own status answer does, and a turn that fails on sign-in settles it.
 */
import { readFileSync } from 'node:fs'

/** A tool found without a working login is tried again after this long, or as soon as its login file changes. */
export const SIGN_IN_RETRY_MS = 30 * 60_000
/** How often a node asks its engines whether the login still works. */
export const SIGN_IN_CHECK_MS = 10 * 60_000

/** The words explainCliFailure gives a turn that failed because the login does not work. */
export function isSignInFailure(error: string | undefined): boolean {
  return error !== undefined && /is not signed in on this computer/i.test(error)
}

/**
 * The login file says the login is certainly dead: its access token ran out and there is nothing to renew it with.
 * (A file with a refresh token may still be dead, only the engine's check or a failed turn finds that.)
 */
export function loginFileDead(file: string, now: number): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
  if (parsed === null || typeof parsed !== 'object') return false
  const oauth = (parsed as { claudeAiOauth?: { refreshToken?: unknown; expiresAt?: unknown } }).claudeAiOauth
  if (oauth === undefined || oauth === null || typeof oauth !== 'object') return false
  const refresh = typeof oauth.refreshToken === 'string' && oauth.refreshToken !== ''
  const expires = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null
  return !refresh && expires !== null && expires < now
}

/**
 * What `claude auth status` / `codex login status` said: true (works), false (does not), null (cannot tell).
 * Claude prints JSON with loggedIn; Codex answers by words and exit code.
 */
export function signInVerdict(cli: 'claude' | 'codex', code: number | null, output: string): boolean | null {
  if (cli === 'claude') {
    const start = output.indexOf('{')
    const end = output.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(output.slice(start, end + 1)) as { loggedIn?: unknown }
        if (typeof parsed.loggedIn === 'boolean') return parsed.loggedIn
      } catch {
        // Not JSON: fall through to the words.
      }
    }
    return /not logged in|not signed in|expired/i.test(output) ? false : null
  }
  if (/not logged in|not signed in/i.test(output)) return false
  return /logged in/i.test(output) && code === 0 ? true : null
}
