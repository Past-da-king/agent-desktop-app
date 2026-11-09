/**
 * The linked devices, read once for the whole window and kept current: Devices' own change event and any change to
 * a synced device row both read them again (a device connecting fires the first). Rail, title bar, Home and Connections share this one copy.
 */
import type { DeviceRow, DevicesStatus } from '@agent/core'
import { useEffect } from 'react'
import { create } from 'zustand'

import { agent } from '../bridge'
import { NO_DEVICES, summarizeDevices, type DevicesSummary } from '../lib/devices-summary'

interface DevicesState {
  summary: DevicesSummary
  /** What Settings draws from: the same one read, kept whole. `status` is null until the first read lands. */
  status: DevicesStatus | null
  rows: DeviceRow[]
  /** Why the last read failed, or '' when it worked. A failed read keeps the rows it had. */
  error: string
}

const useDevicesStore = create<DevicesState>(() => ({ summary: NO_DEVICES, status: null, rows: [], error: '' }))

let users = 0
let stop: (() => void) | null = null

/** Reads the devices again now (Settings > Devices calls it after a change it made itself). */
export function refreshDevicesSummary(): void {
  const api = agent.devices
  if (api === undefined) return
  void Promise.all([api.status(), api.list()])
    .then(([status, rows]: [DevicesStatus, DeviceRow[]]) => useDevicesStore.setState({ summary: summarizeDevices(status, rows), status, rows, error: '' }))
    .catch((cause: unknown) =>
      useDevicesStore.setState({ error: cause instanceof Error && cause.message !== '' ? cause.message : 'Could not read your devices.' }),
    )
}

/** A status a Devices call handed back (the switch, a share group, the network): shown at once, no second read. */
export function setDevicesStatus(status: DevicesStatus): void {
  useDevicesStore.setState((state) => ({ status, summary: summarizeDevices(status, state.rows) }))
}

function start(): void {
  const api = agent.devices
  if (api === undefined) return
  refreshDevicesSummary()
  const off = api.onChanged(refreshDevicesSummary)
  const offData = agent.data.onChanged((change) => {
    if (change.entity === 'device') refreshDevicesSummary()
  })
  stop = () => {
    off()
    offData()
  }
}

/** Keeps the one shared read alive while any part of the window shows devices. */
function useDevicesFeed(): void {
  useEffect(() => {
    users += 1
    if (users === 1) start()
    return () => {
      users -= 1
      if (users === 0 && stop !== null) {
        stop()
        stop = null
      }
    }
  }, [])
}

export function useDevicesSummary(): DevicesSummary {
  useDevicesFeed()
  return useDevicesStore((state) => state.summary)
}

/** The devices themselves, for Settings: every part of the page reads this one copy instead of asking again. */
export function useDevicesData(): { status: DevicesStatus | null; rows: DeviceRow[]; error: string } {
  useDevicesFeed()
  const status = useDevicesStore((state) => state.status)
  const rows = useDevicesStore((state) => state.rows)
  const error = useDevicesStore((state) => state.error)
  return { status, rows, error }
}
