import { describe, expect, it } from 'vitest'

import { isDiskFullError } from '@agent/core'

import { guardDiskWrites, type GuardedDatabase } from '../src/main/db-disk-guard'

/** A database that only throws what a test hands it: the guard's own behaviour, with nothing else in the way. */
function fakeDb(behaviour: { run?: () => unknown; exec?: () => unknown; get?: () => unknown } = {}): GuardedDatabase & { runCalls: number; statements: number } {
  const db = {
    runCalls: 0,
    statements: 0,
    prepare(sql: string) {
      db.statements += 1
      return {
        sql,
        run(..._args: never[]) {
          db.runCalls += 1
          if (behaviour.run !== undefined) return behaviour.run()
          return { changes: 1 }
        },
        get() {
          return behaviour.get !== undefined ? behaviour.get() : { x: 1 }
        },
      }
    },
    exec(_sql: string) {
      return behaviour.exec !== undefined ? behaviour.exec() : undefined
    },
  }
  return db
}

/**
 * 27 Nov 2026: a full drive threw ENOSPC out of every write, and the app itself learned nothing from it. Every write
 * now passes one guard, so the node can take itself out of the answer order instead of failing message after message.
 */
describe('the write guard', () => {
  it('reports a full disk once and still throws the error the caller expects', () => {
    const failure = Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR', errcode: 13 })
    const db = fakeDb({ run: () => { throw failure } })
    const seen: unknown[] = []
    const guarded = guardDiskWrites(db, (error) => seen.push(error))
    expect(() => guarded.prepare('INSERT INTO rows VALUES(1)').run()).toThrow('database or disk is full')
    expect(seen).toEqual([failure])
  })

  it('leaves every other failure alone', () => {
    const db = fakeDb({ run: () => { throw new Error('UNIQUE constraint failed: rows.entity, rows.cid') } })
    const seen: unknown[] = []
    const guarded = guardDiskWrites(db, (error) => seen.push(error))
    expect(() => guarded.prepare('INSERT INTO rows VALUES(1)').run()).toThrow('UNIQUE constraint failed')
    expect(seen).toEqual([])
  })

  it('watches exec too, and passes every other call straight through', () => {
    let execFails = false
    const db = fakeDb({ exec: () => { if (execFails) throw new Error('ENOSPC: no space left on device') } })
    const seen: unknown[] = []
    const guarded = guardDiskWrites(db, (error) => seen.push(error))
    guarded.exec?.('BEGIN')
    expect(seen).toEqual([])
    execFails = true
    expect(() => guarded.exec?.('COMMIT')).toThrow('ENOSPC')
    expect(seen).toHaveLength(1)
    // Reads are untouched: a full disk does not make a read fail, and nothing may be reported for one.
    expect(guarded.prepare('SELECT 1').get()).toEqual({ x: 1 })
    expect(db.runCalls).toBe(0)
  })

  it('keeps the caller\'s failure even when the report itself throws', () => {
    const db = fakeDb({ run: () => { throw new Error('ENOSPC: no space left on device, write') } })
    const guarded = guardDiskWrites(db, () => { throw new Error('the listener is broken') })
    expect(() => guarded.prepare('INSERT INTO rows VALUES(1)').run()).toThrow('ENOSPC')
  })

  it('recognises the real thing, not an approximation', () => {
    const db = fakeDb({ run: () => { throw new Error('SQLITE_FULL: database or disk is full') } })
    const seen: unknown[] = []
    expect(() => guardDiskWrites(db, (error) => seen.push(error)).prepare('INSERT INTO rows VALUES(1)').run()).toThrow('SQLITE_FULL')
    expect(isDiskFullError(seen[0])).toBe(true)
  })
})
