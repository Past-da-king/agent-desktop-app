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
}

export const DEFAULT_DEVICES_CONFIG: DevicesConfig = { enabled: false, port: 7787, listen: '0.0.0.0', extraUrls: [] }

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
  return { enabled: value['enabled'] === true, port, listen, extraUrls }
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
    return { ...this.state, extraUrls: [...this.state.extraUrls] }
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
export function advertisedUrls(config: DevicesConfig, interfaces: InterfaceMap = networkInterfaces()): string[] {
  const out: string[] = []
  const add = (url: string): void => {
    if (!out.includes(url)) out.push(url)
  }
  const loopbackOnly = config.listen.startsWith('127.') || config.listen === '::1'
  if (!loopbackOnly) {
    for (const list of Object.values(interfaces)) {
      for (const entry of list ?? []) {
        if (!isAdvertisable(entry.address, entry.family, entry.internal)) continue
        const host = entry.family === 'IPv6' || (entry.family as unknown) === 6 ? `[${entry.address.split('%')[0]}]` : entry.address
        add(`https://${host}:${config.port}`)
      }
    }
  }
  for (const url of config.extraUrls) add(url)
  return out
}
