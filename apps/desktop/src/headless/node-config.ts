/**
 * The headless node's own small file in its data dir (node.json): its name, where it listens, and the brains it
 * paired with. Its identity and certificate are the Devices ones (main/devices/identity.ts, in devices/). Secrets (device passes, AI keys) never go here; they live in the secrets store.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import type { BrainRef } from '../main/devices/types'

export const DEFAULT_PORT = 7787
export const DEFAULT_LISTEN = '127.0.0.1'

export interface NodeConfig {
  id: string
  name: string
  /** Empty until the node makes a mesh or pairs into one. */
  meshId: string
  listen: string
  port: number
  /** Extra addresses the person says reach this node (a VPS name, an overlay address), as https URLs. */
  publicUrls: string[]
  /** Brains this node paired with, ranked. Their passes are in the secrets store, keyed by brain id. */
  brains: BrainRef[]
  /** This node's own device id in the mesh it joined ('' if it made the mesh). */
  deviceId: string
  /** socks5://host:port when other devices are only reachable through a proxy (a userspace mesh VPN); '' for none. */
  proxy: string
}

function configFile(dataDir: string): string {
  return join(dataDir, 'node.json')
}

export function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`
}

export function readConfig(dataDir: string): NodeConfig {
  const file = configFile(dataDir)
  let raw: Partial<NodeConfig> = {}
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<NodeConfig>
    } catch {
      raw = {}
    }
  }
  const config: NodeConfig = {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomId('node'),
    name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name : hostname(),
    meshId: typeof raw.meshId === 'string' ? raw.meshId : '',
    listen: typeof raw.listen === 'string' && raw.listen !== '' ? raw.listen : DEFAULT_LISTEN,
    port: typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65536 ? raw.port : DEFAULT_PORT,
    publicUrls: Array.isArray(raw.publicUrls) ? raw.publicUrls.filter((u): u is string => typeof u === 'string') : [],
    brains: Array.isArray(raw.brains) ? raw.brains : [],
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : '',
    proxy: typeof raw.proxy === 'string' ? raw.proxy : '',
  }
  if (!existsSync(file)) writeConfig(dataDir, config)
  return config
}

export function writeConfig(dataDir: string, config: NodeConfig): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = configFile(dataDir)
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}
