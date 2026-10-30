/**
 * Pause ringing on this computer, and idle or locked (Ayanda, 30 Oct 2026: no alarm in an empty room, the phone keeps
 * ringing), on a fake clock over the real Store and the real SettingsStore. What must hold: a wake never goes unheard
 * because of these, a ring in progress is never silenced, and the phone needs no change.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { Store } from '../src/main/db'
import { SHARED_SETTINGS } from '../src/main/devices/bundle'
import { SettingsStore } from '../src/main/settings'
import { appControlTools, SETTINGS_READ_ONLY } from '../src/main/tools/app-control'
import { wakeTools } from '../src/main/tools/wakeups'
import { WakeupService, type RingItem, type WakeSnapshot } from '../src/main/wakeups/service'
import { dayClockLabel, DELIVERY_WAIT_MS, foldWakes, hereNotes, type IdleState } from '../src/shared/wakeups'
import { testContext } from './support'

const T0 = new Date(2026, 9, 30, 10, 0, 0).getTime() // Fri 30 Oct 2026 10:00 local
const MONDAY_8 = new Date(2026, 10, 2, 8, 0, 0)
const MONDAY_8_LOCAL = '2026-11-02T08:00'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

class Clock {
  t = T0
  now = (): number => this.t
  add(ms: number): void {
    this.t += ms
  }
}

interface Rig {
  clock: Clock
  store: Store
  settings: SettingsStore
  file: string
  idle: { state: IdleState }
  phones: string[]
  service: WakeupService
  shows: RingItem[][]
  sent: WakeSnapshot[]
  ringing(): string[]
  settle(): Promise<void>
  /** Close the app and start it again: same database, same settings file, nothing kept in memory. */
  restart(): Promise<void>
  notes(id: string): Promise<string>
}

function rig(options: { phones?: string[]; settings?: Record<string, unknown>; pollMs?: number } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'wake-pause-'))
  dirs.push(dir)
  const file = join(dir, 'settings.json')
  const clock = new Clock()
  const store = new Store(':memory:', clock.now)
  const idle = { state: 'active' as IdleState }
  const phones = options.phones ?? ['phone-1']
  const shows: RingItem[][] = []
  const sent: WakeSnapshot[] = []
  const r: Rig = {
    clock,
    store,
    settings: new SettingsStore(file),
    file,
    idle,
    phones,
    shows,
    sent,
    service: null as unknown as WakeupService,
    ringing: () => (shows[shows.length - 1] ?? []).map((i) => i.id),
    settle: async () => {
      for (let i = 0; i < 3; i++) {
        r.service.kick()
        await r.service.settled()
      }
    },
    restart: async () => {
      r.service.stop()
      r.settings = new SettingsStore(file)
      r.service = make()
      r.service.start()
      await r.settle()
    },
    notes: async (id) => hereNotes(foldWakes(await store.list('wakeup'), clock.t).find((v) => v.id === id) ?? { away: {}, rangWhy: {} }, 'pc'),
  }
  if (options.settings !== undefined) r.settings.save(options.settings)
  function make(): WakeupService {
    return new WakeupService({
      store,
      onChange: (listener) => store.onChange(listener),
      selfId: () => 'pc',
      selfName: () => 'PC',
      selfRings: () => r.settings.get().wakeupsRingHere,
      pauseUntil: () => r.settings.get().wakeupsPauseHereUntil,
      idleRule: () => r.settings.get().wakeupsPhoneOnlyWhenIdle,
      idleState: () => idle.state,
      devices: async () => [{ id: 'pc', name: 'PC', kind: 'desktop' as const }, { id: 'srv', name: 'Server', kind: 'server' as const }, ...phones.map((id) => ({ id, name: id, kind: 'phone' as const }))],
      settings: () => ({ snoozeMinutes: 5, quietHours: '' }),
      idleSeconds: () => null,
      ringer: { show: (items) => shows.push(items) },
      broadcast: (snap) => sent.push(snap),
      now: clock.now,
      pollMs: options.pollMs,
    })
  }
  r.service = make()
  r.service.start()
  return r
}

const WAKE = { severity: 'urgent' as const, title: 'Client call', whatToDo: 'Join', source: { kind: 'meeting', ref: 'e1', link: '' }, devices: 'all' as const, dedupeKey: '', at: null }

/** The phone's own rule on what it was sent (app-remote WakeRules.decide): targeted, so it rings at once. */
function phoneRings(snap: WakeSnapshot | undefined, id: string, self = 'phone-1'): boolean {
  const wake = snap?.wakes.find((w) => w.id === id)
  return wake !== undefined && (wake.targets.length === 0 || wake.targets.includes(self))
}

describe('pause ringing on this computer', () => {
  it('a paused computer stays quiet, the phone rings at once, and the log says why', async () => {
    const r = rig({ settings: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } })
    const fired = await r.service.fire(WAKE, 'desk: Mail')
    await r.settle()
    expect(r.ringing()).toEqual([])
    expect(phoneRings(r.sent[r.sent.length - 1], fired.id)).toBe(true)
    expect(fired.message).toContain(`paused until ${dayClockLabel(MONDAY_8.getTime())}`)
    await r.service.seen(fired.id, 'phone-1')
    r.clock.add(10 * 60_000)
    await r.settle()
    expect(r.ringing()).toEqual([])
    expect(await r.notes(fired.id)).toBe('not ringing here: paused until Mon 2 Nov 08:00')
  })

  it('a wake sent only to this computer goes to the phone while it is paused (no change on the phone)', async () => {
    const r = rig({ settings: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } })
    const fired = await r.service.fire({ ...WAKE, devices: 'here', at: T0 + 60_000 }, 'routine')
    await r.settle()
    const [row] = (await r.store.list('wakeup')).filter((w) => w.kind === 'wake')
    expect(row?.targets).toEqual(['pc']) // booked here: decided when it rings
    // Before it rings the phone already has it right, in case it loses its link.
    expect(r.sent[r.sent.length - 1]?.wakes[0]?.targets).toEqual([])
    r.clock.add(60_000)
    await r.settle()
    expect(r.ringing()).toEqual([])
    expect(phoneRings(r.sent[r.sent.length - 1], fired.id)).toBe(true)
  })

  it('resumes by itself when the time passes: a new wake rings, and one held back joins', async () => {
    const r = rig({ settings: { wakeupsPauseHereUntil: new Date(T0 + 60 * 60_000).toISOString() } })
    const held = await r.service.fire(WAKE, 'agent')
    await r.service.seen(held.id, 'phone-1')
    await r.settle()
    expect(r.ringing()).toEqual([])
    r.clock.add(59 * 60_000)
    await r.settle()
    expect(r.ringing()).toEqual([])
    r.clock.add(60_000)
    await r.settle()
    expect(r.ringing()).toEqual([held.id])
    const fresh = await r.service.fire({ ...WAKE, title: 'Second' }, 'agent')
    await r.settle()
    expect(r.ringing().sort()).toEqual([held.id, fresh.id].sort())
  })

  it('survives a restart, and resumes by itself across one', async () => {
    const r = rig()
    r.settings.save({ wakeupsPauseHereUntil: new Date(T0 + 60 * 60_000).toISOString() })
    await r.restart()
    const during = await r.service.fire(WAKE, 'agent')
    await r.service.seen(during.id, 'phone-1')
    await r.settle()
    expect(r.ringing()).toEqual([])
    await r.restart()
    expect(r.ringing()).toEqual([])
    // Closed while the pause ends.
    r.service.stop()
    r.clock.add(2 * 60 * 60_000)
    await r.restart()
    const after = await r.service.fire({ ...WAKE, title: 'After' }, 'agent')
    await r.settle()
    expect(r.ringing()).toContain(after.id)
  })

  it('Resume ends the pause at once', async () => {
    const r = rig({ settings: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } })
    const fired = await r.service.fire(WAKE, 'agent')
    await r.service.seen(fired.id, 'phone-1')
    await r.settle()
    r.settings.save({ wakeupsPauseHereUntil: '' })
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
  })

  it('applies to every severity, and his own test button still rings here', async () => {
    const r = rig({ settings: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } })
    const critical = await r.service.fire({ ...WAKE, severity: 'critical' }, 'agent')
    await r.service.seen(critical.id, 'phone-1')
    await r.settle()
    expect(r.ringing()).toEqual([])
    const test = await r.service.fireTest('urgent', ['pc'], 'Settings')
    await r.settle()
    expect(r.ringing()).toEqual([test])
  })
})

describe('idle or locked', () => {
  for (const state of ['idle', 'locked'] as const) {
    it(`${state}: rings only on the phone, and the log says so`, async () => {
      const r = rig()
      r.idle.state = state
      const fired = await r.service.fire(WAKE, 'agent')
      await r.settle()
      expect(r.ringing()).toEqual([])
      expect(phoneRings(r.sent[r.sent.length - 1], fired.id)).toBe(true)
      await r.service.seen(fired.id, 'phone-1')
      r.clock.add(5 * 60_000)
      await r.settle()
      expect(r.ringing()).toEqual([])
      expect(await r.notes(fired.id)).toBe(`not ringing here: PC ${state}`)
    })
  }

  it('the setting off: an idle computer rings as before', async () => {
    const r = rig({ settings: { wakeupsPhoneOnlyWhenIdle: false } })
    r.idle.state = 'idle'
    const fired = await r.service.fire(WAKE, 'agent')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    expect(await r.notes(fired.id)).toBe('')
  })

  it('on by default, with five minutes, and an unknown state counts as active', async () => {
    const r = rig()
    expect(r.settings.get().wakeupsPhoneOnlyWhenIdle).toBe(true)
    expect(r.settings.get().wakeupsIdleMinutes).toBe(5)
    r.idle.state = 'unknown'
    const fired = await r.service.fire(WAKE, 'agent')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
  })

  it('a computer in use rings as before', async () => {
    const r = rig()
    const fired = await r.service.fire(WAKE, 'agent')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
  })
})

describe('a wake never goes unheard', () => {
  for (const how of ['paused', 'idle', 'locked'] as const) {
    const set = (r: Rig): void => {
      if (how === 'paused') r.settings.save({ wakeupsPauseHereUntil: MONDAY_8_LOCAL })
      else r.idle.state = how
    }

    it(`${how}, no phone linked: rings here at once and says why`, async () => {
      const r = rig({ phones: [] })
      set(r)
      const fired = await r.service.fire(WAKE, 'agent')
      await r.settle()
      expect(r.ringing()).toEqual([fired.id])
      expect(fired.message).toContain('no phone is linked')
      expect(await r.notes(fired.id)).toBe('rang here: no phone linked')
    })

    it(`${how}, the phone does not confirm: rings here at exactly 30 s`, async () => {
      const r = rig()
      set(r)
      const fired = await r.service.fire(WAKE, 'agent')
      await r.settle()
      r.clock.add(DELIVERY_WAIT_MS - 1)
      await r.settle()
      expect(r.ringing()).toEqual([])
      r.clock.add(1)
      await r.settle()
      expect(r.ringing()).toEqual([fired.id])
      expect(await r.notes(fired.id)).toContain('rang here: no phone confirmed in 30 s')
    })
  }

  it('a wake sent to the phone that never confirms rings here too, paused or not', async () => {
    const r = rig({ settings: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } })
    const wake = await r.store.upsert('wakeup', { kind: 'wake', wake: '', severity: 'heads_up', title: 'To phone', whatToDo: 'Look', source: { kind: 'mail', ref: '', link: '' }, devices: 'auto', targets: ['phone-1'], dedupeKey: '', rateKey: 'k', at: T0, firedBy: 'a', firedOn: 'pc', withdrawn: false, cancelled: false, repeats: 0, updatedAt: T0 })
    await r.settle()
    expect(r.ringing()).not.toContain(wake.id)
    r.clock.add(DELIVERY_WAIT_MS)
    await r.settle()
    expect(r.ringing()).toContain(wake.id)
  })

  it('only a phone confirms: another computer saying it has it does not silence this one', async () => {
    const r = rig()
    r.idle.state = 'idle'
    const fired = await r.service.fire(WAKE, 'agent')
    await r.service.seen(fired.id, 'pc-2')
    r.clock.add(DELIVERY_WAIT_MS)
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
  })

  it('switched off by him: no ring here even when nothing else can ring', async () => {
    const r = rig({ phones: [], settings: { wakeupsRingHere: false, wakeupsPauseHereUntil: MONDAY_8_LOCAL } })
    await r.service.fire(WAKE, 'agent')
    r.clock.add(10 * 60_000)
    await r.settle()
    expect(r.ringing()).toEqual([])
  })

  it('a ring after a snooze needs a fresh confirmation: the phone that said it had it before does not count', async () => {
    const r = rig({ settings: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } })
    const fired = await r.service.fire(WAKE, 'agent')
    await r.service.seen(fired.id, 'phone-1')
    await r.service.snooze(fired.id, { id: 'phone-1', name: 'Phone' })
    await r.settle()
    r.clock.add(5 * 60_000)
    await r.settle()
    expect(r.ringing()).toEqual([])
    // The phone is told it has not said so for this ring, so it says it again (WakeHub: self not in seen).
    const snap = await r.service.snapshot()
    expect(Object.keys(snap.wakes[0]?.seen ?? {})).toEqual([])
    r.clock.add(1_000)
    await r.service.seen(fired.id, 'phone-1')
    r.clock.add(DELIVERY_WAIT_MS)
    await r.settle()
    expect(r.ringing()).toEqual([])
    // Next ring, and this time the phone is gone.
    await r.service.snooze(fired.id, { id: 'phone-1', name: 'Phone' })
    await r.settle()
    r.clock.add(5 * 60_000)
    await r.settle()
    expect(r.ringing()).toEqual([])
    r.clock.add(DELIVERY_WAIT_MS)
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
  })
})

describe('a ring in progress is never silenced', () => {
  it('going idle or locked: it rings on until he answers', async () => {
    const r = rig()
    const fired = await r.service.fire(WAKE, 'agent')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    // The phone has it too, so the ring in progress is the only reason this computer is still ringing.
    await r.service.seen(fired.id, 'phone-1')
    r.idle.state = 'idle'
    r.clock.add(60 * 60_000)
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    r.idle.state = 'locked'
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    await r.restart()
    expect(r.ringing()).toEqual([fired.id])
    await r.service.ack(fired.id, { id: 'pc', name: 'PC' })
    await r.settle()
    expect(r.ringing()).toEqual([])
  })

  it('an agent cannot silence it with settings_set: pause or switch off leaves it ringing', async () => {
    const r = rig()
    const set = appControlTools({ settings: { get: () => r.settings.get(), save: (patch) => r.settings.save(patch) } } as never).find((t) => t.spec.name === 'settings_set')
    const fired = await r.service.fire(WAKE, 'agent')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    expect(await set?.run({ values: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } }, testContext())).toContain('Changed')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    expect(await set?.run({ values: { wakeupsRingHere: false } }, testContext())).toContain('Changed')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    await r.restart()
    expect(r.ringing()).toEqual([fired.id])
    // But nothing new starts here.
    const next = await r.service.fire({ ...WAKE, title: 'Next' }, 'agent')
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    expect(next.ok).toBe(true)
  })
})

describe('he comes back', () => {
  it('to an active computer while the phone rings: this computer joins, and the phone keeps ringing', async () => {
    const r = rig()
    r.idle.state = 'idle'
    const fired = await r.service.fire(WAKE, 'agent')
    await r.service.seen(fired.id, 'phone-1')
    await r.settle()
    expect(r.ringing()).toEqual([])
    r.clock.add(10 * 60_000)
    r.idle.state = 'active'
    await r.settle()
    expect(r.ringing()).toEqual([fired.id])
    expect(phoneRings(await r.service.snapshot(), fired.id)).toBe(true)
  })

  it('joins even a wake that was only ever for the phone', async () => {
    const r = rig()
    r.idle.state = 'locked'
    await r.settle()
    const wake = await r.store.upsert('wakeup', { kind: 'wake', wake: '', severity: 'heads_up', title: 'On the phone', whatToDo: 'Look', source: { kind: 'mail', ref: '', link: '' }, devices: 'auto', targets: ['phone-1'], dedupeKey: '', rateKey: 'k', at: T0, firedBy: 'a', firedOn: 'pc', withdrawn: false, cancelled: false, repeats: 0, updatedAt: T0 })
    await r.service.seen(wake.id, 'phone-1')
    await r.settle()
    expect(r.ringing()).toEqual([])
    r.clock.add(60_000)
    r.idle.state = 'active'
    await r.settle()
    expect(r.ringing()).toEqual([wake.id])
    expect(await r.notes(wake.id)).toContain('joined here')
  })

  it('he is noticed without anything else happening (the poll runs only while a wake rings elsewhere)', async () => {
    const r = rig({ pollMs: 5 })
    r.idle.state = 'idle'
    const fired = await r.service.fire(WAKE, 'agent')
    await r.service.seen(fired.id, 'phone-1')
    await r.settle()
    r.idle.state = 'active'
    await vi.waitFor(() => expect(r.ringing()).toEqual([fired.id]), { timeout: 2000, interval: 10 })
    r.service.stop()
  })
})

describe('what agents may set', () => {
  const tools = (r: Rig) => appControlTools({ settings: { get: () => r.settings.get(), save: (patch: never) => r.settings.save(patch) } } as never)

  it('settings_set takes wakeupsRingHere and wakeupsPauseHereUntil, reads them back, and refuses a date it cannot read', async () => {
    const r = rig()
    const set = tools(r).find((t) => t.spec.name === 'settings_set')
    expect(String(await set?.run({ values: { wakeupsRingHere: false } }, testContext()))).toContain('wakeupsRingHere = false')
    expect(r.settings.get().wakeupsRingHere).toBe(false)
    expect(String(await set?.run({ values: { wakeupsPauseHereUntil: MONDAY_8_LOCAL } }, testContext()))).toContain('Changed: wakeupsPauseHereUntil = "2026-11-02T08:00:00')
    expect(Date.parse(r.settings.get().wakeupsPauseHereUntil)).toBe(MONDAY_8.getTime())
    const bad = String(await set?.run({ values: { wakeupsPauseHereUntil: 'next monday-ish' } }, testContext()))
    expect(bad).toContain('Not taken')
    expect(Date.parse(r.settings.get().wakeupsPauseHereUntil)).toBe(MONDAY_8.getTime())
    expect(String(await set?.run({ values: { wakeupsPauseHereUntil: '' } }, testContext()))).toContain('Changed')
    expect(r.settings.get().wakeupsPauseHereUntil).toBe('')
    const get = tools(r).find((t) => t.spec.name === 'settings_get')
    expect(String(await get?.run({ key: 'wakeupsPauseHereUntil' }, testContext()))).toContain('[free]')
    expect(String(await get?.run({ key: 'wakeupsRingHere' }, testContext()))).toContain('[free]')
  })

  it('settings_set still refuses snooze, quiet hours, volume and the idle rule', async () => {
    const r = rig()
    const set = tools(r).find((t) => t.spec.name === 'settings_set')
    const before = r.settings.get()
    for (const [key, value] of Object.entries({ wakeupSnoozeMinutes: 30, wakeupQuietHours: '22:00-07:00', wakeupVolume: 0.1, wakeupsPhoneOnlyWhenIdle: false, wakeupsIdleMinutes: 60 })) {
      expect(SETTINGS_READ_ONLY.has(key)).toBe(true)
      expect(String(await set?.run({ values: { [key]: value } }, testContext()))).toContain(`Refused: ${key}`)
    }
    expect(r.settings.get()).toEqual(before)
  })

  it('there is still no answer tool, and the pause stays on this machine (not in the shared settings)', () => {
    expect(wakeTools(() => null).map((t) => t.spec.name)).toEqual(['wake_me', 'wake_withdraw', 'wake_list'])
    for (const key of ['wakeupsRingHere', 'wakeupsPauseHereUntil', 'wakeupsPhoneOnlyWhenIdle', 'wakeupsIdleMinutes']) expect((SHARED_SETTINGS as readonly string[]).includes(key)).toBe(false)
  })

  it('the idle threshold stays in range', () => {
    const r = rig()
    expect(r.settings.save({ wakeupsIdleMinutes: 0 }).wakeupsIdleMinutes).toBe(1)
    expect(r.settings.save({ wakeupsIdleMinutes: 1000 }).wakeupsIdleMinutes).toBe(240)
  })
})

describe('the idle reader', () => {
  it('asks Electron with the setting as its threshold, and says unknown when it cannot', async () => {
    const getSystemIdleState = vi.fn((_seconds: number): string => 'idle')
    vi.doMock('electron', () => ({ powerMonitor: { getSystemIdleState } }))
    const { wakeIdleState } = await import('../src/main/wakeups/idle')
    const read = wakeIdleState({ get: () => ({ wakeupsIdleMinutes: 5 }) }, {})
    expect(read()).toBe('idle')
    expect(getSystemIdleState).toHaveBeenCalledWith(300)
    getSystemIdleState.mockImplementation(() => {
      throw new Error('no power monitor')
    })
    expect(read()).toBe('unknown')
    vi.doUnmock('electron')
  })
})
