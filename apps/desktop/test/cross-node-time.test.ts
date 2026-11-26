/**
 * Times that other computers read must be on the corrected app clock, not the operating system's (26 Nov 2026: the PC's
 * clock was 35 minutes slow, so the server saw every turn lease the PC held as long dead and took the turn over while
 * the PC was still answering it, and read every command the PC queued as already expired).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appClock, appNow } from '../src/main/clock/app-clock'
import { Store } from '../src/main/db'
import { TurnLeases } from '../src/main/runtime/turns'

const SKEW = 35 * 60_000
let real = 0

beforeEach(() => {
  real = Date.now()
  vi.useFakeTimers({ now: real - SKEW, toFake: ['Date'] })
  // A synced peer says what the time really is.
  appClock.setSelfSynced(false)
  const sentAt = Date.now()
  appClock.sample({ peer: 'server', name: 'server', sentAt, receivedAt: sentAt + 40, peerNow: real + 20, heldMs: 0, synced: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the app clock is what other computers read', () => {
  it('is real time although the operating system is 35 minutes slow', () => {
    expect(Math.abs(appNow() - real)).toBeLessThan(2_000)
    expect(Date.now()).toBeLessThan(real - SKEW + 2_000)
  })

  it('stamps a turn lease heartbeat with real time by default', async () => {
    const store = new Store(':memory:')
    const leases = new TurnLeases({ store, selfId: () => 'pc', ownIds: () => ['pc'] })
    const id = leases.begin({ kind: 'turn', chatId: 'main', messageId: 'm1', prompt: 'hi' })
    await leases.settled()
    const row = await store.get('turn_lease', id)
    expect(Math.abs((row?.heartbeatAt ?? 0) - real)).toBeLessThan(2_000)
    leases.stop()
    store.close()
  })
})
