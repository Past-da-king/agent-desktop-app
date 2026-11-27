/**
 * "The disk is full", recognised from anywhere a write can fail.
 *
 * 27 Nov 2026: the computer's drive filled up. Every message from the phone failed with `ENOSPC: no space left on
 * device, write` or SQLite's own `database or disk is full` (SQLITE_FULL), the phone went on trying the same full
 * computer, and nothing said out loud that the disk was full. One classifier, used by the store's write guard, the
 * devices' health answer and the one notice the person reads, so all three agree on what happened.
 */

/** Patterns are matched against an error's message, its code and its cause, whatever shape the error has. */
const FULL: readonly RegExp[] = [
  /ENOSPC/i, // write(2): no space left on device
  /SQLITE_FULL/, // SQLite's own code for a full disk
  /\bEDQUOT\b/i, // over the quota: the drive takes nothing more either
  /no space left on device/i,
  /database or disk is full/i, // what SQLite says to a person
  /\bdisk (?:is )?full\b/i,
  /not enough space on the disk/i, // Windows
  /insufficient (?:disk|storage) space/i,
]

/** SQLite's SQLITE_FULL errcode, which node:sqlite puts on the error beside its message. */
const SQLITE_FULL_ERRCODE = 13

/** Every text an error (or the cause under it) can hide the reason in. */
function errorTexts(error: unknown): string[] {
  const texts: string[] = []
  let current: unknown = error
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current === 'string') {
      texts.push(current)
      break
    }
    if (typeof current !== 'object') break
    const value = current as { message?: unknown; code?: unknown; errcode?: unknown; errstr?: unknown; cause?: unknown }
    if (typeof value.message === 'string') texts.push(value.message)
    if (typeof value.code === 'string') texts.push(value.code)
    if (typeof value.errstr === 'string') texts.push(value.errstr)
    if (value.errcode === SQLITE_FULL_ERRCODE || value.errcode === String(SQLITE_FULL_ERRCODE)) texts.push('SQLITE_FULL')
    current = value.cause
  }
  return texts
}

/**
 * Whether this error means the disk could take no more data. Anything else (a bad row, a locked database, a
 * vanished file) is not a full disk and must not move a person's messages to another device.
 */
export function isDiskFullError(error: unknown): boolean {
  for (const text of errorTexts(error)) if (FULL.some((pattern) => pattern.test(text))) return true
  return false
}
