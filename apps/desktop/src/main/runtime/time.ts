/**
 * Date and time as the agent and the person see them. Kept in one place so the system prompt and
 * the `now` tool can never disagree about the timezone or the wording.
 */

/** The computer's IANA timezone, with UTC as a safe fallback when the runtime cannot name one. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** "Tuesday 20 October 2026, 16:58 (Africa/Johannesburg)" */
export function formatDateTime(date: Date, timeZone: string = localTimeZone()): string {
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(date)
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone,
  }).format(date)
  const clock = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(date)
  return `${weekday} ${day}, ${clock} (${timeZone})`
}
