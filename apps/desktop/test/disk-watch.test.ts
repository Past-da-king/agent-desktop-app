import { describe, expect, it } from 'vitest'

import { DiskHealth } from '../src/main/disk-health'
import { DiskWatch } from '../src/main/disk-watch'

/** A watch with nothing but what a test needs: a free-space figure a test sets, and everything it said recorded. */
function harness(free: { freeGb: number; totalGb: number } = { freeGb: 100, totalGb: 1000 }) {
  const said: Array<{ kind: 'notify' | 'note' | 'change' | 'log'; text: string }> = []
  const clock = { at: 1_000 }
  const health = new DiskHealth({ name: () => 'DESKTOP-MSHPVRG', now: () => clock.at })
  const watch = new DiskWatch({
    health,
    path: () => '/nowhere',
    notify: (title, body) => said.push({ kind: 'notify', text: `${title}: ${body}` }),
    note: (text) => said.push({ kind: 'note', text }),
    onChange: (state) => said.push({ kind: 'change', text: state.level }),
    stat: async () => free,
    log: (line) => said.push({ kind: 'log', text: line }),
    now: () => clock.at,
  })
  return { health, watch, said, free, clock }
}

/**
 * 27 Nov 2026: nothing told him the disk was full, and every message failed with the same error again and again.
 * Now each node reads its own drive, and says it once, naming the device and the room left.
 */
describe('the disk watch', () => {
  it('says nothing at all while the drive is fine', async () => {
    const { watch, said } = harness()
    await watch.check('start')
    expect(said).toEqual([])
    expect(watch.state()).toMatchObject({ level: 'ok', blocked: false, freeGb: 100 })
  })

  it('reads the drive and warns once when it runs low, then says nothing more about it', async () => {
    const { watch, said, free } = harness({ freeGb: 12, totalGb: 1000 })
    await watch.check('timer')
    expect(said.filter((entry) => entry.kind === 'notify')).toEqual([
      { kind: 'notify', text: 'Disk space low: DESKTOP-MSHPVRG is low on disk space: 12.0 GB free. Free some space, or it stops answering.' },
    ])
    expect(said.filter((entry) => entry.kind === 'note')).toHaveLength(1)
    // The same reading again (a sample every 15 s) must not ring again.
    free.freeGb = 11
    await watch.check('timer')
    expect(said.filter((entry) => entry.kind === 'notify')).toHaveLength(1)
    expect(said.filter((entry) => entry.kind === 'note')).toHaveLength(1)
  })

  it('is out at once when a write fails on a full disk, names the device and the free space, and keeps it to one line', () => {
    const { watch, said } = harness()
    watch.writeFailed(new Error('ENOSPC: no space left on device, write'))
    expect(watch.state()).toMatchObject({ level: 'critical', blocked: true, fullWrite: true })
    const notified = said.filter((entry) => entry.kind === 'notify')
    expect(notified).toHaveLength(1)
    expect(notified[0]?.text).toContain('Disk full on this device:')
    expect(notified[0]?.text).toContain('DESKTOP-MSHPVRG')
    expect(notified[0]?.text).toContain('disk is full')
    // The devices hear it at once, and one line goes into the chat: the phone does not get a wall of errors.
    expect(said.filter((entry) => entry.kind === 'change')).toEqual([{ kind: 'change', text: 'critical' }])
    expect(said.filter((entry) => entry.kind === 'note')).toHaveLength(1)
    // Twenty more messages failing on the same full disk: no more notifications, no more chat lines.
    for (let i = 0; i < 20; i += 1) watch.writeFailed(new Error('database or disk is full'))
    expect(said.filter((entry) => entry.kind === 'notify')).toHaveLength(1)
    expect(said.filter((entry) => entry.kind === 'note')).toHaveLength(1)
    expect(said.filter((entry) => entry.kind === 'change')).toHaveLength(1)
  })

  it('stays out while the drive is tight and comes back with one line once space is freed', () => {
    const { watch, said, health, free, clock } = harness({ freeGb: 1, totalGb: 1000 })
    watch.writeFailed(new Error('database or disk is full'))
    const notes = said.filter((entry) => entry.kind === 'note').length
    // Still tight: the state does not move, so nothing is said again.
    clock.at += 60_000
    watch.sample(8, 1000)
    expect(watch.state().blocked).toBe(true)
    expect(said.filter((entry) => entry.kind === 'note')).toHaveLength(notes)
    // Space is back: it answers again, and says so once.
    clock.at += 60_000
    free.freeGb = 40
    watch.sample(40, 1000)
    expect(watch.state()).toMatchObject({ level: 'ok', blocked: false })
    expect(said.filter((entry) => entry.kind === 'note').at(-1)).toEqual({ kind: 'note', text: 'Disk space is back: this device answers again.' })
    expect(health.line()).toBe('')
  })

  it('does not react to an error that is not about space', () => {
    const { watch, said } = harness()
    watch.writeFailed(new Error('UNIQUE constraint failed: rows.entity'))
    expect(watch.state().blocked).toBe(false)
    expect(said).toEqual([])
  })

  it('reads the real drive without throwing when it cannot', async () => {
    const health = new DiskHealth()
    const watch = new DiskWatch({
      health,
      path: () => '/definitely/not/here',
      notify: () => undefined,
      stat: async () => {
        throw new Error('EPERM: operation not permitted')
      },
    })
    await expect(watch.check('timer')).resolves.toMatchObject({ level: 'ok' })
  })
})
