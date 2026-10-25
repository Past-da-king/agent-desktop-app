/**
 * The linked devices in one line, for the places that say where the agent runs (the account under the rail, the
 * title bar, Home and Connections). Pure, so it is unit tested directly; state/useDevices.ts feeds it.
 */
import type { DeviceKind, DeviceRow, DevicesStatus } from '@agent/core'

export interface LinkedDevice {
  id: string
  name: string
  kind: DeviceKind
  /** It can answer (run agents): where heavy work can go. */
  brain: boolean
  /** Connected to this computer now. */
  online: boolean
  lastSeen: number
}

export interface DevicesSummary {
  /** Devices is on here (other devices may connect). */
  enabled: boolean
  /** Linked devices other than this one, while Devices is on. */
  count: number
  online: number
  others: LinkedDevice[]
  /** The linked devices that can take work, first tried first. */
  brains: LinkedDevice[]
  /** "3 devices linked", or "This computer only". */
  line: string
}

export const NO_DEVICES: DevicesSummary = { enabled: false, count: 0, online: 0, others: [], brains: [], line: 'This computer only' }

export function summarizeDevices(status: DevicesStatus | null, rows: DeviceRow[]): DevicesSummary {
  if (status === null || !status.enabled) return NO_DEVICES
  // Up either way: it is connected to us, or our replication link to it works (as offload counts a brain up).
  const connected = new Set([...status.connected, ...(status.linked ?? [])])
  const live = rows
    .filter((row) => !row.revoked && row.id !== status.nodeId)
    .sort((a, b) => a.priority - b.priority)
  const others: LinkedDevice[] = live.map((row) => ({
    id: row.id,
    name: row.name || row.facts?.name || 'A device',
    kind: row.kind,
    brain: row.roles.includes('brain'),
    online: connected.has(row.id),
    lastSeen: row.lastSeen,
  }))
  const count = others.length
  const online = others.filter((device) => device.online).length
  return {
    enabled: true,
    count,
    online,
    others,
    brains: others.filter((device) => device.brain),
    line: count === 0 ? 'This computer only' : `${count} ${count === 1 ? 'device' : 'devices'} linked`,
  }
}
