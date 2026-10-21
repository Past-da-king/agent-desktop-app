/** Settings > Devices in the browser preview: this computer and one made-up phone, all in memory. */
import type { DeviceRole, DeviceRow, DevicesApi, DevicesStatus, PairingOfferInfo } from '@agent/core'

import { qrMatrix } from '../../shared/qr'

const listeners = new Set<() => void>()
const SELF = 'dev_preview_self'
let enabled = false
let extraUrls: string[] = []

function facts(name: string, kind: DeviceRow['kind'], platform: DeviceRow['platform'], width: number): DeviceRow['facts'] {
  return { name, kind, platform, appVersion: '0.0.0', screen: { width, height: 0 }, canOpenLinks: true, canReceiveFiles: true, fingerprint: '', urls: [] }
}

let rows: DeviceRow[] = [
  {
    id: SELF,
    createdAt: Date.now() - 86400000,
    name: 'This computer',
    kind: 'desktop',
    platform: 'windows',
    roles: ['brain', 'hands'],
    priority: 0,
    urls: [],
    fp: 'preview',
    facts: facts('This computer', 'desktop', 'windows', 0),
    pairedAt: Date.now() - 86400000,
    lastSeen: Date.now(),
    revoked: false,
  },
  {
    id: 'dev_preview_phone',
    createdAt: Date.now() - 3600000,
    name: 'Pixel phone',
    kind: 'phone',
    platform: 'android',
    roles: ['screen'],
    priority: 0,
    urls: [],
    fp: '',
    facts: facts('Pixel phone', 'phone', 'android', 412),
    pairedAt: Date.now() - 3600000,
    lastSeen: Date.now() - 120000,
    revoked: false,
  },
]

function changed(): void {
  for (const listener of listeners) listener()
}

function status(): DevicesStatus {
  const urls = enabled ? ['https://192.0.2.10:7787', ...extraUrls] : extraUrls
  return {
    enabled,
    running: enabled,
    port: 7787,
    urls,
    extraUrls,
    nodeId: SELF,
    nodeName: 'This computer',
    fp: 'preview',
    fpWords: 'Prev iewF inge rpri',
    connected: enabled ? ['dev_preview_phone'] : [],
    error: '',
  }
}

export const mockDevices: DevicesApi = {
  async status() {
    return status()
  },
  async setEnabled(on) {
    enabled = on
    changed()
    return status()
  },
  async setExtraUrls(urls) {
    extraUrls = urls.map((url) => url.trim()).filter((url) => url !== '').map((url) => (url.startsWith('https://') ? url : `https://${url}:7787`))
    changed()
    return status()
  },
  async offer(): Promise<PairingOfferInfo> {
    const uri = 'agent://pair?v=1&mesh=preview&node=preview&name=This%20computer&u=https%3A%2F%2F192.0.2.10%3A7787&fp=preview&c=preview'
    return { uri, shortCode: 'K7QM-4XPT', expiresAt: Date.now() + 10 * 60 * 1000, urls: status().urls, qr: qrMatrix(uri) }
  },
  async cancelOffer() {
    return undefined
  },
  async list() {
    return rows.map((row) => ({ ...row }))
  },
  async setRoles(id: string, roles: DeviceRole[]) {
    rows = rows.map((row) => (row.id === id ? { ...row, roles } : row))
    changed()
  },
  async move(id, direction) {
    const brains = rows.filter((row) => row.roles.includes('brain')).sort((a, b) => a.priority - b.priority)
    const at = brains.findIndex((row) => row.id === id)
    const to = direction === 'up' ? at - 1 : at + 1
    if (at < 0 || to < 0 || to >= brains.length) return
    const a = brains[at]
    const b = brains[to]
    if (a === undefined || b === undefined) return
    rows = rows.map((row) => (row.id === a.id ? { ...row, priority: b.priority } : row.id === b.id ? { ...row, priority: a.priority } : row))
    changed()
  },
  async revoke(id) {
    rows = rows.map((row) => (row.id === id ? { ...row, revoked: true } : row))
    changed()
  },
  onChanged(callback) {
    listeners.add(callback)
    return () => listeners.delete(callback)
  },
}
