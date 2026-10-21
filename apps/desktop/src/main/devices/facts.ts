/** DeviceFacts from the wire, checked and clamped (a device is trusted with its pass, not with its strings). */
import type { DeviceFacts, DeviceKind, DevicePlatform, DeviceRole } from './types'

const KINDS: readonly DeviceKind[] = ['phone', 'tablet', 'desktop', 'server']
const PLATFORMS: readonly DevicePlatform[] = ['android', 'ios', 'windows', 'macos', 'linux']
const ROLES: readonly DeviceRole[] = ['screen', 'brain', 'hands']

function text(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean === '' ? fallback : clean.slice(0, max)
}

function size(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000 ? Math.round(value) : 0
}

export function cleanFacts(raw: unknown): DeviceFacts | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const kind = KINDS.find((k) => k === value['kind'])
  const platform = PLATFORMS.find((p) => p === value['platform'])
  if (kind === undefined || platform === undefined) return null
  const screen = typeof value['screen'] === 'object' && value['screen'] !== null ? (value['screen'] as Record<string, unknown>) : {}
  const urls = Array.isArray(value['urls'])
    ? value['urls'].filter((u): u is string => typeof u === 'string' && /^https:\/\/[^\s]{3,290}$/.test(u)).slice(0, 12)
    : []
  return {
    name: text(value['name'], 80, kind === 'phone' ? 'Phone' : 'Device'),
    kind,
    platform,
    appVersion: text(value['appVersion'], 40),
    screen: { width: size(screen['width']), height: size(screen['height']) },
    canOpenLinks: value['canOpenLinks'] === true,
    canReceiveFiles: value['canReceiveFiles'] === true,
    fingerprint: typeof value['fingerprint'] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value['fingerprint']) ? value['fingerprint'] : '',
    urls,
  }
}

export function cleanRoles(raw: unknown): DeviceRole[] {
  if (!Array.isArray(raw)) return []
  const out: DeviceRole[] = []
  for (const role of ROLES) if (raw.includes(role)) out.push(role)
  return out
}

export function platformOf(processPlatform: string): DevicePlatform {
  if (processPlatform === 'win32') return 'windows'
  if (processPlatform === 'darwin') return 'macos'
  return 'linux'
}
