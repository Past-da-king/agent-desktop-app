/**
 * Wake-ups to the window (IPC: Settings > Wake-ups) and to linked devices (RPC: the phone's app and its wake channel).
 * Every answer that comes in here is his own hands: the ringing screen on the phone, or Settings. Agents have no way
 * in (main/tools/wakeups.ts has no answer tool).
 */
import type { WakeDeviceStatus } from '@agent/core'

import { WAKEUP_CHANNELS, WAKEUP_RPC } from '../../shared/wakeups-channels'
import { isSeverity } from '../../shared/wakeups'
import type { IpcMainLike } from '../ipc'
import type { DevicesHost } from '../devices/types'
import type { WakeupService } from './service'

/** What linked phones reported about their wake-up permissions (in memory: they report again on every connect). */
export class WakeDeviceReports {
  private readonly reports = new Map<string, { at: number; appVersion: string; checks: WakeDeviceStatus['checks'] }>()

  set(deviceId: string, raw: unknown, now: number): void {
    const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const list = Array.isArray(value['checks']) ? value['checks'] : []
    const checks: WakeDeviceStatus['checks'] = []
    for (const item of list.slice(0, 20)) {
      if (typeof item !== 'object' || item === null) continue
      const c = item as Record<string, unknown>
      const key = typeof c['key'] === 'string' ? c['key'].slice(0, 40) : ''
      if (key === '') continue
      checks.push({ key, label: typeof c['label'] === 'string' ? c['label'].slice(0, 120) : key, ok: c['ok'] === true, help: typeof c['help'] === 'string' ? c['help'].slice(0, 300) : '' })
    }
    this.reports.set(deviceId, { at: now, appVersion: typeof value['appVersion'] === 'string' ? value['appVersion'].slice(0, 40) : '', checks })
  }

  get(deviceId: string): { at: number; appVersion: string; checks: WakeDeviceStatus['checks'] } | undefined {
    return this.reports.get(deviceId)
  }
}

export interface WakeBridgeDeps {
  service: () => WakeupService | null
  reports: WakeDeviceReports
  /** A device's name from its row. */
  nameOf: (deviceId: string) => Promise<string>
  now?: () => number
}

/** The RPC a linked device calls (the phone's ringing screen and its wake channel). */
export function registerWakeupRpc(host: DevicesHost, deps: WakeBridgeDeps): void {
  const now = deps.now ?? Date.now
  const need = (): WakeupService => {
    const service = deps.service()
    if (service === null) throw new Error('Wake-ups are not running here.')
    return service
  }
  const idOf = (args: unknown[]): string => {
    const id = args[0]
    if (typeof id !== 'string' || id === '' || id.length > 100) throw new Error('Which wake-up?')
    return id
  }
  host.addRpc(WAKEUP_RPC.list, async () => need().snapshot())
  host.addRpc(WAKEUP_RPC.ack, async (deviceId, args) => need().ack(idOf(args), { id: deviceId, name: await deps.nameOf(deviceId) }))
  host.addRpc(WAKEUP_RPC.snooze, async (deviceId, args) => {
    const minutes = typeof args[1] === 'number' && Number.isFinite(args[1]) ? args[1] : undefined
    return need().snooze(idOf(args), { id: deviceId, name: await deps.nameOf(deviceId) }, minutes)
  })
  host.addRpc(WAKEUP_RPC.seen, async (deviceId, args) => {
    await need().seen(idOf(args), deviceId)
    return true
  })
  host.addRpc(WAKEUP_RPC.status, async (deviceId, args) => {
    deps.reports.set(deviceId, args[0], now())
    return true
  })
  // The phone's own "Test a wake-up" button: rings that phone (and only it) through the same path as any wake.
  host.addRpc(WAKEUP_RPC.test, async (deviceId, args) => {
    const severity = isSeverity(args[0]) ? args[0] : 'urgent'
    const result = await need().fireTest(severity, [deviceId], await deps.nameOf(deviceId))
    return result
  })
}

export interface WakeIpcDeps extends WakeBridgeDeps {
  selfName: () => string
  /** Linked devices that can ring (phones and computers), for the checklist. */
  devices: () => Promise<Array<{ id: string; name: string; kind: string; appVersion: string }>>
  reachable: (deviceId: string) => boolean
}

/** Settings > Wake-ups. */
export function registerWakeupIpc(ipcMain: IpcMainLike, deps: WakeIpcDeps): void {
  const need = (): WakeupService => {
    const service = deps.service()
    if (service === null) throw new Error('Wake-ups are not running.')
    return service
  }
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    [WAKEUP_CHANNELS.test]: async (severity, devices) => {
      const service = need()
      const sev = isSeverity(severity) ? severity : 'urgent'
      return service.fireTest(sev, devices === 'all' ? [] : [service.selfId()], 'Settings')
    },
    [WAKEUP_CHANNELS.ack]: async (id) => (typeof id === 'string' ? need().ack(id, { id: need().selfId(), name: deps.selfName() }) : false),
    [WAKEUP_CHANNELS.snooze]: async (id, minutes) =>
      typeof id === 'string' ? need().snooze(id, { id: need().selfId(), name: deps.selfName() }, typeof minutes === 'number' ? minutes : undefined) : false,
    [WAKEUP_CHANNELS.selfId]: async () => need().selfId(),
    [WAKEUP_CHANNELS.devices]: async (): Promise<WakeDeviceStatus[]> => {
      const list = await deps.devices()
      return list.map((d) => {
        const report = deps.reports.get(d.id)
        return {
          id: d.id,
          name: d.name,
          kind: d.kind,
          reachable: deps.reachable(d.id),
          reportedAt: report?.at ?? 0,
          appVersion: report?.appVersion || d.appVersion,
          checks: report?.checks ?? [],
        }
      })
    },
  }
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (_event, ...args) => handler(...args))
}
