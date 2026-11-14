/**
 * Review finding R4 (14 Nov 2026): one replicated routine slot runs on exactly one brain, with replication slower than
 * any wait. Two brains with their own real stores; the test decides when (and whether) rows replicate, and owns the
 * clock. See docs/devices-routine-claims.md for the rules these tests hold.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { LEGACY_ACCOUNT, type TriggerRow } from '@agent/core'

import { Store } from '../src/main/db'
import { NODE_FRESH_MS, Offload, SLOT_STANDIN_MS } from '../src/main/runtime/offload'
import { Scheduler, slotKey } from '../src/main/runtime/scheduler'
import type { RoutineRunResult } from '../src/main/runtime/runner'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 14, 8, 0, 0)

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean()
})

interface Brain {
  id: string
  db: Store
  offload: Offload
  clock: { now: number }
  link: { up: boolean }
}

/** Two brains, each with its own store; `server` is the home brain for a routine nobody pinned. */
async function pair(): Promise<{ srv: Brain; pc: Brain; sync(): Promise<void>; both(change: (brain: Brain) => void): void }> {
  const make = async (id: string, kind: 'server' | 'desktop'): Promise<Brain> => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const clock = { now: T0 }
    const link = { up: true }
    const offload = new Offload({
      store: db,
      selfId: () => id,
      isSelf: (other) => other === id,
      reachable: () => link.up,
      capacity: () => ({ name: id, kind, accounts: [LEGACY_ACCOUNT], cap: 4, active: 0, browser: false }),
      mode: () => 'best',
      handle: async () => true,
      now: () => clock.now,
    })
    return { id, db, offload, clock, link }
  }
  const srv = await make('dev_srv', 'server')
  const pc = await make('dev_pc', 'desktop')
  for (const brain of [srv, pc]) {
    await brain.db.upsert('device', { id: 'dev_srv', name: 'Server', kind: 'server', platform: 'linux', roles: ['brain'], priority: 1, urls: [], fp: '', facts: {}, pairedAt: 0, lastSeen: 0, revoked: false } as never)
    await brain.db.upsert('device', { id: 'dev_pc', name: 'Desk', kind: 'desktop', platform: 'win32', roles: ['brain'], priority: 2, urls: [], fp: '', facts: {}, pairedAt: 0, lastSeen: 0, revoked: false } as never)
  }
  const sync = async (): Promise<void> => {
    await pc.db.applyRemote(await srv.db.localChanges(null), 'dev_srv')
    await srv.db.applyRemote(await pc.db.localChanges(null), 'dev_pc')
  }
  const both = (change: (brain: Brain) => void): void => {
    change(srv)
    change(pc)
  }
  await srv.offload.beat()
  await pc.offload.beat()
  await sync()
  return { srv, pc, sync, both }
}

const REQ = { text: 'Morning brief', account: LEGACY_ACCOUNT }
const SLOT = '2026-11-14T08:00'

describe('R4: one slot, one brain, whatever the replication speed', () => {
  it('replication slower than the wait: the home brain claims, the other never does', async () => {
    const { srv, pc, both } = await pair()
    // No more replication from here on. A long time passes, short of the stand-in time.
    both((brain) => {
      brain.clock.now = T0 + 5 * MIN
    })
    const first = await srv.offload.claimSlot('r1', SLOT, REQ)
    const second = await pc.offload.claimSlot('r1', SLOT, REQ)
    expect(first).not.toBeNull()
    expect(first?.fence).toBe(1)
    expect(first?.key).toBe(`r1@${SLOT}`)
    expect(second).toBeNull()
  })

  it('the older yes-or-no entry point gives one winner too: both brains past the old 90 s grace, replication slower', async () => {
    const { srv, pc, both } = await pair()
    both((brain) => {
      brain.clock.now = T0 + 120_000
    })
    // Both brains saw the slot due and neither has the other's claim yet (no replication in between).
    const wins: boolean[] = []
    wins.push(await srv.offload.claimRoutine('r1', SLOT, REQ))
    wins.push(await pc.offload.claimRoutine('r1', SLOT, REQ))
    pc.clock.now += 91_000
    wins.push(await pc.offload.claimRoutine('r1', SLOT, REQ))
    expect(wins.filter(Boolean)).toHaveLength(1)
  })

  it('two real schedulers on the two brains run a due routine exactly once, with the same key', async () => {
    const { srv, pc, both } = await pair()
    const row = await srv.db.upsert('trigger', { name: 'Brief', kind: 'interval', spec: '15', prompt: 'Do it', enabled: true, lastRunAt: T0 - 60 * MIN, lastResult: '', createdAt: T0 - 600 * MIN })
    await pc.db.upsert('trigger', { ...row, id: row.id })
    both((brain) => {
      brain.clock.now = T0 + 2 * MIN
    })
    const runs: Array<{ brain: string; key: string | undefined }> = []
    const scheduler = (brain: Brain): Scheduler =>
      new Scheduler({
        store: brain.db,
        runner: {
          runRoutine: async (_trigger: TriggerRow, slot): Promise<RoutineRunResult> => {
            runs.push({ brain: brain.id, key: slot?.key })
            return { text: 'ok', waiting: false }
          },
        },
        now: () => brain.clock.now,
        claim: (trigger, key) => brain.offload.claimSlot(trigger.id, key, { text: `${trigger.name}\n${trigger.prompt}`, account: LEGACY_ACCOUNT }).then((claim) => (claim === null ? false : claim)),
      })
    await Promise.all([scheduler(srv).tick(), scheduler(pc).tick()])
    expect(runs).toHaveLength(1)
    expect(runs[0]?.brain).toBe('dev_srv')
    expect(runs[0]?.key).toBe(`${row.id}@${slotKey(row, T0 + 2 * MIN)}`)
  })

  it('a stand-in never claims while the home brain is merely quiet, only after the stand-in time', async () => {
    const { srv, pc, both } = await pair()
    expect(NODE_FRESH_MS).toBeLessThan(SLOT_STANDIN_MS)
    // The home brain stops beating (asleep, or cut off). 14 minutes later the other still stands down.
    both((brain) => {
      brain.clock.now = T0 + SLOT_STANDIN_MS - MIN
    })
    expect(await pc.offload.claimSlot('r1', SLOT, REQ)).toBeNull()
    // After the stand-in time it takes the slot, with fence 1.
    pc.clock.now = T0 + SLOT_STANDIN_MS + MIN
    const taken = await pc.offload.claimSlot('r1', SLOT, REQ)
    expect(taken?.fence).toBe(1)
    expect(srv.clock.now).toBeLessThan(pc.clock.now)
  })

  it('a stand-in that took a slot is not run again by the home brain when it comes back', async () => {
    const { srv, pc, sync, both } = await pair()
    both((brain) => {
      brain.clock.now = T0 + SLOT_STANDIN_MS + MIN
    })
    const taken = await pc.offload.claimSlot('r1', SLOT, REQ)
    expect(taken).not.toBeNull()
    await sync()
    expect(await srv.offload.claimSlot('r1', SLOT, REQ)).toBeNull()
  })

  it('partitioned: the home side keeps running, the other stands down, and a slot both took is caught by the fence on reconnect', async () => {
    const { srv, pc, sync, both } = await pair()
    // Cut: no row crosses, so each side only ever sees its own writes. The stand-in time passes on both.
    both((brain) => {
      brain.clock.now = T0 + SLOT_STANDIN_MS + MIN
    })
    const home = await srv.offload.claimSlot('r1', SLOT, REQ)
    const standIn = await pc.offload.claimSlot('r1', SLOT, REQ)
    // Both took it: this is the one case a cut can allow after the stand-in time, and it is named in the docs.
    expect(home?.fence).toBe(1)
    expect(standIn?.fence).toBe(1)
    // The same key on both, so a tool that dedupes on it does the side effect once.
    expect(home?.key).toBe(standIn?.key)
    // The link comes back: from then on exactly one of the two still holds the slot, and a run that checks it before
    // it starts finds out.
    await sync()
    await sync()
    const stillHeld = [await home?.verify(), await standIn?.verify()].filter(Boolean)
    expect(stillHeld).toHaveLength(1)
  })

  it('a routine pinned to a brain runs there even when that brain is cut off, and nowhere else', async () => {
    const { srv, pc, both } = await pair()
    both((brain) => {
      brain.clock.now = T0 + 3 * MIN
    })
    const pinned = { ...REQ, device: 'Desk' }
    expect(await pc.offload.claimSlot('r2', SLOT, pinned)).not.toBeNull()
    expect(await srv.offload.claimSlot('r2', SLOT, pinned)).toBeNull()
  })

  it('a brain with no other brain at all (Devices off, or alone) runs everything, as before', async () => {
    const db = new Store(':memory:')
    cleanups.push(() => db.close())
    const alone = new Offload({ store: db, selfId: () => '', isSelf: () => false, reachable: () => false, capacity: () => ({ name: 'x', kind: 'desktop', accounts: [], cap: 0, active: 0, browser: false }), mode: () => 'best', handle: async () => true })
    expect(await alone.claimSlot('r1', SLOT, REQ)).not.toBeNull()
  })

  it('the fence is checked: a claim another brain has overwritten no longer verifies', async () => {
    const { srv } = await pair()
    const claim = await srv.offload.claimSlot('r1', SLOT, REQ)
    expect(await claim?.verify()).toBe(true)
    await srv.db.upsert('job', { id: `routine-r1@${SLOT}`, kind: 'claim', device: 'dev_pc', from: 'dev_pc', helper: `r1@${SLOT}`, op: 'routine', status: 'on', info: JSON.stringify({ fence: 2 }), at: T0 })
    expect(await claim?.verify()).toBe(false)
  })
})
