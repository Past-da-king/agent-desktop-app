/**
 * A 24-hour time typed by hand, "HH:MM". The native time field follows the computer's region, so it showed
 * "07:00 AM" while every other time in the app reads "07:00"; this one is the same everywhere.
 */

/** What the field shows while the person types: digits only, the colon put in for them. */
export function typeTime(raw: string): string {
  const cleaned = raw.replace(/[^\d:]/g, '')
  const colon = cleaned.indexOf(':')
  if (colon >= 0) {
    const hours = cleaned.slice(0, colon).slice(0, 2)
    const minutes = cleaned.slice(colon + 1).replace(/:/g, '').slice(0, 2)
    return `${hours}:${minutes}`
  }
  const digits = cleaned.slice(0, 4)
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits
}

/** The finished time, "07:05", or '' when what was typed is not a time of day. "7", "7:5" and "0705" all count. */
export function finishTime(raw: string): string {
  const text = typeTime(raw)
  const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(text)
  if (match === null) return ''
  const hours = Number(match[1])
  const minutes = Number(match[2] ?? '0')
  if (hours > 23 || minutes > 59) return ''
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`
}
