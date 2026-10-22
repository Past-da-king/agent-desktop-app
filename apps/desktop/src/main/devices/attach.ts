/**
 * Replication, the bundle, device commands, shared device tools and turn-lease failover (devices/sync.ts) run while
 * Devices is switched on, on the node's own server (DevicesService). One place for the desktop app and the headless
 * node: both call attachDevicesSync once, after the service is made.
 *
 * Routes stay mounted for the life of the process (the server only answers while it listens); switching Devices off
 * stops replication and makes the app treat Devices as off (devicesState.sync = null), switching it on again starts
 * replication again.
 */
import type { DevicesService } from './service'
import { devicesState, registerDevicesSync, type DevicesSync, type DevicesSyncDeps } from './sync'

export type AttachDeps = Omit<DevicesSyncDeps, 'pass'> & {
  /** A pass this node was given by pairing with another node, if any; else the node's own pass is used. */
  pairedPass?: () => string | null
}

export function attachDevicesSync(service: DevicesService, deps: AttachDeps): () => void {
  let sync: DevicesSync | null = null
  const pass = (): string | null => {
    const paired = deps.pairedPass?.() ?? null
    return paired !== null && paired !== '' ? paired : service.ownPass()
  }
  const on = (): void => {
    if (sync === null) {
      const { pairedPass: _pairedPass, ...rest } = deps
      sync = registerDevicesSync(service.host(), { ...rest, pass })
    } else sync.replicator.start()
    devicesState.sync = sync
  }
  const off = (): void => {
    sync?.replicator.stop()
    devicesState.sync = null
  }
  const unsubscribe = service.onSwitch((enabled) => (enabled ? on() : off()))
  if (service.isEnabled()) on()
  return () => {
    unsubscribe()
    sync?.stop()
    sync = null
    devicesState.sync = null
  }
}
