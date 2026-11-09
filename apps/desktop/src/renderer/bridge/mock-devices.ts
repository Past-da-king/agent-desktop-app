/** Settings > Devices in the browser preview: this computer and one made-up phone, all in memory. */
import type { DeviceRole, DeviceRow, DevicesApi, DevicesNetwork, DevicesStatus, PairingOfferInfo } from '@agent/core'

import { qrMatrix } from '../../shared/qr'

const listeners = new Set<() => void>()
const SELF = 'dev_preview_self'
let enabled = false
let extraUrls: string[] = []
let network: DevicesNetwork = { mode: 'none', controlUrl: '', state: 'off', available: true, hasKey: false, addresses: [], dnsName: '', peers: 0, authUrl: '', error: '' }

/** The preview pretends the overlay comes up at once with a made-up address from the documentation range. */
function networkNow(): DevicesNetwork {
  if (network.mode === 'none') return { ...network, state: 'off', addresses: [], dnsName: '', peers: 0 }
  if (!enabled) return { ...network, state: 'off', addresses: [], dnsName: '', peers: 0 }
  if (!network.hasKey) return { ...network, state: 'needs-login', addresses: [], dnsName: '', peers: 0 }
  return { ...network, state: 'running', addresses: ['100.64.0.7'], dnsName: 'this-computer.example.ts.net', peers: 2 }
}
let shareGroups = { browser: true, files: true, notifications: true, approval: true, shell: false }
let firewall: DevicesStatus['firewall'] = 'blocked'

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
  {
    id: 'dev_preview_server',
    createdAt: Date.now() - 7200000,
    name: 'Home server',
    kind: 'server',
    platform: 'linux',
    roles: ['brain', 'hands'],
    priority: 1,
    urls: [],
    fp: 'preview-server',
    facts: facts('Home server', 'server', 'linux', 0),
    pairedAt: Date.now() - 7200000,
    lastSeen: Date.now() - 30000,
    revoked: false,
  },
]

// The empty demo is a computer with nothing linked yet, so Settings shows its empty states.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('demo') === 'empty') rows = rows.filter((row) => row.id === SELF)

function changed(): void {
  for (const listener of listeners) listener()
}

function status(): DevicesStatus {
  const net = networkNow()
  const overlay = net.state === 'running' ? [`https://${net.addresses[0] ?? ''}:7787`, `https://${net.dnsName}:7787`] : []
  const urls = enabled ? ['https://192.0.2.10:7787', ...extraUrls, ...overlay] : extraUrls
  return {
    enabled,
    running: enabled,
    port: 7787,
    urls,
    extraUrls,
    nodeId: SELF,
    viewer: SELF,
    nodeName: 'This computer',
    fp: 'preview',
    fpWords: 'Prev iewF inge rpri',
    connected: enabled ? ['dev_preview_phone'] : [],
    linked: enabled ? ['dev_preview_server'] : [],
    error: '',
    network: net,
    shareGroups: { ...shareGroups },
    firewall: enabled ? firewall : 'not-needed',
    servingTo: '',
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
  async setNetwork(input) {
    if (input.mode === 'headscale' && (input.controlUrl ?? network.controlUrl).trim() === '') throw new Error('Add the address of your Headscale server, like https://headscale.example.com.')
    const hasKey = input.authKey === null ? false : typeof input.authKey === 'string' && input.authKey.trim() !== '' ? true : network.hasKey
    network = { ...network, mode: input.mode, controlUrl: input.mode === 'headscale' ? (input.controlUrl ?? network.controlUrl).trim() : network.controlUrl, hasKey }
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
  async forget(id) {
    rows = rows.filter((row) => row.id !== id)
    changed()
  },
  async join(link: string) {
    if (!link.startsWith('agent://pair?')) throw new Error('That is not a pairing link. It starts with agent://pair?v=1')
    enabled = true
    changed()
    return { node: { id: 'dev_preview_server', name: 'A server' }, url: 'https://192.0.2.20:7787', deviceId: SELF, meshId: 'mesh_preview', brains: [{ id: 'dev_preview_server', name: 'A server' }], tookBundle: false }
  },
  async setShareGroup(group, on) {
    shareGroups = { ...shareGroups, [group]: on }
    changed()
    return status()
  },
  async allowFirewall() {
    firewall = 'allowed'
    changed()
    return status()
  },
  onChanged(callback) {
    listeners.add(callback)
    return () => listeners.delete(callback)
  },
}
