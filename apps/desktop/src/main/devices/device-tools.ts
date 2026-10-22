/**
 * This node's own tools for the agents on other devices (protocol s11): the app's existing tool implementations
 * (the agent browser, notify, ask_user and request_approval shown in this app, files), plus file_send and
 * file_receive for moving a file in one step. A command { kind: "tool", id, tool, args, chatId, deadlineMs } runs
 * here and its answer goes back with device.result. Each group can be switched off; shell is off by default.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

import type { JsonObject, Tool, ToolContext } from '@agent/core'

import { contentTypeFor } from './server'
import type { DeviceTool, DeviceToolCommand, DeviceToolGroup, DeviceToolResult } from './types'

export type ShareGroup = 'browser' | 'files' | 'notifications' | 'approval' | 'shell'
export const SHARE_GROUPS: readonly ShareGroup[] = ['browser', 'files', 'notifications', 'approval', 'shell']
/** Protocol s11 defaults: on for browser, files, notifications and approval; off for shell. */
export const DEFAULT_SHARE: Readonly<Record<ShareGroup, boolean>> = { browser: true, files: true, notifications: true, approval: true, shell: false }

const DEFAULT_DEADLINE_MS = 120_000
const BROWSER_DEADLINE_MS = 600_000
/** Files up to this size travel inside the answer (base64); a bigger one is refused rather than half sent. */
export const MAX_INLINE_FILE = 16 * 1024 * 1024
const IMAGE_MARKER = /\[\[image:([^\]]+)]]/g

const FIXED_GROUPS: Record<string, ShareGroup> = {
  notify_user: 'notifications',
  ask_user: 'approval',
  request_approval: 'approval',
  files_list: 'files',
  files_read: 'files',
  files_find: 'files',
  files_write: 'files',
  file_send: 'files',
  file_receive: 'files',
  shell_run: 'shell',
}

const READ_ONLY = new Set(['browser_look', 'browser_read', 'browser_wait_for', 'files_list', 'files_read', 'files_find', 'file_send'])

/** The group a tool of this app belongs to, or null when it is not one this node shares. */
export function groupOf(name: string): ShareGroup | null {
  if (name.startsWith('browser_')) return 'browser'
  return FIXED_GROUPS[name] ?? null
}

export interface DeviceToolHostDeps {
  /** The app's tools (the main toolset); only the shareable ones are offered. */
  tools: () => Tool[]
  /** A context for one command: ask/approve show their cards in this app, the browser gets its own tab. */
  context: (signal: AbortSignal, command: DeviceToolCommand) => ToolContext
  /** The person's switches, per group. */
  shared: () => Record<ShareGroup, boolean>
  /** Where file_receive puts what it is given. */
  inbox: string
  log?: (message: string, detail?: Record<string, unknown>) => void
}

function fileTools(inbox: string): Tool[] {
  return [
    {
      spec: {
        name: 'file_send',
        description: 'Send a file from this computer to the agent that asks: its bytes come back in the answer (up to 16 MB).',
        schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file on this computer' } }, required: ['path'] },
      },
      run: async (input) => {
        const path = typeof input['path'] === 'string' ? input['path'] : ''
        const info = path === '' ? undefined : statSync(path, { throwIfNoEntry: false })
        if (info === undefined || !info.isFile()) throw new Error('That file is not on this computer.')
        if (info.size > MAX_INLINE_FILE) throw new Error('That file is bigger than 16 MB.')
        return JSON.stringify({ type: 'file', name: basename(path), mime: contentTypeFor(path), size: info.size, data: readFileSync(path).toString('base64') })
      },
    },
    {
      spec: {
        name: 'file_receive',
        description: 'Put a file on this computer, in the app\'s received files folder. Returns where it was saved.',
        schema: {
          type: 'object',
          properties: { name: { type: 'string', description: 'File name' }, data: { type: 'string', description: 'The bytes, base64' } },
          required: ['name', 'data'],
        },
      },
      run: async (input) => {
        const raw = typeof input['name'] === 'string' ? basename(input['name']).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() : ''
        const name = raw === '' || raw === '.' || raw === '..' ? 'file' : raw.slice(0, 120)
        const data = typeof input['data'] === 'string' ? Buffer.from(input['data'], 'base64') : Buffer.alloc(0)
        if (data.length > MAX_INLINE_FILE) throw new Error('That file is bigger than 16 MB.')
        mkdirSync(inbox, { recursive: true })
        let target = join(inbox, name)
        for (let n = 2; statSync(target, { throwIfNoEntry: false }) !== undefined; n += 1) {
          const ext = extname(name)
          target = join(inbox, `${name.slice(0, name.length - ext.length)} (${n})${ext}`)
        }
        writeFileSync(target, data)
        return JSON.stringify({ type: 'file', path: target, size: data.length })
      },
    },
  ]
}

/** A tool's text answer as the device.result value: its text, its images inline, a file as itself. */
export function resultValue(text: string, readImage: (path: string) => Buffer | null = safeRead): unknown {
  if (text.startsWith('{"type":"file"')) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      // Plain text after all.
    }
  }
  const images: Array<{ type: 'image'; mime: string; data: string }> = []
  for (const match of text.matchAll(new RegExp(IMAGE_MARKER.source, 'g'))) {
    const path = match[1] ?? ''
    const bytes = readImage(path)
    if (bytes !== null) images.push({ type: 'image', mime: contentTypeFor(path), data: bytes.toString('base64') })
  }
  const clean = text.replace(new RegExp(IMAGE_MARKER.source, 'g'), '').trim()
  return images.length === 0 ? { text: clean } : { text: clean, images }
}

function safeRead(path: string): Buffer | null {
  try {
    const info = statSync(path)
    return info.isFile() && info.size <= MAX_INLINE_FILE ? readFileSync(path) : null
  } catch {
    return null
  }
}

export class DeviceToolHost {
  private readonly own: Tool[]

  constructor(private readonly deps: DeviceToolHostDeps) {
    this.own = fileTools(deps.inbox)
  }

  private available(): Map<string, { tool: Tool; group: ShareGroup }> {
    const shared = this.deps.shared()
    const out = new Map<string, { tool: Tool; group: ShareGroup }>()
    for (const tool of [...this.deps.tools(), ...this.own]) {
      const group = groupOf(tool.spec.name)
      if (group === null || !shared[group] || out.has(tool.spec.name)) continue
      out.set(tool.spec.name, { tool, group })
    }
    return out
  }

  /** What this node offers now, for its hello and its device row. */
  catalogue(): DeviceTool[] {
    return [...this.available().values()].map(({ tool, group }) => ({
      name: tool.spec.name,
      description: tool.spec.description,
      params: tool.spec.schema as Record<string, unknown>,
      group: group as DeviceToolGroup,
      readOnly: READ_ONLY.has(tool.spec.name),
    }))
  }

  /** Runs one command. Never throws: every failure is an answer the brain can read. */
  async run(raw: unknown): Promise<DeviceToolResult> {
    const command = toolCommand(raw)
    if (command === null) return { ok: false, error: 'That is not a tool command.' }
    const found = this.available().get(command.tool)
    if (found === undefined) return { ok: false, error: `${command.tool} is not shared on this device.` }
    const limit = found.group === 'browser' ? BROWSER_DEADLINE_MS : DEFAULT_DEADLINE_MS
    const deadline = Math.min(Math.max(command.deadlineMs > 0 ? command.deadlineMs : DEFAULT_DEADLINE_MS, 1000), limit)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deadline)
    try {
      const run = found.tool.run(command.args as JsonObject, this.deps.context(controller.signal, command))
      const timeout = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error(`${command.tool} took longer than ${Math.round(deadline / 1000)} s.`)), { once: true })
      })
      const text = await Promise.race([run, timeout])
      return { ok: true, value: resultValue(text) }
    } catch (error) {
      this.deps.log?.('Device tool failed', { tool: command.tool })
      return { ok: false, error: error instanceof Error ? error.message.slice(0, 2000) : 'The tool failed.' }
    } finally {
      clearTimeout(timer)
    }
  }
}

export function toolCommand(raw: unknown): DeviceToolCommand | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (value['kind'] !== 'tool' || typeof value['id'] !== 'string' || value['id'] === '' || typeof value['tool'] !== 'string') return null
  const args = typeof value['args'] === 'object' && value['args'] !== null && !Array.isArray(value['args']) ? (value['args'] as Record<string, unknown>) : {}
  return {
    kind: 'tool',
    id: value['id'],
    tool: value['tool'],
    args,
    chatId: typeof value['chatId'] === 'string' ? value['chatId'] : '',
    deadlineMs: typeof value['deadlineMs'] === 'number' && Number.isFinite(value['deadlineMs']) ? value['deadlineMs'] : 0,
  }
}
