/**
 * The headless node as a Devices node: the same DevicesService the desktop app runs (main/devices/service.ts), as a
 * device of kind 'server' with no screen. It serves /v1/health, pairing, /v1/rpc (every app-contract handler the
 * runtime registered, through the shared handler registry), /v1/devices and /v1/file. No web UI is served.
 */
import { join } from 'node:path'

import { platformOf } from '../main/devices/facts'
import { attachDevicesSync } from '../main/devices/attach'
import { registerRelay, rolesFromStore } from '../main/devices/relay'
import { devicesState } from '../main/devices/sync'
import { readConfig, writeConfig } from './node-config'
import { PASS_SECRET } from './pair'
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
  /** Tests only: let relay.fetch reach a local fake page. */
  relayLoopback?: boolean
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
    // The brains it paired with sign in before their rows replicate here (their first push brings them).
    knownPeer: (id) => (readConfig(runtime.dataDir).brains.some((brain) => brain.id === id) ? ['brain', 'hands'] : null),
  })
  service.registerIpc(runtime.ipcMain)
  // Replication, the bundle, device commands, shared tools and turn failover (devices/attach.ts), as on the desktop.
  const detach = attachDevicesSync(service, {
    store: runtime.store,
    bundle: {
      settings: runtime.settings,
      secrets: runtime.secrets,
      profiles: runtime.apps.profiles,
      learned: runtime.learned,
      connected: runtime.connectedApps,
      passes: service.passTable(),
      projects: () => runtime.store.list('project'),
    },
    ...runtime.devicesHooks,
    pairedPass: () => runtime.secrets.get(PASS_SECRET),
    imageDir: join(runtime.dataDir, 'attachments', 'from-devices'),
    log: (line) => runtime.logger.info(line),
    // The brains this node paired with, until their device rows replicate here.
    extraPeers: () => readConfig(runtime.dataDir).brains.map((brain) => ({ id: brain.id, name: brain.name, urls: brain.urls, fp: brain.fp })),
  })
  runtime.onStop(async () => {
    detach()
    await service.stop()
  })
  // `agent-node pair` while this node runs: take the brain's bundle (settings, accounts, keys) now.
  runtime.ipcMain.handle(JOIN_CHANNEL, async (_event, url, fp) => {
    if (typeof url !== 'string' || typeof fp !== 'string') throw new Error('Which node to join?')
    return joinNow(runtime.dataDir, url, fp)
  })
  // This node fetches pages for the person's other nodes too (relay.fetch).
  registerRelay(service.host(), {
    store: runtime.store,
    rolesOf: rolesFromStore(runtime.store),
    ...(options.relayLoopback === true ? { allowLoopback: true } : {}),
    log: (message, detail) => runtime.logger.info(message, detail),
  })
  // Events the window would get go to paired devices too (only the ones they may hear).
  runtime.ipc.onEvent((channel, payload) => service.broadcast(channel, payload))
  // Where it listens is set before it starts, so it starts listening once, there.
  await service.configure({ listen: options.listen, port: options.port })
  await service.start()
  if (options.extraUrls !== undefined && options.extraUrls.length > 0) await service.setExtraUrls(options.extraUrls)
  // A headless node exists to be reached: it always listens (on loopback unless told otherwise).
  if (!service.isEnabled()) await service.setEnabled(true)
  // A pairing made while it was stopped: take that brain's bundle now.
  const pending = readConfig(runtime.dataDir).join
  if (pending !== null) await joinNow(runtime.dataDir, pending.url, pending.fp).catch(() => false)
  return service
}

/** The control channel `agent-node pair` uses to hand a fresh pairing to the running node. */
export const JOIN_CHANNEL = 'agent:devices.join'

async function joinNow(dataDir: string, url: string, fp: string): Promise<boolean> {
  const sync = devicesState.sync
  if (sync === null) return false
  const ok = await sync.joinFrom(url, fp)
  if (ok) {
    const config = readConfig(dataDir)
    if (config.join !== null) writeConfig(dataDir, { ...config, join: null })
  }
  return ok
}
