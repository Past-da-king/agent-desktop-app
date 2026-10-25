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
}

const useDevicesStore = create<DevicesState>(() => ({ summary: NO_DEVICES }))

let users = 0
let stop: (() => void) | null = null

/** Reads the devices again now (Settings > Devices calls it after a change it made itself). */
export function refreshDevicesSummary(): void {
  const api = agent.devices
  if (api === undefined) return
  void Promise.all([api.status(), api.list()])
    .then(([status, rows]: [DevicesStatus, DeviceRow[]]) => useDevicesStore.setState({ summary: summarizeDevices(status, rows) }))
    .catch(() => undefined)
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

export function useDevicesSummary(): DevicesSummary {
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
  return useDevicesStore((state) => state.summary)
}
