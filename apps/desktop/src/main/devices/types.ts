/**
 * The seams between the Devices parts (docs/devices-protocol.md). The node server (devices/server.ts) owns the
 * transport and auth; other parts plug in routes, RPC methods and hooks through these interfaces, so they can be
 * built and tested apart and merged without touching each other's files.
 */

export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'server'
export type DevicePlatform = 'android' | 'ios' | 'windows' | 'macos' | 'linux'
export type DeviceRole = 'screen' | 'brain' | 'hands'

export interface DeviceFacts {
  name: string
  kind: DeviceKind
  platform: DevicePlatform
  appVersion: string
  screen: { width: number; height: number }
  canOpenLinks: boolean
  canReceiveFiles: boolean
  /** Fingerprint of the device's own node certificate (nodes only, else ''). */
  fingerprint: string
  urls: string[]
  /** The tools this device lets other devices use (protocol s11), as sent in its hello. */
  tools?: DeviceTool[]
}

/** Protocol s11: what a tool on a device is for, so a person can switch a whole group off. */
export type DeviceToolGroup = 'browser' | 'notifications' | 'files' | 'shell' | 'approval' | 'phone' | 'other'

/** One tool a device offers to the agents on other devices (protocol s11). */
export interface DeviceTool {
  name: string
  description: string
  /** JSON schema of its arguments. */
  params: Record<string, unknown>
  group: DeviceToolGroup
  readOnly: boolean
}

/** A device command of kind "tool" (protocol s5.2 and s11): run `tool` with `args`, answer with device.result. */
export interface DeviceToolCommand {
  kind: 'tool'
  id: string
  tool: string
  args: Record<string, unknown>
  chatId: string
  deadlineMs: number
}

/** What device.result(id, ok, value | error) carries back to the brain. */
export type DeviceToolResult = { ok: true; value: unknown } | { ok: false; error: string }

/** A synced `device` row's payload (protocol s4). */
export interface DeviceRecord {
  id: string
  name: string
  kind: DeviceKind
  platform: DevicePlatform
  roles: DeviceRole[]
  /** Lower is tried first among brains. */
  priority: number
  urls: string[]
  fp: string
  facts: DeviceFacts
  pairedAt: number
  lastSeen: number
  revoked: boolean
  /** Its tool catalogue from its latest hello (protocol s11); absent on rows from before s11. */
  tools?: DeviceTool[]
}

export interface BrainRef {
  id: string
  name: string
  urls: string[]
  fp: string
  priority: number
}

/** Who sent a message (protocol s8), stored on the user message row as meta.origin. */
export interface MessageOrigin {
  deviceId: string
  name: string
  kind: DeviceKind
  platform: DevicePlatform
  screenWidth: number
  canOpenLinks: boolean
  canReceiveFiles: boolean
}

export type RouteAuth = 'none' | 'device' | 'node'

export interface RouteRequest {
  /** The paired device that made the call; null on auth 'none' routes. */
  deviceId: string | null
  method: string
  path: string
  /** Path parameters, e.g. { id } for /v1/devices/:id/revoke. */
  params: Record<string, string>
  query: URLSearchParams
  headers: Record<string, string | string[] | undefined>
  /** Parsed JSON body (POST), or undefined. */
  body: unknown
  signal: AbortSignal
}

export type RouteReply = (
  | { status: number; json: unknown }
  | { status: number; file: string; contentType?: string }
  | { status: number; text: string; contentType?: string }
) & {
  /** Extra response headers (Set-Cookie, Location, Cache-Control). Added by workstream A. */
  headers?: Record<string, string>
}

export interface DevicesRoute {
  method: 'GET' | 'POST'
  /** Express-style path with :params, e.g. '/v1/sync/pull'. */
  path: string
  auth: RouteAuth
  handle(req: RouteRequest): Promise<RouteReply>
}

/** One RPC method callable over /v1/rpc (protocol s5.1). `deviceId` is the caller. */
export type RpcMethod = (deviceId: string, args: unknown[]) => Promise<unknown>

/** What the node server gives the parts that plug into it. */
export interface DevicesHost {
  addRoute(route: DevicesRoute): void
  addRpc(name: string, method: RpcMethod): void
  /** Send an event to every connection of one device (device commands) or, with null, to all. */
  emit(deviceId: string | null, name: string, payload: unknown): void
  /** Facts of a connected device from its latest hello, or null. */
  factsOf(deviceId: string): DeviceFacts | null
  isConnected(deviceId: string): boolean
  /** This node's own id and facts. */
  self(): { id: string; facts: DeviceFacts }
  /**
   * Hears every RPC device.result(id, ok, value | error) a connected device sends (protocol s11). The brain-side
   * router registers here and matches `id` to the command it sent. Returns the unsubscribe.
   */
  onDeviceResult(listener: (deviceId: string, id: string, result: DeviceToolResult) => void): () => void
}

/** Pass hashes (never the passes). Kept in the secrets store; shared with brains through the bundle (s6). */
export interface PassTable {
  /** deviceId to sha256(pass) as hex. */
  all(): Record<string, string>
  set(deviceId: string, hash: string): void
  remove(deviceId: string): void
  replaceAll(table: Record<string, string>): void
}
