import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { isDiskFullError } from '@agent/core'

import { Store } from '../src/main/db'
import { DiskHealth } from '../src/main/disk-health'
import { DiskWatch } from '../src/main/disk-watch'

let dir = ''
let store: Store | null = null

afterEach(() => {
  store?.close()
  store = null
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

/**
 * 27 Nov 2026, for real: SQLite itself says "database or disk is full" (SQLITE_FULL) when a write cannot fit, exactly
 * as it did on the full computer. The store must notice it once through its own write guard, and the disk watch must
 * take the node out and say so once, naming the device.
 */
describe('a real full database through the store', () => {
  it('is noticed by the store itself, once, and takes the node out of the answer order', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-disk-full-'))
    store = new Store(join(dir, 'agent.db'))
    const health = new DiskHealth({ name: () => 'DESKTOP-MSHPVRG' })
    const notified: string[] = []
    const notice: string[] = []
    const watch = new DiskWatch({
      health,
      path: () => dir,
      notify: (title, body) => notified.push(`${title}: ${body}`),
      note: (text) => notice.push(text),
      stat: async () => ({ freeGb: 0.2, totalGb: 476 }),
    })
    store.setDiskFullHandler((error) => watch.writeFailed(error))
    // SQLite's own ceiling on this database: past it a write fails with SQLITE_FULL, the same error a full drive gives.
    ;(store as unknown as { db: { exec(sql: string): void } }).db.exec('PRAGMA max_page_count = 96')

    let failure: unknown = null
    for (let i = 0; i < 5_000 && failure === null; i += 1) {
      try {
        await store.upsert('task', { title: `row ${i}`, notes: 'x'.repeat(2_000) })
      } catch (error) {
        failure = error
      }
    }
    expect(failure).not.toBeNull()
    expect(isDiskFullError(failure)).toBe(true)
    expect(String((failure as Error).message)).toContain('database or disk is full')
    // The node is out at once, and the person was told once, by name, with the room that is left.
    expect(health.blocked()).toBe(true)
    expect(health.line()).toContain('disk is full')
    expect(notified).toHaveLength(1)
    expect(notified[0]).toContain('DESKTOP-MSHPVRG')
    expect(notified[0]).toContain('disk is full')
    expect(notice).toHaveLength(1)

    // More writes keep failing, and nothing else is said: one line, not a wall of repeated errors.
    for (let i = 0; i < 5; i += 1) {
      await store.upsert('task', { title: `after ${i}`, notes: 'y'.repeat(2_000) }).catch(() => undefined)
    }
    expect(notified).toHaveLength(1)
    expect(notice).toHaveLength(1)
  })

  it('is not set off by a failure that is not about space', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agent-disk-ok-'))
    store = new Store(join(dir, 'agent.db'))
    const health = new DiskHealth()
    const notified: string[] = []
    store.setDiskFullHandler(() => notified.push('reported'))
    await store.upsert('task', { title: 'one' })
    // A unique key clash is an ordinary refusal, not a full disk.
    await store.remove('task', (await store.list('task'))[0]?.id ?? '')
    expect(notified).toEqual([])
    expect(health.blocked()).toBe(false)
  })
})
