import { describe, expect, it } from 'vitest'

import { DiskHealth } from '../src/main/disk-health'
it('warns once before exhaustion, stops new answers with hysteresis, and recovers after space is freed', () => {
 const guard = new DiskHealth()
 expect(guard.sample(21, 1000).changed).toBe(false)
 expect(guard.sample(12, 1000)).toMatchObject({ changed: true, blocked: false })
 expect(guard.sample(11, 1000).changed).toBe(false)
 expect(guard.sample(4, 1000)).toMatchObject({ changed: true, blocked: true })
 expect(guard.line()).toContain('not answering')
 expect(guard.sample(5.1, 1000).blocked).toBe(true)
 expect(guard.sample(21, 1000)).toMatchObject({ changed: true, blocked: false })
 expect(guard.line()).toBe('')
 expect(guard.sample(-1, 0).blocked).toBe(false)
})

/**
 * 27 Nov 2026: the phone kept sending to a computer whose drive was full. A write that fails because the disk is full
 * is this node's health failing: it must be out at once, say so in words the person reads, and come back only when
 * the drive shows free space again.
 */
describe('a write that failed because the disk is full', () => {
  it('takes the device out at once, before any sample, and says which device and how much is free', () => {
    const guard = new DiskHealth({ name: () => 'DESKTOP-MSHPVRG', now: () => 5_000 })
    expect(guard.blocked()).toBe(false)
    const state = guard.writeFailed(new Error('ENOSPC: no space left on device, write'))
    expect(state).toEqual({ changed: true, blocked: true, full: true })
    expect(guard.blocked()).toBe(true)
    expect(guard.line()).toContain('disk is full')
    expect(guard.line()).toContain('another device')
    // The person is told which computer it is, not just that something is wrong.
    expect(guard.notice()).toContain('DESKTOP-MSHPVRG')
    expect(guard.notice()).toContain('disk is full')
    // A second failure of the same kind is not a new state: no second notification for the same news.
    expect(guard.writeFailed(new Error('database or disk is full')).changed).toBe(false)
    expect(guard.failedAt()).toBe(5_000)
  })

  it('stays out while the drive is tight, even if a sample taken meanwhile reads above the stop line', () => {
    let clock = 1_000
    const guard = new DiskHealth({ now: () => clock })
    guard.writeFailed(new Error('database or disk is full'))
    // Over the stop threshold (5 GB of 1000) but under the warning line (20 GB): a write still failed, so stay out.
    clock += 60_000
    expect(guard.sample(8, 1000)).toMatchObject({ blocked: true })
    expect(guard.line()).toContain('disk is full')
    // Room for new writes again: back, and the notice names the free space that came back.
    clock += 60_000
    expect(guard.sample(40, 1000)).toMatchObject({ changed: true, blocked: false })
    expect(guard.state().fullWrite).toBe(false)
    expect(guard.line()).toBe('')
    expect(guard.notice()).toBe('')
  })

  it('holds a failed write for half a minute, so one stale reading cannot put it straight back in the order', () => {
    let clock = 1_000
    const guard = new DiskHealth({ now: () => clock })
    guard.writeFailed(new Error('ENOSPC: no space left on device, write'))
    // A reading taken a moment later says there is room: not believed yet (it may be another volume, or a quota).
    clock += 5_000
    expect(guard.sample(200, 1000).blocked).toBe(true)
    clock += 60_000
    expect(guard.sample(200, 1000).blocked).toBe(false)
  })

  it('is not moved by an error that is not about space', () => {
    const guard = new DiskHealth()
    expect(guard.writeFailed(new Error('UNIQUE constraint failed'))).toEqual({ changed: false, blocked: false, full: false })
    expect(guard.blocked()).toBe(false)
    expect(guard.line()).toBe('')
  })

  it('names the low disk before it stops, with the figure', () => {
    const guard = new DiskHealth({ name: () => 'impetix' })
    guard.sample(12, 1000)
    expect(guard.notice()).toBe('impetix is low on disk space: 12.0 GB free. Free some space, or it stops answering.')
    expect(guard.line()).toContain('Low disk space')
    guard.sample(3, 1000)
    expect(guard.notice()).toBe('impetix has only 3.0 GB free on its app data drive, so it stopped taking new messages. Messages go to your other devices until space is freed.')
  })
})
