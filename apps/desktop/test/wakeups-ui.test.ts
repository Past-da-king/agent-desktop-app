/**
 * Wake-ups, the parts around the core: severity colours are the app's own tokens; the devices link gives a phone's
 * wake channel only wake-up events and never lets it stand in for the phone's facts; the RPC a phone uses answers
 * for that phone; settings keep wake-up values in range.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { cleanFacts } from '../src/main/devices/facts'
import { SEVERITY_LOOK } from '../src/shared/wakeups'
import { Store } from '../src/main/db'
import { WakeupService } from '../src/main/wakeups/service'
import { registerWakeupRpc, WakeDeviceReports } from '../src/main/wakeups/bridge'
import type { DevicesHost, RpcMethod } from '../src/main/devices/types'

const here = dirname(fileURLToPath(import.meta.url))

describe('wake-ups around the core', () => {
  it('severity colours are the light-theme tokens --err, --tert, --ok', () => {
    const css = readFileSync(join(here, '..', 'src', 'renderer', 'styles', 'tokens.css'), 'utf8')
    for (const look of Object.values(SEVERITY_LOOK)) {
      const found = new RegExp(`${look.token}:(#[0-9A-Fa-f]{6})`).exec(css)
      expect(found?.[1]?.toUpperCase()).toBe(look.bg.toUpperCase())
    }
  })

  it('a wake channel hello is marked wakeOnly; a normal hello is not', () => {
    const base = { kind: 'phone', platform: 'android', name: 'Pixel' }
    expect(cleanFacts({ ...base, wakeOnly: true })?.wakeOnly).toBe(true)
    expect(cleanFacts(base)?.wakeOnly).toBeUndefined()
  })

  it('the phone answers, snoozes, says it has it and reports its checklist over RPC, as itself', async () => {
    const methods = new Map<string, RpcMethod>()
    const host = { addRpc: (name: string, fn: RpcMethod) => methods.set(name, fn) } as unknown as DevicesHost
    let t = Date.UTC(2026, 9, 29, 10)
    const store = new Store(':memory:', () => t)
    const service = new WakeupService({
      store,
      onChange: (l) => store.onChange(l),
      selfId: () => 'pc-1',
      selfName: () => 'PC',
      selfRings: () => true,
      devices: async () => [
        { id: 'pc-1', name: 'PC', kind: 'desktop' },
        { id: 'phone-1', name: 'Phone', kind: 'phone' },
      ],
      settings: () => ({ snoozeMinutes: 5, quietHours: '' }),
      now: () => t,
    })
    const reports = new WakeDeviceReports()
    registerWakeupRpc(host, { service: () => service, reports, nameOf: async (id) => (id === 'phone-1' ? 'Phone' : id), now: () => t })
    const call = (name: string, args: unknown[]): Promise<unknown> => (methods.get(name) as RpcMethod)('phone-1', args)

    const id = String(await call('wakeups.test', ['critical']))
    const snap = (await call('wakeups.list', [])) as { wakes: Array<{ id: string; targets: string[] }> }
    expect(snap.wakes[0]).toMatchObject({ id, targets: ['phone-1'] })
    await call('wakeups.seen', [id])
    expect(await call('wakeups.snooze', [id, 2])).toBe(true)
    t += 2 * 60_000
    expect(await call('wakeups.ack', [id])).toBe(true)
    const [view] = await service.list()
    expect(view).toMatchObject({ state: 'acked', ackedBy: 'Phone', snoozes: 1 })
    expect(view?.seen['phone-1']).toBeDefined()

    await call('wakeups.status', [{ appVersion: '0.15.0', checks: [{ key: 'fsi', label: 'Full-screen notifications', ok: false, help: 'Allow it' }] }])
    expect(reports.get('phone-1')).toMatchObject({ appVersion: '0.15.0', checks: [{ key: 'fsi', ok: false }] })
  })
})
