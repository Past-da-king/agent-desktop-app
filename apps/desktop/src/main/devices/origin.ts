/**
 * Which device a message came from (protocol s8): the caller of a wire call, or this node itself for a message
 * typed in its own window. The node's own facts are set by the devices service once it has an identity; before
 * that (Devices never switched on) local messages carry no origin, as before.
 */
import { wireOf } from './registry'
import type { DeviceFacts, MessageOrigin } from './types'

let local: MessageOrigin | null = null

export function originFrom(deviceId: string, facts: DeviceFacts): MessageOrigin {
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

export function setLocalOrigin(origin: MessageOrigin | null): void {
  local = origin
}

/** The origin for a handler's event: the wire caller, else this node, else undefined. */
export function messageOrigin(event: unknown): MessageOrigin | undefined {
  return wireOf(event)?.origin ?? local ?? undefined
}
