/**
 * Relay: a paired node fetches a web page over its own internet connection for another node (a server whose address
 * a site blocks asks the person's computer). It is the app's own web_fetch on the relaying node, with every check it
 * has (no private networks, no loopback, https only, text only, size-capped), so a relay can never be turned into a
 * way into the relaying device's network. Only paired nodes (brain or hands) may ask; screens may not.
 */
import { coreTools } from '../tools/core'
import type { DataStore } from '../runtime/data'
import type { DeviceRole, DevicesHost } from './types'

export const RELAY_FETCH = 'relay.fetch'

export interface RelayDeps {
  store: DataStore
  /** The caller's roles from its device row, or null when it is not paired (or revoked). */
  rolesOf: (deviceId: string) => Promise<DeviceRole[] | null>
  /** Tests only: let a local fake page be fetched. Never on in the app. */
  allowLoopback?: boolean
  fetchImpl?: typeof fetch
  log?: (message: string, detail?: Record<string, unknown>) => void
}

export function registerRelay(host: DevicesHost, deps: RelayDeps): void {
  const webFetch = coreTools({
    store: deps.store,
    allowLoopback: deps.allowLoopback === true,
    ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
  }).find((tool) => tool.spec.name === 'web_fetch')
  if (webFetch === undefined) return
  host.addRpc(RELAY_FETCH, async (deviceId, args) => {
    const roles = await deps.rolesOf(deviceId)
    if (roles === null || !(roles.includes('brain') || roles.includes('hands'))) throw new Error('Only your own computers and servers may fetch through this one.')
    const request = (typeof args[0] === 'object' && args[0] !== null ? args[0] : {}) as { url?: unknown; maxChars?: unknown }
    const url = typeof request.url === 'string' ? request.url : ''
    const maxChars = typeof request.maxChars === 'number' ? request.maxChars : undefined
    let host = ''
    try {
      host = new URL(url).host
    } catch {
      // web_fetch answers with its own plain words.
    }
    deps.log?.('Relay fetch', { for: deviceId, host })
    const controller = new AbortController()
    return webFetch.run({ url, ...(maxChars === undefined ? {} : { maxChars }) }, {
      signal: controller.signal,
      agentLabel: 'relay',
    } as Parameters<typeof webFetch.run>[1])
  })
}

/** Roles from the store's device rows (both the desktop and the headless node keep them there). */
export function rolesFromStore(store: { get(entity: 'device', id: string): Promise<{ roles: string[]; revoked: boolean } | null> }) {
  return async (deviceId: string): Promise<DeviceRole[] | null> => {
    const row = await store.get('device', deviceId)
    if (row === null || row.revoked) return null
    return row.roles.filter((r): r is DeviceRole => r === 'brain' || r === 'hands' || r === 'screen')
  }
}
