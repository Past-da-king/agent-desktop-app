/**
 * Which device a message came from (docs/devices-protocol.md s8). Every user message row carries
 * `meta.origin = MessageOrigin`: the node server writes it for messages sent over RPC, and messages typed on this
 * node get this node's own facts. The prompt names the device in one line, and the tools that act on the person's
 * device (open_url, send_file) send to it.
 */
import { hostname } from 'node:os'

import { MAIN_CHAT, type ChatItem, type JsonObject } from '@agent/core'

import { listWhere, type DataStore } from '../runtime/data'
import type { DeviceFacts, DeviceKind, DevicePlatform, MessageOrigin } from './types'

export function originFromFacts(deviceId: string, facts: DeviceFacts): MessageOrigin {
  return {
    deviceId,
    name: facts.name,
    kind: facts.kind,
    platform: facts.platform,
    screenWidth: facts.screen.width,
    canOpenLinks: facts.canOpenLinks,
    canReceiveFiles: facts.canReceiveFiles,
  }
}

export function platformOf(platform: string = process.platform): DevicePlatform {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'macos'
  if (platform === 'android') return 'android'
  return 'linux'
}

/** This computer's facts when Devices is off (or before the node server says otherwise). */
export function localFacts(name = '', screenWidth = 0): DeviceFacts {
  return {
    name: name.trim() || hostname() || 'This computer',
    kind: 'desktop',
    platform: platformOf(),
    appVersion: '',
    screen: { width: screenWidth, height: 0 },
    canOpenLinks: true,
    canReceiveFiles: true,
    fingerprint: '',
    urls: [],
  }
}

export function isOrigin(value: unknown): value is MessageOrigin {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return typeof o['deviceId'] === 'string' && o['deviceId'] !== '' && typeof o['kind'] === 'string' && typeof o['platform'] === 'string'
}

export function originOfRow(row: ChatItem | null | undefined): MessageOrigin | null {
  if (row === null || row === undefined) return null
  try {
    const meta = JSON.parse(row.meta) as Record<string, unknown>
    return isOrigin(meta['origin']) ? meta['origin'] : null
  } catch {
    return null
  }
}

/** The origin of the newest message the person sent in a chat (null when it has none, e.g. older rows). */
export async function latestOrigin(store: DataStore, chat: string = MAIN_CHAT): Promise<MessageOrigin | null> {
  const rows = await listWhere(store, 'chat_item', { chat, kind: 'user', newestFirst: true, limit: 1 })
  return originOfRow(rows[0])
}

const KIND_WORDS: Record<DeviceKind, string> = { phone: 'phone', tablet: 'tablet', desktop: 'computer', server: 'server' }
const PLATFORM_WORDS: Record<DevicePlatform, string> = { android: 'Android', ios: 'iOS', windows: 'Windows', macos: 'macOS', linux: 'Linux' }

/** The one line the prompt gets: which device the message came from and what it can do. */
export function originLine(origin: MessageOrigin | null, selfId: string): string {
  if (origin === null || origin.deviceId === selfId) {
    return 'The user is typing on this computer: open_url opens links here, and files are already here.'
  }
  const kind = KIND_WORDS[origin.kind] ?? origin.kind
  const platform = PLATFORM_WORDS[origin.platform] ?? origin.platform
  const facts = [
    `${kind}, ${platform}`,
    origin.screenWidth > 0 ? `screen ${origin.screenWidth} px wide` : '',
    origin.canOpenLinks ? 'can open links' : 'cannot open links',
    origin.canReceiveFiles ? 'can receive files' : 'cannot receive files',
  ].filter((part) => part !== '')
  const narrow = origin.screenWidth > 0 && origin.screenWidth < 700 ? ' Keep replies and cards narrow.' : ''
  return `This message came from the user's ${origin.name} (${facts.join(', ')}). open_url and send_file go to that device, not this computer.${narrow}`
}

export function originMeta(origin: MessageOrigin): JsonObject {
  return { ...origin } as unknown as JsonObject
}
