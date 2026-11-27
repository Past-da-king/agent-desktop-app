import { describe, expect, it } from 'vitest'

import { isDiskFullError } from '@agent/core'

/**
 * 27 Nov 2026: the computer's drive filled up. Each message from the phone failed with `ENOSPC: no space left on
 * device, write` or SQLite's `database or disk is full`, and nothing in the app recognised it as the disk.
 */
describe('a full disk, however it is reported', () => {
  it('knows the write errors a full drive gives', () => {
    // The exact words the phone showed on 27 Nov 2026.
    expect(isDiskFullError(new Error('ENOSPC: no space left on device, write'))).toBe(true)
    expect(isDiskFullError(new Error('database or disk is full'))).toBe(true)
    // SQLite's own error shape from node:sqlite: message, code and errcode beside each other.
    const sqlite = Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
    expect(isDiskFullError(sqlite)).toBe(true)
    expect(isDiskFullError('SQLITE_FULL: database or disk is full')).toBe(true)
    expect(isDiskFullError({ message: 'write failed', code: 'ENOSPC' })).toBe(true)
    // A cause under the error counts too: nothing has to unwrap it by hand.
    expect(isDiskFullError(new Error('could not save', { cause: new Error('no space left on device') }))).toBe(true)
    expect(isDiskFullError(new Error('There is not enough space on the disk.'))).toBe(true)
    expect(isDiskFullError(new Error('disk full'))).toBe(true)
  })

  it('never calls a different failure a full disk', () => {
    // These must not move a person's message to another device, or hide a real bug.
    expect(isDiskFullError(new Error('UNIQUE constraint failed: rows.entity'))).toBe(false)
    expect(isDiskFullError(new Error('database is locked'))).toBe(false)
    expect(isDiskFullError(new Error('ENOENT: no such file or directory'))).toBe(false)
    expect(isDiskFullError(new Error('EACCES: permission denied'))).toBe(false)
    expect(isDiskFullError(new Error('The engine answered 429'))).toBe(false)
    expect(isDiskFullError(null)).toBe(false)
    expect(isDiskFullError(undefined)).toBe(false)
    expect(isDiskFullError(13)).toBe(false)
  })
})
