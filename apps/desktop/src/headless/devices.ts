/**
 * The headless node as a Devices node: the same DevicesService the desktop app runs (main/devices/service.ts), as a
 * device of kind 'server' with no screen. It serves /v1/health, pairing, /v1/rpc (every app-contract handler the
 * runtime registered, through the shared handler registry), /v1/devices and /v1/file. No web UI is served.
 */
import { dirname, join } from 'node:path'

import { platformOf } from '../main/devices/facts'
import { findSidecar } from '../main/devices/net'
import { DevicesService } from '../main/devices/service'
import type { DeviceFacts } from '../main/devices/types'
import type { HeadlessRuntime } from './runtime'

export interface HeadlessDevicesOptions {
  name: string
  version: string
  listen: string
  port: number
  /** Extra addresses that reach this node (a public name, an overlay address), as https URLs. */
  extraUrls?: string[]
}

/** What the headless node says about itself when it pairs (protocol s3): a server, no screen. */
export function headlessFacts(name: string, version: string, urls: string[], fp: string): DeviceFacts {
  return {
    name,
    kind: 'server',
    platform: platformOf(process.platform),
    appVersion: version,
    screen: { width: 0, height: 0 },
    canOpenLinks: false,
    canReceiveFiles: false,
    fingerprint: fp,
    urls,
  }
}

/** Ready = some AI account can run a turn now: a plan, or an API account with its key. */
export function canRunTurns(runtime: HeadlessRuntime): boolean {
  if (runtime.accounts.all().some((a) => a.kind !== 'api' || a.hasKey)) return true
  return runtime.settings.get().hasKey
}

export async function startHeadlessDevices(runtime: HeadlessRuntime, options: HeadlessDevicesOptions): Promise<DevicesService> {
  const service = new DevicesService({
    userData: runtime.dataDir,
    store: runtime.store,
    secrets: runtime.secrets,
    registry: runtime.registry,
    appVersion: options.version,
    nodeName: () => options.name,
    platform: process.platform,
    ready: () => canRunTurns(runtime),
    busy: () => runtime.busy(),
    // No web UI on a server: /app/ answers that there is nothing here.
    rendererDir: join(runtime.dataDir, 'no-web-ui'),
    emitWindow: () => undefined,
    log: (message, detail) => runtime.logger.info(message, detail),
    kind: 'server',
    canOpenLinks: false,
    canReceiveFiles: false,
    // The optional overlay helper ships next to agent-node.mjs in the tarball (scripts/build-headless.mjs).
    sidecar: () => findSidecar({ dirs: process.argv[1] !== undefined ? [dirname(process.argv[1])] : [] }),
  })
  service.registerIpc(runtime.ipcMain)
  // Events the window would get go to paired devices too (only the ones they may hear).
  runtime.ipc.onEvent((channel, payload) => service.broadcast(channel, payload))
  await service.start()
  await service.configure({ listen: options.listen, port: options.port })
  if (options.extraUrls !== undefined && options.extraUrls.length > 0) await service.setExtraUrls(options.extraUrls)
  // A headless node exists to be reached: it always listens (on loopback unless told otherwise).
  await service.setEnabled(true)
  return service
}
