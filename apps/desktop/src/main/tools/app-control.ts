/**
 * The app's own controls as agent tools: anything the person can do by clicking in Settings, the agent can do with a
 * tool (rule of 22 Oct 2026). Devices (Settings > Devices: switch on, add a device, join another node's link, take a
 * device out, roles, order, what other devices may use, the firewall), the plain settings Settings writes, and
 * installing an update of this app.
 *
 * What still needs the person: keys and other secrets are never read or written here (they stay in Settings), and
 * settings that change what the agent may do or what it runs on ask first (request_approval through ctx.approve).
 */
import {
  DEFAULT_SETTINGS,
  bool,
  int,
  schema,
  str,
  strList,
  type DeviceRow,
  type DevicesStatus,
  type JsonObject,
  type PairingOfferInfo,
  type Settings,
  type Tool,
} from '@agent/core'

import type { DeviceJoinResult } from '../devices/service'
import type { AppActionInvoker } from './app-actions'

/** What these tools use of DevicesService (main/devices/service.ts). */
export interface DevicesControl {
  status(): DevicesStatus
  isEnabled(): boolean
  setEnabled(on: boolean): Promise<DevicesStatus>
  offer(): PairingOfferInfo
  cancelOffer(): void
  join(link: string, options?: { takeBundle?: boolean }): Promise<DeviceJoinResult>
  list(): DeviceRow[]
  setRoles(id: string, roles: unknown): Promise<void>
  setPosition(id: string, index: number): Promise<void>
  revoke(id: string): Promise<void>
  forget(id: string): Promise<void>
  clearRevoked(): Promise<string[]>
  setShareGroup(group: string, on: boolean): Promise<DevicesStatus>
  allowFirewall(): Promise<DevicesStatus>
  setExtraUrls(urls: string[]): Promise<DevicesStatus>
}

export interface SettingsControl {
  get(): Settings
  save(patch: Partial<Settings>): Settings
}

/** Installs an update of this app (main/self-update.ts). */
export interface UpdateControl {
  currentVersion(): string
  /** Checks the installer and schedules the install and restart for when this turn has ended. */
  install(path: string, chat: string): Promise<{ ok: boolean; text: string; from?: string; to?: string }>
}

export interface AppControlDeps {
  /** The node, or null where there is none yet. */
  devices?: () => DevicesControl | null
  /** The replication links to other brains, to see that a link really works. */
  links?: () => Array<{ peer: string; ok: boolean; error: string | null; lastAt: number | null }>
  settings?: SettingsControl
  /** Main agent only: installing an update ends the app. */
  update?: UpdateControl
  /** The window's own IPC handlers, for app_action (tools/app-actions.ts). */
  invoker?: () => AppActionInvoker | null
}

const SHARE_GROUPS = ['browser', 'files', 'notifications', 'approval', 'shell'] as const
const ROLES = ['brain', 'hands', 'screen'] as const

/** Settings that only describe state (a key is saved, signed in): never set by hand. */
// Most wake-up settings too (only he changes them, in Settings > Wake-ups). An agent may set wakeupsRingHere and
// wakeupsPauseHereUntil ("he is going home, keep this PC quiet"): they only decide whether a new ring starts here. A wake
// already ringing rings on until he answers (shared/wakeups.ts decideHere), so no agent can silence one.
export const SETTINGS_READ_ONLY: ReadonlySet<string> = new Set([
  'hasKey',
  'hasVoiceKey',
  'signedIn',
  'syncEmail',
  'onboarded',
  'wakeupSnoozeMinutes',
  'wakeupQuietHours',
  'wakeupVolume',
  'wakeupsPhoneOnlyWhenIdle',
  'wakeupsIdleMinutes',
])

/**
 * Settings that change what the agent may do on this computer, what it thinks with, or where data goes: changed only
 * after the person says yes (the card shows the exact change).
 */
export const SETTINGS_NEED_APPROVAL: ReadonlySet<string> = new Set([
  'shell',
  'grantedFolders',
  'allowHttp',
  'baseUrl',
  'syncUrl',
  'mode',
  'cli',
  'cliModel',
  'provider',
  'model',
  'accounts',
  'ai',
])

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function off(): string {
  return 'There is no Devices node in this app right now.'
}

/** The device meant by `ref`: its id, the start of its id, or its name (any case). */
export function findDevice(rows: DeviceRow[], ref: string): { row: DeviceRow } | { error: string } {
  const wanted = ref.trim()
  if (wanted === '') return { error: 'Say which device (its name or id, see devices_status).' }
  const byId = rows.find((row) => row.id === wanted)
  if (byId !== undefined) return { row: byId }
  const lower = wanted.toLowerCase()
  const matches = rows.filter((row) => row.id.toLowerCase().startsWith(lower) || row.name.toLowerCase() === lower)
  const live = matches.filter((row) => !row.revoked)
  const pick = live.length === 1 ? live : matches
  if (pick.length === 1 && pick[0] !== undefined) return { row: pick[0] }
  if (pick.length > 1) return { error: `"${wanted}" could be ${pick.map((row) => `${row.name} (${row.id})`).join(' or ')}. Use the id.` }
  const loose = rows.filter((row) => row.name.toLowerCase().includes(lower))
  if (loose.length === 1 && loose[0] !== undefined) return { row: loose[0] }
  return { error: `No device "${wanted}". Devices: ${rows.map((row) => `${row.name} (${row.id})`).join(', ') || 'none'}.` }
}

function describeRow(row: DeviceRow, status: DevicesStatus, brains: DeviceRow[], links: Map<string, { ok: boolean; error: string | null }>): string {
  const bits: string[] = [row.kind, row.platform]
  if (row.id === status.nodeId) bits.push('this computer')
  if (row.revoked) bits.push('TAKEN OUT')
  else {
    bits.push(`roles ${row.roles.join('+')}`)
    const place = brains.findIndex((brain) => brain.id === row.id)
    if (place >= 0) bits.push(`answers ${place + 1} of ${brains.length}`)
    if (row.id !== status.nodeId) {
      const link = links.get(row.id)
      bits.push(status.connected.includes(row.id) ? 'connected now' : link?.ok === true ? 'replicating' : link !== undefined ? `link failing${link.error === null ? '' : `: ${link.error}`}` : 'not connected')
    }
    const version = (row.facts as { appVersion?: unknown } | undefined)?.appVersion
    if (typeof version === 'string' && version !== '') bits.push(`app ${version}`)
  }
  return `- ${row.name} (id ${row.id}): ${bits.join(', ')}`
}

function statusText(devices: DevicesControl, deps: AppControlDeps): string {
  const status = devices.status()
  const rows = devices.list()
  const brains = rows.filter((row) => row.roles.includes('brain') && !row.revoked)
  const links = new Map((deps.links?.() ?? []).map((link) => [link.peer, link]))
  const lines = [
    `Devices: ${status.enabled ? (status.running ? `on, listening on port ${status.port}` : `on but not listening${status.error === '' ? '' : `: ${status.error}`}`) : 'off'}.`,
  ]
  if (status.nodeId !== '') lines.push(`This computer: ${status.nodeName} (id ${status.nodeId}), certificate ${status.fpWords}.`)
  if (status.urls.length > 0) lines.push(`Reachable at: ${status.urls.join(', ')}${status.extraUrls.length > 0 ? ` (added by hand: ${status.extraUrls.join(', ')})` : ''}.`)
  if (status.firewall !== 'not-needed') lines.push(`Windows Firewall: ${status.firewall}${status.firewall === 'blocked' || status.firewall === 'missing' ? ' (devices_firewall_allow fixes it, one Windows prompt)' : ''}.`)
  if (status.network !== undefined && status.network.mode !== 'none') lines.push(`Network: ${status.network.mode}, ${status.network.state}${status.network.addresses.length > 0 ? ` (${status.network.addresses.join(', ')})` : ''}.`)
  lines.push(`Other devices may use here: ${SHARE_GROUPS.map((group) => `${group} ${status.shareGroups[group] ? 'on' : 'off'}`).join(', ')}.`)
  if (status.servingTo !== '') lines.push(`Lending its tools to: ${rows.find((row) => row.id === status.servingTo)?.name ?? status.servingTo}.`)
  const revoked = rows.filter((row) => row.revoked).length
  lines.push(rows.length === 0 ? 'No devices yet.' : `Devices (${rows.length - revoked} in${revoked > 0 ? `, ${revoked} taken out: device_remove with clear_revoked clears them` : ''}):`)
  for (const row of rows) lines.push(describeRow(row, status, brains, links))
  return lines.join('\n')
}

function devicesStatusTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'devices_status',
      description:
        "Settings > Devices as text: whether Devices is on, this computer's id and addresses, the firewall, every linked device (roles, its place in the answer order, connected or replicating now, app version) and which of this computer's tool groups other devices may use. Use it to check a link worked on this side.",
      schema: schema([], {}),
    },
    run: async () => {
      const devices = deps.devices?.() ?? null
      return devices === null ? off() : statusText(devices, deps)
    },
  }
}

function devicesSwitchTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'devices_switch',
      description: 'Switch Devices on or off on this computer (Settings > Devices > "Let my other devices connect"). Off: no other device can reach it.',
      schema: schema(['on'], { on: bool('true to switch on, false to switch off') }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      const status = await devices.setEnabled(input['on'] === true)
      if (input['on'] === true && !status.running) return `Switched on, but it is not listening: ${status.error || 'the server did not start'}.`
      return input['on'] === true ? `Devices is on, listening on port ${status.port}.` : 'Devices is off. No other device can reach this computer.'
    },
  }
}

function pairOfferTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'device_pair_offer',
      description:
        'Make a pairing link (Settings > Devices > Add a device): an agent://pair link and a short code, good for 10 minutes and one use. Another device joins with it: the phone app scans or pastes it, another Agent app uses device_join (or Settings > Devices > Join with a link), a server running agent-node runs `agent-node pair \'<link>\'`. Switches Devices on first when it is off. cancel: true stops the current offer instead.',
      schema: schema([], { cancel: bool('Stop the current offer instead of making one') }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      if (input['cancel'] === true) {
        devices.cancelOffer()
        return 'The pairing offer is cancelled.'
      }
      let status = devices.status()
      const switched = !status.enabled
      if (switched) status = await devices.setEnabled(true)
      if (!status.running) return `Devices could not start listening: ${status.error || 'the server did not start'}. Nothing can pair until it does.`
      const offer = devices.offer()
      const until = new Date(offer.expiresAt)
      const hhmm = `${String(until.getHours()).padStart(2, '0')}:${String(until.getMinutes()).padStart(2, '0')}`
      return [
        switched ? 'Devices was off; it is on now.' : '',
        `Pairing link (one use, until ${hhmm}): ${offer.uri}`,
        `Short code: ${offer.shortCode}`,
        `Addresses in the link: ${offer.urls.join(', ') || 'none (add one with devices_addresses)'}`,
        `This computer's certificate: ${status.fpWords}`,
        status.firewall === 'blocked' || status.firewall === 'missing' ? 'Windows Firewall may keep other devices out: run devices_firewall_allow (one Windows prompt) if the other device cannot reach it.' : '',
      ]
        .filter((line) => line !== '')
        .join('\n')
    },
  }
}

function joinTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'device_join',
      description:
        "Join this computer to the person's devices from a pairing link another node made (agent://pair?..., from that node's Add a device or `agent-node offer`). This computer keeps its own id, settings and chats, and from then on replicates with that node. take_settings: also take that node's settings, accounts and keys now (only for a fresh install). Switches Devices on when it is off.",
      schema: schema(['link'], { link: str('The agent://pair?... link'), take_settings: bool("Also take that node's settings, accounts and keys now (fresh install only)") }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      const link = text(input['link'])
      if (!link.startsWith('agent://pair?')) return 'Give the whole pairing link; it starts with agent://pair?'
      try {
        const done = await devices.join(link, { takeBundle: input['take_settings'] === true })
        return [
          `Joined ${done.node.name || done.node.id} (id ${done.node.id}) at ${done.url}. This computer is ${done.deviceId} there.`,
          `Replicating with: ${done.brains.map((brain) => brain.name || brain.id).join(', ')}.`,
          done.tookBundle ? "Took that node's settings, accounts and keys." : '',
          'Check with devices_status in a few seconds: the other node should show as replicating.',
        ]
          .filter((line) => line !== '')
          .join('\n')
      } catch (error) {
        return `Could not join: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

function removeTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'device_remove',
      description:
        "Take a device out (Settings > Devices > Take out): its pass stops working at once and its connections close. Its row is deleted too, so it leaves every list (keep_row: true leaves it listed as taken out). clear_revoked: true deletes every device already taken out instead (leftover rows), no device needed. This computer cannot take itself out.",
      schema: schema([], {
        device: str('Name or id (or the start of the id) of the device'),
        keep_row: bool('Leave the row listed as taken out'),
        clear_revoked: bool('Delete every row of a device already taken out'),
      }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      if (input['clear_revoked'] === true) {
        const gone = await devices.clearRevoked()
        return gone.length === 0 ? 'There were no taken-out devices to clear.' : `Cleared ${gone.length} taken-out device${gone.length === 1 ? '' : 's'}: ${gone.join(', ')}.`
      }
      const found = findDevice(devices.list(), text(input['device']))
      if ('error' in found) return found.error
      const row = found.row
      try {
        if (input['keep_row'] === true) {
          if (row.revoked) return `${row.name} is already taken out.`
          await devices.revoke(row.id)
          return `${row.name} (${row.id}) is taken out: its pass no longer works.`
        }
        await devices.forget(row.id)
        return `${row.name} (${row.id}) is ${row.revoked ? 'cleared from the list' : 'taken out and cleared from the list'}.`
      } catch (error) {
        return `Could not: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

function rolesTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'device_roles',
      description:
        'Set what a linked device does (Settings > Devices > its roles): brain (it can answer, runs the agent), hands (its tools can be used), screen (a window onto the agent). At least one. This computer is always brain and hands.',
      schema: schema(['device', 'roles'], { device: str('Name or id of the device'), roles: strList('Any of brain, hands, screen') }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      const found = findDevice(devices.list(), text(input['device']))
      if ('error' in found) return found.error
      const roles = (Array.isArray(input['roles']) ? input['roles'] : []).map((role) => String(role).trim().toLowerCase()).filter((role) => (ROLES as readonly string[]).includes(role))
      if (roles.length === 0) return 'Give at least one role: brain, hands or screen.'
      try {
        await devices.setRoles(found.row.id, roles)
        return `${found.row.name} is now ${roles.join(' + ')}.`
      } catch (error) {
        return `Could not: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

function orderTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'device_order',
      description:
        'Put a device that answers (a brain) at a place in the order devices try them in (Settings > Devices > up and down arrows). position 1 = asked first. Use devices_status to see the order.',
      schema: schema(['device', 'position'], { device: str('Name or id of the device'), position: int('1 = first') }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      const found = findDevice(devices.list(), text(input['device']))
      if ('error' in found) return found.error
      const position = typeof input['position'] === 'number' ? Math.floor(input['position']) : Number.NaN
      if (!Number.isFinite(position) || position < 1) return 'position is 1 or more (1 = first).'
      try {
        await devices.setPosition(found.row.id, position - 1)
      } catch (error) {
        return `Could not: ${error instanceof Error ? error.message : String(error)}`
      }
      const order = devices.list().filter((row) => row.roles.includes('brain') && !row.revoked).sort((a, b) => a.priority - b.priority)
      return `Answer order now: ${order.map((row, i) => `${i + 1}. ${row.name}`).join(', ')}.`
    },
  }
}

function shareTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'device_share',
      description:
        "Let other linked devices use one group of this computer's tools, or not (Settings > Devices > What your other devices may use here): browser, files, notifications, approval, shell.",
      schema: schema(['group', 'on'], { group: str('browser, files, notifications, approval or shell'), on: bool('true to allow, false to stop') }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      const group = text(input['group']).toLowerCase()
      if (!(SHARE_GROUPS as readonly string[]).includes(group)) return `Unknown group "${group}". Use one of: ${SHARE_GROUPS.join(', ')}.`
      const status = await devices.setShareGroup(group, input['on'] === true)
      return `Other devices ${status.shareGroups[group as (typeof SHARE_GROUPS)[number]] ? 'may' : 'may not'} use ${group} on this computer now.`
    },
  }
}

function firewallTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'devices_firewall_allow',
      description:
        'Windows only: let other devices through Windows Firewall to this computer (Settings > Devices > Allow connections). Raises ONE Windows (UAC) prompt the person must accept on this computer; tell them before you run it.',
      schema: schema([], {}),
    },
    run: async () => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      const before = devices.status()
      if (before.firewall === 'not-needed') return before.enabled ? 'No firewall step is needed on this computer.' : 'Devices is off; switch it on first (devices_switch).'
      if (before.firewall === 'allowed') return 'Windows Firewall already lets other devices in.'
      try {
        const after = await devices.allowFirewall()
        return after.firewall === 'allowed'
          ? 'Windows Firewall now lets other devices in (the person accepted the Windows prompt).'
          : `Windows did not let it through (firewall: ${after.firewall}). The person may have said No to the Windows prompt; run it again and ask them to choose Yes.`
      } catch (error) {
        return `Could not: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  }
}

function addressesTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'devices_addresses',
      description:
        'Set the extra addresses that reach this computer (Settings > Devices > addresses: a VPN address or a public name), which go first in every pairing link. Replaces the list; an empty list clears it.',
      schema: schema(['addresses'], { addresses: strList('host, host:port or https://host:port') }),
    },
    run: async (input) => {
      const devices = deps.devices?.() ?? null
      if (devices === null) return off()
      const list = (Array.isArray(input['addresses']) ? input['addresses'] : []).map((item) => String(item)).slice(0, 12)
      const status = await devices.setExtraUrls(list)
      return status.extraUrls.length === 0 ? 'No extra addresses.' : `Extra addresses: ${status.extraUrls.join(', ')}.`
    },
  }
}

// ---- settings ----------------------------------------------------------------------------------------------------

function settingsGetTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'settings_get',
      description:
        "Read this app's settings (what Settings shows and writes): names, theme, hotkeys, notifications, voice, the daily memory time, launch at login, device name, AI accounts and picks, and so on. Keys and passwords are never here. Each key says whether settings_set can change it freely, needs the person's yes, or is read-only.",
      schema: schema([], { key: str('Only this key') }),
    },
    run: async (input) => {
      if (deps.settings === undefined) return 'Settings are not available here.'
      const current = deps.settings.get() as unknown as Record<string, unknown>
      const only = text(input['key'])
      const keys = only === '' ? Object.keys(DEFAULT_SETTINGS) : [only]
      if (only !== '' && !(only in DEFAULT_SETTINGS)) return `No setting "${only}". Settings: ${Object.keys(DEFAULT_SETTINGS).join(', ')}.`
      return keys
        .map((key) => {
          const how = SETTINGS_READ_ONLY.has(key) ? 'read-only' : SETTINGS_NEED_APPROVAL.has(key) ? 'needs his yes' : 'free'
          return `${key} [${how}]: ${JSON.stringify(current[key])}`
        })
        .join('\n')
    },
  }
}

function sameShape(value: unknown, like: unknown): boolean {
  if (like === null) return value === null || typeof value === 'string'
  if (Array.isArray(like)) return Array.isArray(value)
  if (typeof like === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value)
  return typeof value === typeof like
}

function settingsSetTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'settings_set',
      description:
        "Change this app's settings, the same as Settings does (it takes effect at once: hotkeys, theme, launch at login...). values: { key: newValue } using the keys from settings_get. Keys marked 'needs his yes' (what the agent may run, which folders, which AI it thinks with, where data syncs) show the person an approval card with the exact change first. API keys, passwords and other secrets cannot be set here: they stay in Settings, for the person.",
      schema: schema(['values'], { values: { type: 'object', description: '{ key: value } to change' } }),
    },
    run: async (input, ctx) => {
      if (deps.settings === undefined) return 'Settings are not available here.'
      const raw = input['values']
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'values must be an object like { "theme": "dark" }.'
      const patch: Record<string, unknown> = {}
      const refused: string[] = []
      const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(raw as JsonObject)) {
        if (/key|secret|token|password|pass$/i.test(key) && !(key in defaults)) refused.push(`${key} (a secret: only the person sets it, in Settings)`)
        else if (!(key in defaults)) refused.push(`${key} (no such setting)`)
        else if (SETTINGS_READ_ONLY.has(key)) refused.push(`${key} (read-only: it shows state)`)
        else if (!sameShape(value, defaults[key])) refused.push(`${key} (expects ${Array.isArray(defaults[key]) ? 'a list' : defaults[key] === null ? 'text' : typeof defaults[key]})`)
        else patch[key] = value
      }
      const keys = Object.keys(patch)
      if (keys.length === 0) return `Nothing changed. ${refused.length > 0 ? `Refused: ${refused.join('; ')}.` : ''}`.trim()
      const guarded = keys.filter((key) => SETTINGS_NEED_APPROVAL.has(key))
      if (guarded.length > 0) {
        const current = deps.settings.get() as unknown as Record<string, unknown>
        const details = guarded.map((key) => `${key}: ${JSON.stringify(current[key])} -> ${JSON.stringify(patch[key])}`).join('\n')
        const yes = await ctx.approve(`Change ${guarded.join(', ')} in Settings`, details)
        if (!yes) {
          for (const key of guarded) delete patch[key]
          refused.push(...guarded.map((key) => `${key} (the person said no)`))
          if (Object.keys(patch).length === 0) return `Nothing changed. Refused: ${refused.join('; ')}.`
        }
      }
      const before = deps.settings.get() as unknown as Record<string, unknown>
      const after = deps.settings.save(patch as Partial<Settings>) as unknown as Record<string, unknown>
      const changed = Object.keys(patch).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      const ignored = Object.keys(patch).filter((key) => !changed.includes(key) && JSON.stringify(after[key]) !== JSON.stringify(patch[key]))
      const lines = [
        changed.length > 0 ? `Changed: ${changed.map((key) => `${key} = ${JSON.stringify(after[key])}`).join(', ')}.` : 'No value changed (they were already set).',
        ignored.length > 0 ? `Not taken (not a valid value): ${ignored.join(', ')}.` : '',
        refused.length > 0 ? `Refused: ${refused.join('; ')}.` : '',
      ]
      return lines.filter((line) => line !== '').join('\n')
    },
  }
}

// ---- self update -------------------------------------------------------------------------------------------------

function updateTool(deps: AppControlDeps): Tool {
  return {
    spec: {
      name: 'app_update',
      description:
        "Install a newer version of this app from its installer file (for example C:\\Users\\me\\Downloads\\Agent-1.2.3-setup.exe) without any clicks: once this turn has ended the app closes, installs silently in the same place and opens again, and you get a note in this chat saying the update finished (version before and after) or, if it failed, the real reason (installer exit code, a file in use and which process held it, the log path) so you carry on and can tell the person exactly what happened. Tell the person in your reply that the app will restart for the update (a short notice, not a question). Nothing in the chat is lost.",
      schema: schema(['installer'], { installer: str("Full path of this app's setup .exe") }),
    },
    run: async (input, ctx) => {
      if (deps.update === undefined) return 'This app cannot update itself here.'
      const path = text(input['installer'])
      if (path === '') return 'Give the full path of the installer (.exe).'
      const result = await deps.update.install(path, ctx.chat ?? 'main')
      if (result.ok) await ctx.notify('Updating the app', `Restarting into ${result.to ?? 'the new version'} when this reply is done.`).catch(() => undefined)
      return result.text
    },
  }
}

/** Devices and settings tools (main agent and helpers). */
export function appControlTools(deps: AppControlDeps): Tool[] {
  const tools: Tool[] = []
  if (deps.devices !== undefined) {
    tools.push(
      devicesStatusTool(deps),
      devicesSwitchTool(deps),
      pairOfferTool(deps),
      joinTool(deps),
      removeTool(deps),
      rolesTool(deps),
      orderTool(deps),
      shareTool(deps),
      firewallTool(deps),
      addressesTool(deps),
    )
  }
  if (deps.settings !== undefined) tools.push(settingsGetTool(deps), settingsSetTool(deps))
  return tools
}

/** The main agent's only: installing an update ends the app (helpers stop with it and resume after). */
export function appUpdateTools(deps: AppControlDeps): Tool[] {
  return deps.update === undefined ? [] : [updateTool(deps)]
}
