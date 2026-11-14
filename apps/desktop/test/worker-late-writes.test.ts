/**
 * Same class as the routine fix: a worker that was deleted while its process was still talking is not brought back
 * by that process's late writes (its state row, its events).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkerManifest } from '@agent/core'

import { WorkerStore } from '../src/main/workers/store'

let dir: string
let store: WorkerStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'worker-late-'))
  store = new WorkerStore(dir)
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function manifest(id: string): WorkerManifest {
  return { id, name: `Worker ${id}`, about: '', entry: 'main.mjs', runtime: 'node', args: [], mode: 'stay', everyMinutes: null, secrets: [], enabled: true, createdAt: 1, updatedAt: 1 }
}

describe('a deleted worker stays deleted', () => {
  it('a late state write from its dying process does not recreate its state', () => {
    store.write(manifest('w_late0001'), { 'main.mjs': '' })
    store.patchState('w_late0001', { cursor: 'c-1' })
    store.remove('w_late0001')
    store.patchState('w_late0001', { lastLineAt: 5, pid: null })
    expect(store.state('w_late0001').cursor).toBe('')
    expect(store.state('w_late0001').lastLineAt).toBeNull()
  })

  it('a late event from its dying process is dropped, not stored for a worker that is gone', () => {
    store.write(manifest('w_late0002'), { 'main.mjs': '' })
    store.remove('w_late0002')
    expect(store.addEvent('w_late0002', { source: 's', event: 'e', payload: {}, dedupeKey: 'k1' })).toBeNull()
  })

  it('a worker that is there still records state and events', () => {
    store.write(manifest('w_late0003'), { 'main.mjs': '' })
    expect(store.patchState('w_late0003', { cursor: 'c-2' }).cursor).toBe('c-2')
    expect(store.state('w_late0003').cursor).toBe('c-2')
    expect(store.addEvent('w_late0003', { source: 's', event: 'e', payload: {}, dedupeKey: 'k2' })).not.toBeNull()
  })
})
