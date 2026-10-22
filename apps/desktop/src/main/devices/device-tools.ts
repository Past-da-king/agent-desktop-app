/**
 * Shared device tools (docs/devices-protocol.md s11), the brain side.
 *
 * Every device advertises the tools it lets others use (`DeviceFacts.tools` in its hello; a node lists its own). The
 * hub keeps them on the device rows, finds a device for a tool (named, forgiving, or "best"), and calls it:
 *  - a device connected over RPC (a phone) gets the event `device.command` { id, kind: 'tool', tool, args, chatId,
 *    deadlineMs } and answers with the RPC `device.result(id, ok, value | error)`;
 *  - another node gets the same command as a synced `device_command` row; its DeviceToolRunner runs it and writes the
 *    result into the row, which replicates back;
 *  - an offline device's command waits in the row (delivered when it connects, expires after 10 minutes).
 * The agent waits up to the deadline (120 s, browser 600 s). A result that comes later is posted to the chat.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAIN_CHAT,
  findMatches,
  pickMatch,
  schema,
  str,
  type DataChange,
  type DeviceCommandRow,
  type DeviceRow,
  type JsonObject,
  type Tool,
  type ToolContext,
} from '@agent/core'

import type { DataStore } from '../runtime/data'
import { latestOrigin } from './origin'
import type { DeviceTool, DeviceToolGroup, DevicesHost } from './types'

export const TOOL_GROUPS: readonly DeviceToolGroup[] = ['browser', 'notifications', 'files', 'shell', 'approval', 'phone', 'other']

/** What a device lets others use unless the person says otherwise: everything but its shell (and odds and ends). */
export const DEFAULT_SHARE: Readonly<Record<DeviceToolGroup, boolean>> = {
  browser: true,
  notifications: true,
  files: true,
  approval: true,
  phone: true,
  shell: false,
  other: false,
}

export const DEFAULT_DEADLINE_MS = 120_000
export const BROWSER_DEADLINE_MS = 600_000
const QUEUE_TTL_MS = 10 * 60_000
const MAX_RESULT_CHARS = 1_500_000
const MAX_TEXT_TO_AGENT = 12_000
/** Work that is slow or heavy on a phone: a phone is the last choice for it. */
const HEAVY: ReadonlySet<DeviceToolGroup> = new Set(['browser', 'shell', 'files'])

/** Which group a tool of this app belongs to, by name, for a node's own catalogue. */
export function groupOf(name: string): DeviceToolGroup {
  if (name.startsWith('browser_')) return 'browser'
  if (name === 'notify_user' || name.startsWith('notification')) return 'notifications'
  if (name === 'send_file' || name === 'open_url' || name.startsWith('files_') || name.startsWith('file_')) return 'files'
  if (name === 'shell_run' || name === 'run_code') return 'shell'
  if (name === 'ask_user' || name === 'request_approval') return 'approval'
  return 'other'
}

export function shareOf(groups: Partial<Record<string, boolean>> | undefined): Record<DeviceToolGroup, boolean> {
  const out = { ...DEFAULT_SHARE }
  for (const group of TOOL_GROUPS) {
    const value = groups?.[group]
    if (typeof value === 'boolean') out[group] = value
  }
  return out
}

/** This node's own catalogue: its local tools in the groups it shares (names unchanged). */
export function catalogueOf(tools: Tool[], shared: Record<DeviceToolGroup, boolean>, only?: ReadonlySet<string>): DeviceTool[] {
  return tools
    .filter((tool) => (only === undefined || only.has(tool.spec.name)) && shared[groupOf(tool.spec.name)])
    .filter((tool) => groupOf(tool.spec.name) !== 'other')
    .map((tool) => ({
      name: tool.spec.name,
      description: tool.spec.description.slice(0, 600),
      params: tool.spec.schema as Record<string, unknown>,
      group: groupOf(tool.spec.name),
      readOnly: /^(browser_(look|read|snapshot|inspect|console|network)|files_(list|read|find))/.test(tool.spec.name),
    }))
}

/** A tool list as a device sent it, cleaned; anything malformed is dropped. */
export function cleanTools(value: unknown): DeviceTool[] {
  if (!Array.isArray(value)) return []
  const out: DeviceTool[] = []
  const seen = new Set<string>()
  for (const raw of value.slice(0, 200)) {
    if (typeof raw !== 'object' || raw === null) continue
    const o = raw as Record<string, unknown>
    const name = typeof o['name'] === 'string' ? o['name'].trim().slice(0, 64) : ''
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || seen.has(name)) continue
    seen.add(name)
    const group = TOOL_GROUPS.includes(o['group'] as DeviceToolGroup) ? (o['group'] as DeviceToolGroup) : 'other'
    const params = typeof o['params'] === 'object' && o['params'] !== null && !Array.isArray(o['params']) ? (o['params'] as Record<string, unknown>) : { type: 'object', properties: {} }
    out.push({ name, description: typeof o['description'] === 'string' ? o['description'].slice(0, 600) : '', params, group, readOnly: o['readOnly'] === true })
  }
  return out
}

/** Other names a device may give the same tool (a phone's own names). */
const ALIASES: Record<string, string[]> = {
  notify_user: ['notify', 'notification_post', 'notifications_post', 'notify_post'],
  send_file: ['file_send', 'files_receive', 'file_receive'],
  open_url: ['url_open', 'link_open'],
}

/** One name for every spelling of a tool: the key whose aliases include it, else the name itself. */
export function canonTool(name: string): string {
  if (name in ALIASES) return name
  for (const [key, others] of Object.entries(ALIASES)) if (others.includes(name)) return key
  return name
}

/** Does a device tool called `name` do what was asked for as `tool`? Either side may use any spelling. */
export function offers(name: string, tool: string): boolean {
  return name === tool || canonTool(name) === canonTool(tool)
}

function toolsOfRow(row: DeviceRow): DeviceTool[] {
  return cleanTools((row as DeviceRow & { tools?: unknown }).tools)
}

export interface ToolOutcome {
  ok: boolean
  /** done: answered; waiting: still running or queued (the result will come to the chat). */
  state: 'done' | 'failed' | 'waiting'
  text: string
  device: string
}

export interface DeviceToolHubDeps {
  store: DataStore & { onChange(listener: (change: DataChange) => void): () => void }
  selfId: () => string
  /** This node's own tools that others may use (already filtered by its share switches), run in place for "self". */
  localTools?: () => Tool[]
  /** This node's share switches (settings devicesShareGroups). */
  shareGroups?: () => Partial<Record<string, boolean>>
  /** Preferred device per group (settings devicesPreferred). */
  preferred?: () => Partial<Record<string, string>>
  /** Is a node (not on RPC) reachable now? Default: only RPC connections count. */
  reachable?: (deviceId: string) => boolean
  /** A result that came after the agent stopped waiting, posted to the chat. */
  noteBack: (chat: string, text: string) => void | Promise<void>
  /** Where pictures from devices are saved, so the model can see them ([[image:path]]). */
  imageDir?: string
  /** Tests shorten how long the agent waits; the device still gets the real deadline. */
  waitMs?: number
  now?: () => number
}

interface Waiter {
  resolve: (row: DeviceCommandRow) => void
}

export class DeviceToolHub {
  private host: DevicesHost | null = null
  private readonly waiters = new Map<string, Waiter>()
  private offChange: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly now: () => number

  constructor(private readonly deps: DeviceToolHubDeps) {
    this.now = deps.now ?? Date.now
    this.offChange = deps.store.onChange((change) => {
      if (change.entity !== 'device_command' || change.row === undefined) return
      const row = change.row as DeviceCommandRow
      if (row.status === 'done' || row.status === 'failed') void this.settle(row)
    })
  }

  attach(host: DevicesHost): void {
    this.host = host
    host.addRpc('device.result', async (deviceId, args) => {
      const [id, ok, value] = args
      if (typeof id !== 'string') throw new Error('device.result needs a command id')
      return this.result(deviceId, id, ok === true, value)
    })
    void this.refresh()
    this.timer = setInterval(() => void this.refresh().then(() => this.deliverQueued()), 3_000)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.offChange?.()
    this.offChange = null
  }

  /** Keep each connected device's advertised tools on its row, and this node's own. */
  async refresh(): Promise<void> {
    const rows = await this.deps.store.list('device')
    for (const row of rows) {
      let tools: DeviceTool[] | null = null
      if (row.id === this.deps.selfId()) {
        const local = this.deps.localTools?.() ?? []
        tools = catalogueOf(local, shareOf(this.deps.shareGroups?.()))
      } else if (this.host?.isConnected(row.id) === true) {
        const facts = this.host.factsOf(row.id) as (ReturnType<DevicesHost['factsOf']> & { tools?: unknown }) | null
        if (facts !== null && facts.tools !== undefined) tools = cleanTools(facts.tools)
      }
      if (tools === null) continue
      if (JSON.stringify(tools) === JSON.stringify(toolsOfRow(row))) continue
      await this.deps.store.upsert('device', { id: row.id, tools } as Partial<DeviceRow> & { id: string })
    }
  }

  isOnline(row: DeviceRow): boolean {
    if (row.id === this.deps.selfId()) return true
    if (this.host?.isConnected(row.id) === true) return true
    return this.deps.reachable?.(row.id) === true
  }

  /** What devices_list shows. */
  async list(): Promise<Array<{ id: string; name: string; kind: string; online: boolean; self: boolean; groups: DeviceToolGroup[]; tools: string[] }>> {
    await this.refresh().catch(() => undefined)
    const rows = (await this.deps.store.list('device')).filter((row) => !row.revoked).sort((a, b) => a.priority - b.priority)
    return rows.map((row) => {
      const tools = toolsOfRow(row)
      return {
        id: row.id,
        name: row.name,
        kind: row.kind,
        online: this.isOnline(row),
        self: row.id === this.deps.selfId(),
        groups: [...new Set(tools.map((tool) => tool.group))],
        tools: tools.map((tool) => tool.name),
      }
    })
  }

  /** The device meant by `ref` (id, name said loosely, or "best" for this tool), or why none. */
  async resolve(ref: string, tool: string, chat: string): Promise<{ row: DeviceRow } | { error: string }> {
    const rows = (await this.deps.store.list('device')).filter((row) => !row.revoked)
    const wanted = ref.trim()
    if (wanted === '' || wanted.toLowerCase() === 'best') {
      const row = await this.best(rows, tool, chat)
      if (row === null) {
        const holders = rows.filter((r) => toolsOfRow(r).some((t) => t.name === tool))
        return { error: holders.length === 0 ? `No linked device offers ${tool}.` : `The devices with ${tool} are offline: ${holders.map((r) => r.name).join(', ')}.` }
      }
      return { row }
    }
    const byId = rows.find((row) => row.id === wanted)
    if (byId !== undefined) return { row: byId }
    const hits = findMatches(wanted, rows.map((row, index) => ({ item: row, order: index, fields: [{ text: row.name, weight: 1 }, { text: `${row.kind} ${row.platform}`, weight: 0.7, fuzzy: false }] })))
    const { winner, close } = pickMatch(hits)
    if (winner !== null) return { row: winner.item }
    if (close.length > 0) return { error: `"${wanted}" could be ${close.map((hit) => hit.item.name).join(' or ')}. Say which.` }
    return { error: `No linked device called "${wanted}". Linked: ${rows.map((row) => row.name).join(', ') || 'none'}.` }
  }

  /** The device the newest message in the chat came from, when it is another device that offers this tool. */
  async originWith(chat: string, tool: string): Promise<string | null> {
    const origin = await latestOrigin(this.deps.store, chat)
    if (origin === null || origin.deviceId === this.deps.selfId()) return null
    const row = await this.deps.store.get('device', origin.deviceId)
    if (row === null || row.revoked) return null
    return toolsOfRow(row).some((t) => offers(t.name, tool)) ? row.id : null
  }

  /** The router (s11): the device the message came from, then the preferred one for the group, then by priority. */
  private async best(rows: DeviceRow[], tool: string, chat: string): Promise<DeviceRow | null> {
    const able = rows.filter((row) => this.isOnline(row) && toolsOfRow(row).some((t) => offers(t.name, tool)))
    if (able.length === 0) return null
    const origin = await latestOrigin(this.deps.store, chat)
    const fromOrigin = origin === null ? undefined : able.find((row) => row.id === origin.deviceId)
    if (fromOrigin !== undefined) return fromOrigin
    const group = toolsOfRow(able[0] as DeviceRow).find((t) => offers(t.name, tool))?.group ?? groupOf(tool)
    const preferredId = this.deps.preferred?.()[group]
    const preferred = preferredId === undefined ? undefined : able.find((row) => row.id === preferredId)
    if (preferred !== undefined) return preferred
    const phone = (row: DeviceRow): boolean => row.kind === 'phone' || row.kind === 'tablet'
    const heavy = HEAVY.has(group)
    return [...able].sort((a, b) => (heavy ? Number(phone(a)) - Number(phone(b)) : 0) || a.priority - b.priority || a.name.localeCompare(b.name))[0] ?? null
  }

  /** Call one tool on one device and wait for its answer (up to the deadline). */
  async call(ref: string, tool: string, args: JsonObject, chat: string = MAIN_CHAT, ctx?: ToolContext): Promise<ToolOutcome> {
    // What connected devices offer right now (a phone that just said hello).
    await this.refresh().catch(() => undefined)
    const found = await this.resolve(ref, tool, chat)
    if ('error' in found) return { ok: false, state: 'failed', text: found.error, device: '' }
    const row = found.row
    const offered = toolsOfRow(row)
    const spec = offered.find((t) => t.name === tool) ?? offered.find((t) => offers(t.name, tool))
    if (spec !== undefined) tool = spec.name
    if (spec === undefined) {
      const names = offered.map((t) => t.name)
      return { ok: false, state: 'failed', device: row.name, text: names.length === 0 ? `${row.name} offers no tools to other devices.` : `${row.name} has no ${tool}. It offers: ${names.join(', ')}.` }
    }
    // This node itself: run it here.
    if (row.id === this.deps.selfId()) {
      const local = (this.deps.localTools?.() ?? []).find((t) => t.spec.name === tool)
      if (local === undefined || ctx === undefined) return { ok: false, state: 'failed', device: row.name, text: `${tool} cannot run here.` }
      const text = await local.run(args, ctx)
      return { ok: true, state: 'done', device: row.name, text }
    }
    const deadlineMs = spec.group === 'browser' ? BROWSER_DEADLINE_MS : DEFAULT_DEADLINE_MS
    const at = this.now()
    const command = await this.deps.store.upsert('device_command', {
      id: `cmd_${randomUUID()}`,
      target: row.id,
      kind: 'tool',
      tool,
      args: JSON.stringify(args),
      deadlineMs,
      status: 'queued',
      note: '',
      chat,
      brainId: this.deps.selfId(),
      expiresAt: at + QUEUE_TTL_MS + deadlineMs,
      updatedAt: at,
    } as Partial<DeviceCommandRow> & { target: string })
    const answer = this.wait(command.id, this.deps.waitMs ?? deadlineMs, ctx?.signal)
    if (this.host?.isConnected(row.id) === true) await this.deliver(command)
    const done = await answer
    if (done === null) {
      const online = this.isOnline(row)
      return {
        ok: false,
        state: 'waiting',
        device: row.name,
        text: online
          ? `${row.name} is still working on ${tool}. Its result will be posted to this chat when it comes.`
          : `${row.name} is offline. ${tool} will run when it connects (within 10 minutes) and the result will be posted to this chat.`,
      }
    }
    return this.outcome(done, row.name)
  }

  /** A device's answer over RPC. Only the target may answer its command. */
  async result(deviceId: string, id: string, ok: boolean, value: unknown): Promise<boolean> {
    const row = await this.deps.store.get('device_command', id)
    if (row === null || row.target !== deviceId) return false
    if (row.status === 'done' || row.status === 'failed' || row.status === 'expired') return true
    await this.deps.store.upsert('device_command', { id, status: ok ? 'done' : 'failed', result: encodeResult(value), updatedAt: this.now() } as Partial<DeviceCommandRow> & { id: string })
    return true
  }

  /** Queued tool commands for devices that are on RPC now. */
  async deliverQueued(): Promise<void> {
    const host = this.host
    if (host === null) return
    for (const row of await this.deps.store.list('device_command')) {
      if (row.kind !== 'tool' || row.status !== 'queued' || row.expiresAt <= this.now()) continue
      if (host.isConnected(row.target)) await this.deliver(row)
    }
  }

  private async deliver(row: DeviceCommandRow): Promise<void> {
    this.host?.emit(row.target, 'device.command', toolPayload(row))
    await this.deps.store.upsert('device_command', { id: row.id, status: 'sent', updatedAt: this.now() })
  }

  private wait(id: string, ms: number, signal?: AbortSignal): Promise<DeviceCommandRow | null> {
    return new Promise((resolve) => {
      const finish = (row: DeviceCommandRow | null): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.waiters.delete(id)
        resolve(row)
      }
      const onAbort = (): void => finish(null)
      const timer = setTimeout(() => finish(null), ms)
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.set(id, { resolve: (row) => finish(row) })
    })
  }

  /** A finished command: hand it to whoever waits, else (ours, late) post it to the chat once. */
  private async settle(row: DeviceCommandRow): Promise<void> {
    if (row.kind !== 'tool') return
    const waiter = this.waiters.get(row.id)
    if (waiter !== undefined) {
      waiter.resolve(row)
      return
    }
    if (row.brainId !== this.deps.selfId() || row.note === 'told') return
    await this.deps.store.upsert('device_command', { id: row.id, note: 'told' })
    const device = (await this.deps.store.get('device', row.target))?.name ?? 'the device'
    const outcome = this.outcome(row, device)
    await this.deps.noteBack(row.chat, `[Device result: ${row.tool ?? 'tool'} on ${device} ${outcome.ok ? 'finished' : 'failed'}: ${outcome.text}]`)
  }

  private outcome(row: DeviceCommandRow, device: string): ToolOutcome {
    const ok = row.status === 'done'
    return { ok, state: ok ? 'done' : 'failed', device, text: this.render(decodeResult(row.result), ok) }
  }

  /** A device's value as text for the model; pictures become files it can see. */
  private render(value: unknown, ok: boolean): string {
    if (typeof value === 'string') return clip(value)
    if (value === null || value === undefined) return ok ? 'Done.' : 'It failed.'
    const images: string[] = []
    const strip = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(strip)
      if (typeof v === 'object' && v !== null) {
        const o = v as Record<string, unknown>
        if (o['type'] === 'image' && typeof o['data'] === 'string') {
          const path = this.saveImage(o['data'], typeof o['mime'] === 'string' ? o['mime'] : 'image/png')
          if (path !== null) images.push(path)
          return '[picture]'
        }
        return Object.fromEntries(Object.entries(o).map(([k, inner]) => [k, strip(inner)]))
      }
      return v
    }
    const cleaned = strip(value)
    const text = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned)
    return clip([text, ...images.map((path) => `[[image:${path}]]`)].join('\n'))
  }

  private saveImage(base64: string, mime: string): string | null {
    try {
      const dir = this.deps.imageDir ?? join(tmpdir(), 'agent-device-images')
      mkdirSync(dir, { recursive: true })
      const ext = mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
      const path = join(dir, `${randomUUID()}.${ext}`)
      writeFileSync(path, Buffer.from(base64, 'base64'))
      return path
    } catch {
      return null
    }
  }
}

export function toolPayload(row: DeviceCommandRow): Record<string, unknown> {
  return { id: row.id, kind: 'tool', tool: row.tool ?? '', args: decodeResult(row.args) ?? {}, chatId: row.chat, deadlineMs: row.deadlineMs ?? DEFAULT_DEADLINE_MS }
}

function encodeResult(value: unknown): string {
  const text = JSON.stringify(value ?? null) ?? 'null'
  return text.length > MAX_RESULT_CHARS ? JSON.stringify('The result was too big to send back.') : text
}

function decodeResult(text: string | undefined): unknown {
  if (text === undefined || text === '') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function clip(text: string): string {
  return text.length > MAX_TEXT_TO_AGENT ? `${text.slice(0, MAX_TEXT_TO_AGENT)}\n[cut]` : text
}

// ---- the runner: this node runs tools other brains ask of it ----------------------------------------------------

export interface DeviceToolRunnerDeps {
  store: DataStore & { onChange(listener: (change: DataChange) => void): () => void }
  selfId: () => string
  /** The tools this node lets others use (its local tools). */
  tools: () => Tool[]
  shareGroups?: () => Partial<Record<string, boolean>>
  /** The context a tool runs with here: the person on this node answers ask_user / request_approval. */
  context?: (chat: string, signal: AbortSignal) => Partial<ToolContext>
  now?: () => number
}

export class DeviceToolRunner {
  private readonly running = new Set<string>()
  private offChange: (() => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: DeviceToolRunnerDeps) {}

  start(): void {
    this.offChange = this.deps.store.onChange((change) => {
      if (change.entity === 'device_command' && change.row !== undefined) void this.consider(change.row as DeviceCommandRow)
    })
    this.timer = setInterval(() => void this.scan(), 5_000)
    this.timer.unref?.()
    void this.scan()
  }

  stop(): void {
    this.offChange?.()
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  async scan(): Promise<void> {
    for (const row of await this.deps.store.list('device_command')) await this.consider(row)
  }

  async consider(row: DeviceCommandRow): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    if (row.kind !== 'tool' || row.target !== this.deps.selfId()) return
    if (row.status !== 'queued' && row.status !== 'sent') return
    if (row.expiresAt <= now || this.running.has(row.id)) return
    this.running.add(row.id)
    try {
      await this.deps.store.upsert('device_command', { id: row.id, status: 'sent', note: 'running', updatedAt: now })
      const tool = this.deps.tools().find((t) => t.spec.name === row.tool)
      const shared = shareOf(this.deps.shareGroups?.())
      if (tool === undefined || !shared[groupOf(tool.spec.name)]) {
        await this.finish(row.id, false, `This device does not share ${row.tool ?? 'that tool'}.`)
        return
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), row.deadlineMs ?? DEFAULT_DEADLINE_MS)
      try {
        const extra = this.deps.context?.(row.chat, controller.signal) ?? {}
        const ctx: ToolContext = {
          agentLabel: 'device',
          owner: `device:${row.brainId}`,
          chat: row.chat,
          activity: async () => 0,
          updateActivity: async () => undefined,
          ask: async () => null,
          approve: async () => false,
          notify: async () => undefined,
          signal: controller.signal,
          ...extra,
        }
        const args = decodeResult(row.args)
        const text = await tool.run(typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as JsonObject) : {}, ctx)
        await this.finish(row.id, true, text)
      } catch (error) {
        await this.finish(row.id, false, error instanceof Error ? error.message : 'It failed.')
      } finally {
        clearTimeout(timer)
      }
    } finally {
      this.running.delete(row.id)
    }
  }

  private async finish(id: string, ok: boolean, value: unknown): Promise<void> {
    await this.deps.store.upsert('device_command', { id, status: ok ? 'done' : 'failed', result: encodeResult(value), note: '', updatedAt: (this.deps.now ?? Date.now)() } as Partial<DeviceCommandRow> & { id: string })
  }
}

// ---- the agent's tools ------------------------------------------------------------------------------------------

export interface DeviceAgentToolDeps {
  hub: () => DeviceToolHub | null
}

export function deviceAgentTools(deps: DeviceAgentToolDeps): Tool[] {
  return [devicesListTool(deps), deviceToolTool(deps)]
}

function devicesListTool(deps: DeviceAgentToolDeps): Tool {
  return {
    spec: {
      name: 'devices_list',
      description: "List the user's linked devices (phones, computers, servers): which are online and which tool groups each lets you use (browser, notifications, files, shell, approval, phone).",
      schema: schema([], {}),
    },
    run: async () => {
      const hub = deps.hub()
      if (hub === null) return 'Devices is off on this computer: there are no linked devices.'
      const list = await hub.list()
      if (list.length === 0) return 'No linked devices.'
      return list
        .map((d) => `- ${d.name} (${d.kind}${d.self ? ', this computer' : ''}, ${d.online ? 'online' : 'offline'}, id ${d.id}): ${d.groups.length === 0 ? 'no shared tools' : `${d.groups.join(', ')}; tools ${d.tools.join(', ')}`}`)
        .join('\n')
    },
  }
}

function deviceToolTool(deps: DeviceAgentToolDeps): Tool {
  return {
    spec: {
      name: 'device_tool',
      description:
        'Run one tool on one of the user\'s linked devices (see devices_list): their phone\'s browser when a site blocks this computer, a notification or a question on their phone, a file from another computer. device: its name or id, or "best" to let the app choose (the device the user wrote from first).',
      schema: schema(['device', 'tool'], {
        device: str('Device name or id, or "best"'),
        tool: str("The tool's name on that device, from devices_list"),
        args: { type: 'object', description: 'The tool\'s arguments' },
      }),
    },
    run: async (input, ctx) => {
      const hub = deps.hub()
      if (hub === null) return 'Devices is off on this computer: there are no linked devices.'
      const tool = typeof input['tool'] === 'string' ? input['tool'].trim() : ''
      if (tool === '') return 'Name the tool to run (see devices_list).'
      const args = typeof input['args'] === 'object' && input['args'] !== null && !Array.isArray(input['args']) ? (input['args'] as JsonObject) : {}
      const outcome = await hub.call(typeof input['device'] === 'string' ? input['device'] : 'best', tool, args, ctx.chat ?? MAIN_CHAT, ctx)
      return outcome.state === 'done' ? `On ${outcome.device}: ${outcome.text}` : outcome.text
    },
  }
}

// ---- a `device` argument on the local tools ----------------------------------------------------------------------

/** Local tools that can run on another device instead (s11). */
export const DEVICE_ARG_TOOLS: ReadonlySet<string> = new Set(['notify_user', 'ask_user', 'request_approval', 'send_file', 'open_url'])

const BLOCKED = /\b(403|429)\b|forbidden|too many requests|captcha|access denied|are you a robot|verify you are human/i

/**
 * Give the browser tools, notify_user, ask_user, request_approval, send_file and open_url an optional `device`
 * argument. Without it they act here as before (open_url and send_file already go to the device the message came
 * from); with it they run on that device. A browser call here that hits a block also says which linked devices
 * have a browser.
 */
export function withDeviceArg(tools: Tool[], hub: () => DeviceToolHub | null): Tool[] {
  return tools.map((tool) => {
    const name = tool.spec.name
    const browser = name.startsWith('browser_')
    if (!browser && !DEVICE_ARG_TOOLS.has(name)) return tool
    const props = (tool.spec.schema['properties'] ?? {}) as JsonObject
    return {
      spec: {
        ...tool.spec,
        schema: { ...tool.spec.schema, properties: { ...props, device: { type: 'string', description: 'Optional: run this on one of the user\'s linked devices (name, id or "best"). Leave out to run here.' } } },
      },
      run: async (input, ctx) => {
        const device = typeof input['device'] === 'string' ? input['device'].trim() : ''
        const { device: _drop, ...rest } = input
        void _drop
        const active = hub()
        // A notification goes to the device the user wrote from, like open_url and send_file.
        const target = device !== '' ? device : name === 'notify_user' && active !== null ? ((await active.originWith(ctx.chat ?? MAIN_CHAT, name)) ?? '') : ''
        if (target !== '' && active !== null) {
          const outcome = await active.call(target, name, rest, ctx.chat ?? MAIN_CHAT, ctx)
          if (outcome.state !== 'done') return outcome.text
          return phrase(name, outcome)
        }
        const text = await tool.run(rest, ctx)
        if (!browser || active === null || !BLOCKED.test(text)) return text
        const others = (await active.list().catch(() => [])).filter((d) => !d.self && d.groups.includes('browser'))
        if (others.length === 0) return text
        const names = others.map((d) => `${d.name} (${d.online ? 'online' : 'offline'})`).join(', ')
        return `${text}\n\n[This site may be blocking this computer. Linked devices with a browser: ${names}. You can retry with device: "<name>" or "best".]`
      },
    }
  })
}

function phrase(name: string, outcome: ToolOutcome): string {
  if (name === 'ask_user') return `The user answered on ${outcome.device}: ${outcome.text}`
  if (name === 'request_approval') {
    const yes = /^(true|yes|approve|approved)\b/i.test(outcome.text.replace(/^"|"$/g, ''))
    return yes ? `The user approved on ${outcome.device}.` : `The user declined on ${outcome.device}.`
  }
  return `On ${outcome.device}: ${outcome.text}`
}
