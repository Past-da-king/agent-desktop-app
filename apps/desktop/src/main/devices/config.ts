/**
 * The Devices settings (protocol s2): off by default. Kept in `<userData>/devices/config.json`, apart from
 * settings.json, so the shared Settings shape does not grow a nested object every build has to merge.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'

export interface DevicesConfig {
  /** "Let my other devices connect". */
  enabled: boolean
  port: number
  /** The address the server listens on. */
  listen: string
  /** Addresses the person typed that reach this node (a public name, a VPN address), as host or https URL. */
  extraUrls: string[]
  /** Protocol s11: which groups of this node's tools other devices may use. Missing groups take their default. */
  shareGroups: Partial<Record<'browser' | 'files' | 'notifications' | 'approval' | 'shell', boolean>>
}

export const DEFAULT_DEVICES_CONFIG: DevicesConfig = { enabled: false, port: 7787, listen: '0.0.0.0', extraUrls: [], shareGroups: {} }

const MAX_EXTRA = 12

/** Accepts "host", "host:port" or "https://host[:port]"; gives back an https URL, or null when it is not usable. */
export function normaliseUrl(raw: string, port: number): string | null {
  const text = raw.trim()
  if (text === '' || text.length > 300) return null
  const withScheme = /^[a-z]+:\/\//i.test(text) ? text : `https://${text}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.hostname === '') return null
  const host = url.hostname.includes(':') && !url.hostname.startsWith('[') ? `[${url.hostname}]` : url.hostname
  return `https://${host}:${url.port === '' ? String(port) : url.port}`
}

export function cleanConfig(raw: unknown): DevicesConfig {
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const port = typeof value['port'] === 'number' && Number.isInteger(value['port']) && value['port'] >= 1 && value['port'] <= 65535 ? value['port'] : DEFAULT_DEVICES_CONFIG.port
  const listen = typeof value['listen'] === 'string' && /^[0-9a-fA-F:.]{2,45}$/.test(value['listen']) ? value['listen'] : DEFAULT_DEVICES_CONFIG.listen
  const extra = Array.isArray(value['extraUrls']) ? value['extraUrls'] : []
  const extraUrls: string[] = []
  for (const item of extra) {
    if (typeof item !== 'string') continue
    const url = normaliseUrl(item, port)
    if (url !== null && !extraUrls.includes(url)) extraUrls.push(url)
    if (extraUrls.length >= MAX_EXTRA) break
  }
  const groups = typeof value['shareGroups'] === 'object' && value['shareGroups'] !== null ? (value['shareGroups'] as Record<string, unknown>) : {}
  const shareGroups: DevicesConfig['shareGroups'] = {}
  for (const key of ['browser', 'files', 'notifications', 'approval', 'shell'] as const) {
    if (typeof groups[key] === 'boolean') shareGroups[key] = groups[key]
  }
  return { enabled: value['enabled'] === true, port, listen, extraUrls, shareGroups }
}

export class DevicesConfigFile {
  private state: DevicesConfig

  constructor(private readonly file: string) {
    let raw: unknown = null
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = null
    }
    this.state = cleanConfig(raw)
  }

  get(): DevicesConfig {
    return { ...this.state, extraUrls: [...this.state.extraUrls], shareGroups: { ...this.state.shareGroups } }
  }

  save(patch: Partial<DevicesConfig>): DevicesConfig {
    this.state = cleanConfig({ ...this.state, ...patch })
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(this.state, null, 2), 'utf8')
    renameSync(temp, this.file)
    return this.get()
  }
}

export type InterfaceMap = ReturnType<typeof networkInterfaces>

/** True for an address another device could plausibly reach: not loopback, not link-local, not internal. */
export function isAdvertisable(address: string, family: string | number, internal: boolean): boolean {
  if (internal) return false
  const v4 = family === 'IPv4' || family === 4
  if (v4) return !address.startsWith('127.') && !address.startsWith('169.254.') && address !== '0.0.0.0'
  const lower = address.toLowerCase()
  if (lower === '::1' || lower === '::') return false
  if (lower.startsWith('fe80')) return false
  // Global unicast (2000::/3) and unique local (fc00::/7, used by mesh VPNs).
  return /^[23]/.test(lower) || lower.startsWith('fc') || lower.startsWith('fd')
}

/** The addresses this node advertises: interface addresses plus the person's extra addresses (protocol s2). */
/** Adapters that are a virtual switch on this machine (containers, VMs), which other devices rarely reach. */
const VIRTUAL_ADAPTER = /^(docker|br-|veth|virbr|vmnet|vboxnet|vethernet|hyper-v|lxc|lxd|podman|cni|flannel)/i

/**
 * How likely another device reaches this address, best first: a VPN or overlay range (100.64.0.0/10, RFC 6598, and
 * fd7a:115c:a1e0::/48 that Tailscale-compatible networks use), then a home or office LAN (192.168/16, 10/8), then
 * the other private range (172.16/12, often a virtual switch), other IPv4, other unique-local IPv6, global IPv6.
 * A virtual-switch adapter goes after all of those.
 */
export function addressRank(address: string, v6: boolean, adapter = ''): number {
  const virtual = VIRTUAL_ADAPTER.test(adapter.trim()) ? 100 : 0
  if (!v6) {
    const [a = 0, b = 0] = address.split('.').map(Number)
    if (a === 100 && b >= 64 && b <= 127) return virtual + 0
    if (a === 192 && b === 168) return virtual + 2
    if (a === 10) return virtual + 3
    if (a === 172 && b >= 16 && b <= 31) return virtual + 5
    return virtual + 6
  }
  const lower = address.toLowerCase()
  if (lower.startsWith('fd7a:115c:a1e0:')) return virtual + 1
  if (lower.startsWith('fc') || lower.startsWith('fd')) return virtual + 7
  return virtual + 8
}

/**
 * The addresses this node advertises (protocol s2): the person's own first, then interface addresses best first
 * (addressRank). `ipv6`: false when the server could only listen on IPv4, so IPv6 addresses would not answer.
 */
export function advertisedUrls(config: DevicesConfig, interfaces: InterfaceMap = networkInterfaces(), ipv6 = true): string[] {
  const out: string[] = []
  const add = (url: string): void => {
    if (!out.includes(url)) out.push(url)
  }
  // The addresses the person added first: they said these reach this node (a VPN or public name), so other devices
  // try them before guessing at local interfaces that may not be reachable from where they are.
  for (const url of config.extraUrls) add(url)
  const loopbackOnly = config.listen.startsWith('127.') || config.listen === '::1'
  if (!loopbackOnly) {
    const found: Array<{ url: string; rank: number; order: number }> = []
    for (const [adapter, list] of Object.entries(interfaces)) {
      for (const entry of list ?? []) {
        if (!isAdvertisable(entry.address, entry.family, entry.internal)) continue
        const v6 = entry.family === 'IPv6' || (entry.family as unknown) === 6
        if (v6 && !ipv6) continue
        const host = v6 ? `[${entry.address.split('%')[0]}]` : entry.address
        found.push({ url: `https://${host}:${config.port}`, rank: addressRank(entry.address, v6, adapter), order: found.length })
      }
    }
    found.sort((x, y) => x.rank - y.rank || x.order - y.order)
    for (const item of found) add(item.url)
  }
  return out
}
