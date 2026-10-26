/**
 * The app contract over the wire (protocol s5.1): each `AgentApi` method by its dotted name, the IPC channel that
 * serves it, and the ALLOWLIST of what another device may call. Shared by the node (main/devices/rpc.ts) and the
 * remote bridge (renderer/bridge/remote.ts), so the two cannot drift apart.
 */
import { CHANNELS, EVENTS } from './channels'
import { DEVICES_CHANNELS, DEVICES_EVENTS } from './devices-channels'
import { MEMORY_CHANNELS, MEMORY_EVENTS } from './memory-channels'
import { MEMORY_HISTORY_CHANNELS } from './memory-history-channels'
import { VAULT_CHANNELS, VAULT_EVENTS } from './vault-channels'

type Tree = { readonly [key: string]: string | Tree }

function flatten(tree: Tree, prefix: string, out: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const name = prefix === '' ? key : `${prefix}.${key}`
    if (typeof value === 'string') out[name] = value
    else flatten(value, name, out)
  }
  return out
}

/** Dotted method name to IPC channel, for every method the main process serves. */
export const RPC_CHANNELS: Readonly<Record<string, string>> = flatten(
  { ...CHANNELS, memory: { ...MEMORY_CHANNELS, ...MEMORY_HISTORY_CHANNELS }, devices: DEVICES_CHANNELS, vault: VAULT_CHANNELS },
  '',
  {},
)

/**
 * What a paired device may call: everything a person uses day to day. Never: secrets, keys and sign-ins, window
 * controls, shortcuts, dictation hardware, file and folder pickers, opening things on this computer, and changes
 * to this computer's settings (including whether the agent may run commands).
 */
export const RPC_ALLOWED: ReadonlySet<string> = new Set([
  'settings.get',
  'settings.providers',
  'settings.accounts.chatBrain',
  'account.status',
  'account.syncNow',
  'data.list',
  'data.get',
  'data.upsert',
  'data.remove',
  'chat.send',
  'chat.stop',
  'chat.state',
  'chat.states',
  'chat.branch',
  'chat.answer',
  'chat.decide',
  'chat.tap',
  'routines.runNow',
  'browser.state',
  'browser.people',
  'helpers.stop',
  'helpers.stopAll',
  'helpers.cards',
  'apps.status',
  'apps.catalog',
  'apps.search',
  'apps.learned',
  'profiles.list',
  'files.savePasted',
  'system.info',
  'environment.scan',
  'voice.check',
  'voice.transcribe',
  'voice.speak',
  'voice.noteAudio',
  'voice.liveToken',
  'voice.callSave',
  'voice.callTargets',
  'voice.callHandoff',
  // A linked device's message box mic writes its recording here as it happens (never lost).
  'voice.recordStart',
  'voice.recordChunk',
  'voice.recordEnd',
  'app.info',
  'memory.newChat',
  'memory.retrySave',
  'memory.searchChats',
  'memory.upkeep',
  'memory.undoChange',
  'memory.tidyState',
  'memory.history',
  'memory.restoreVersion',
  'devices.status',
  'devices.list',
  // The Vault: names only. Values never go to another device (show and copy are this window's own clicks).
  'vault.list',
  'vault.prefs',
])

/** Main-process events a paired device hears (the rest are about this computer's own window and hardware). */
export const RPC_EVENTS: ReadonlySet<string> = new Set([
  EVENTS.settings,
  EVENTS.accountStatus,
  EVENTS.accountProgress,
  EVENTS.data,
  EVENTS.chat,
  EVENTS.browser,
  EVENTS.apps,
  EVENTS.profiles,
  EVENTS.helperCards,
  MEMORY_EVENTS.upkeep,
  MEMORY_EVENTS.tidy,
  DEVICES_EVENTS.changed,
  VAULT_EVENTS.changed,
])

export const NOT_AVAILABLE = 'not available on this device'

/**
 * Bytes cannot ride in JSON: a Uint8Array travels as { $b64: "..." } both ways. Everything else is plain JSON.
 * Works in the browser and in Node (no Buffer needed).
 */
export function encodeWire(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $b64: bytesToBase64(value) }
  if (Array.isArray(value)) return value.map(encodeWire)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = encodeWire(item)
    return out
  }
  return value
}

export function decodeWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeWire)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
    if (keys.length === 1 && keys[0] === '$b64' && typeof record['$b64'] === 'string') return base64ToBytes(record['$b64'])
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) out[key] = decodeWire(item)
    return out
  }
  return value
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(binary)
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}
