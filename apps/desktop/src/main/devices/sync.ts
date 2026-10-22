/**
 * Workstream B plugged into a running node server (docs/devices-protocol.md s6-s8), in one call:
 *
 *   const sync = registerDevicesSync(host, { store, pass, bundle, leases, noteBack })
 *
 * It adds the sync and bundle routes, starts replicating with every other brain or hands device, delivers device
 * commands (and their `device.ack` RPC), and turns on failover for the turn leases. `sync.stop()` when Devices is
 * switched off. Turn leases and crash resume run without it (Devices off); this only adds the parts that need
 * other devices.
 */
import type { DataChange, DeviceRow, Tool, ToolContext } from '@agent/core'

import type { DataStore } from '../runtime/data'
import { rankedBrains, type TurnLeases } from '../runtime/turns'
import { BundleKeeper, pullBundle, registerBundle, type BundleSources } from './bundle'
import { DeviceCommands } from './commands'
import { DeviceToolHub, DeviceToolRunner } from './device-tools'
import { originFromFacts, originLine, latestOrigin } from './origin'
import { pinnedFetch } from './pinned-fetch'
import { Replicator, registerSyncRoutes, type ReplicaStore } from './replicate'
import type { DevicesHost, MessageOrigin } from './types'

export interface DevicesSyncDeps {
  /** The local database (db.ts Store). */
  store: ReplicaStore & DataStore & { onChange(listener: (change: DataChange) => void): () => void }
  /** This node's own pass (from pairing, valid at every brain), or null before it has one. */
  pass: () => string | null
  /** Where the bundle's parts live (settings, secrets, profiles, learned apps, rules, pass table). */
  bundle: Omit<BundleSources, 'local'>
  /** The app's turn leases (runtime/turns.ts), so another brain can take over a turn here, and the other way. */
  leases?: TurnLeases
  /** Tell the agent in a chat (an expired device command). Usually runner.deliver. */
  noteBack: (chat: string, text: string) => void | Promise<void>
  /** This node's own tools other devices may use (s11): the helpers' toolset. Filtered by `shareGroups`. */
  localTools?: () => Tool[]
  /** Settings devicesShareGroups and devicesPreferred. */
  shareGroups?: () => Partial<Record<string, boolean>>
  preferred?: () => Partial<Record<string, string>>
  /** How a tool another brain runs here reaches the person on this node (ask_user, request_approval, notify). */
  context?: (chat: string, signal: AbortSignal) => Partial<ToolContext>
  /** Where pictures from other devices are saved. */
  imageDir?: string
  log?: (line: string) => void
}

export interface DevicesSync {
  replicator: Replicator
  keeper: BundleKeeper
  commands: DeviceCommands
  /** Shared device tools (s11): devices_list, device_tool and the router. */
  tools: DeviceToolHub
  /** This node's device id, as other nodes know it. */
  selfId(): string
  /** The origin for a message typed on this node (runner devices.selfOrigin). */
  selfOrigin(): MessageOrigin
  /** The prompt's device line for a chat (runner devices.originLine). */
  originLine(chat: string): Promise<string>
  /** Right after pairing with a brain: take its bundle as ours (the mesh wins over a fresh install). */
  joinFrom(url: string, fp: string): Promise<boolean>
  stop(): void
}

const HEALTH_TIMEOUT_MS = 3_000

/**
 * The running DevicesSync, for the parts of the app that ask "is Devices on?" (index.ts: the runner's origin and
 * device line, the open_url / send_file tools, turn lease ids). The node server sets it when Devices is switched on
 * (`devicesState.sync = registerDevicesSync(host, deps)`) and back to null when it is switched off.
 */
export const devicesState: { sync: DevicesSync | null } = { sync: null }

export function registerDevicesSync(host: DevicesHost, deps: DevicesSyncDeps): DevicesSync {
  const store = deps.store
  const keeper = new BundleKeeper({ ...deps.bundle, local: store })
  keeper.watch()
  registerSyncRoutes(host, store, () => keeper.version())
  const offBundle = registerBundle(host, { keeper, devices: () => store.list('device') })

  const replicator = new Replicator({
    store,
    selfId: () => host.self().id,
    pass: deps.pass,
    onBundleVersion: (peer, _version, url) => {
      const pass = deps.pass()
      if (pass === null) return
      void pullBundle(keeper, url, pass, pinnedFetch(peer.fp, 15_000)).catch(() => false)
    },
    ...(deps.log === undefined ? {} : { log: deps.log }),
  })
  replicator.start()

  const commands = new DeviceCommands({ store, selfId: () => host.self().id, noteBack: deps.noteBack })
  commands.attach(host)

  const local = deps.localTools ?? (() => [])
  const tools = new DeviceToolHub({
    store,
    selfId: () => host.self().id,
    localTools: local,
    noteBack: deps.noteBack,
    ...(deps.shareGroups === undefined ? {} : { shareGroups: deps.shareGroups }),
    ...(deps.preferred === undefined ? {} : { preferred: deps.preferred }),
    ...(deps.imageDir === undefined ? {} : { imageDir: deps.imageDir }),
    // Another node counts as online while its replication link is up.
    reachable: (id) => replicator.status().some((link) => link.peer === id && link.ok),
  })
  tools.attach(host)
  const runner = new DeviceToolRunner({
    store,
    selfId: () => host.self().id,
    tools: local,
    ...(deps.shareGroups === undefined ? {} : { shareGroups: deps.shareGroups }),
    ...(deps.context === undefined ? {} : { context: deps.context }),
  })
  runner.start()

  deps.leases?.setFailover({
    health: probeHealth,
    brains: () => rankedBrains(store),
    // Before resuming our own leases, catch up once, so a turn a peer took while we were down is seen as theirs.
    ready: () => withTimeout(replicator.syncOnce(), 10_000),
  })
  deps.leases?.watch()

  return {
    replicator,
    keeper,
    commands,
    tools,
    selfId: () => host.self().id,
    selfOrigin: () => originFromFacts(host.self().id, host.self().facts),
    originLine: async (chat) => originLine(await latestOrigin(store, chat), host.self().id),
    joinFrom: async (url, fp) => {
      const pass = deps.pass()
      if (pass === null) return false
      return pullBundle(keeper, url, pass, pinnedFetch(fp, 15_000), true)
    },
    stop: () => {
      replicator.stop()
      commands.stop()
      tools.stop()
      runner.stop()
      offBundle()
      keeper.dispose()
      deps.leases?.setFailover(null)
    },
  }
}

/** GET /v1/health on the first address that answers, pinned to the device's certificate. */
export async function probeHealth(row: DeviceRow): Promise<{ up: boolean; ready: boolean }> {
  for (const url of row.urls) {
    try {
      const res = await pinnedFetch(row.fp, HEALTH_TIMEOUT_MS)(`${url.replace(/\/+$/, '')}/v1/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      if (!res.ok) continue
      const json = (await res.json()) as Record<string, unknown>
      return { up: true, ready: json['ready'] === true }
    } catch {
      // Try the next address.
    }
  }
  return { up: false, ready: false }
}

function withTimeout(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    void work.finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
