/**
 * One choke point for "a write failed because the disk is full".
 *
 * 27 Nov 2026: the drive filled up and the app learned nothing from it. Each write threw ENOSPC or "database or disk
 * is full" to whoever asked (a phone's message, a project chat closing), and the same computer went on being used.
 * Every statement this store runs goes through here, so a full disk is noticed once, however the write was started
 * (a chat row, a project close, a memory page, the archiver, a run's step), and the node can say it is out.
 *
 * Only writes are watched: a read that fails for want of space is not a thing, and a full disk must never be confused
 * with a row that is wrong or a database that is busy.
 */
import { isDiskFullError } from '@agent/core'

/** Just enough of a database and a statement for the guard, so a test can hand in a fake one. */
export interface GuardedStatement {
  run: (...args: never[]) => unknown
}

export interface GuardedDatabase {
  prepare: (sql: string) => GuardedStatement
  exec?: (sql: string) => unknown
}

/**
 * `db` with every `prepare(...).run(...)` and `exec(...)` reporting a full-disk failure to `onFullDisk` before it is
 * thrown on, so the caller still sees the error it expects. Everything else is left exactly as it was.
 */
export function guardDiskWrites<D extends GuardedDatabase>(db: D, onFullDisk: (error: unknown) => void): D {
  const report = (error: unknown): never => {
    if (isDiskFullError(error)) {
      try {
        onFullDisk(error)
      } catch {
        // The report must never replace the failure the caller is about to see.
      }
    }
    throw error
  }
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      if (property === 'prepare') {
        return (sql: string) => guardStatement((value as GuardedDatabase['prepare']).call(target, sql), report)
      }
      if (property === 'exec') {
        return (sql: string) => {
          try {
            return (value as (sql: string) => unknown).call(target, sql)
          } catch (error) {
            return report(error)
          }
        }
      }
      return value.bind(target)
    },
  })
  return proxy
}

function guardStatement<S extends GuardedStatement>(statement: S, report: (error: unknown) => never): S {
  return new Proxy(statement, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown
      if (typeof value !== 'function') return value
      if (property === 'run') {
        return (...args: unknown[]) => {
          try {
            return (value as (...a: unknown[]) => unknown).call(target, ...args)
          } catch (error) {
            return report(error)
          }
        }
      }
      return value.bind(target)
    },
  })
}
