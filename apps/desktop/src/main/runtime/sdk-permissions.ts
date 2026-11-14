/**
 * When the agent runs on the person's Claude plan it uses Claude Code's own tools (Bash or PowerShell,
 * Read, Write, Edit, Glob, Grep), which are better than the app's copies. Every one of them asks the app
 * first, through the Agent SDK's canUseTool hook, and the app applies the person's rules:
 *  - commands: an approval card with the exact command, every time; refused when Shell commands is Never;
 *  - everything below runs without a card when the person chose Run without asking;
 *  - changes to files: free inside a granted folder, an approval card anywhere else;
 *  - reading files: free inside a granted folder, an approval card anywhere else;
 *  - anything else: refused, so a new built-in tool cannot act around the app.
 */
import { resolve } from 'node:path'

import type { Settings } from '@agent/core'

import { refuseRealInput } from '../agent-cursor/real-input-guard'
import { expandHome, insideFolder } from '../tools/files'

export type Permission = { allow: true } | { allow: false; message: string }

export interface PermissionDeps {
  settings: () => Settings
  approve: (summary: string, details: string) => Promise<boolean>
  /** Folders the engine may use freely besides the granted ones (its own work folder). */
  alsoAllowed?: string[]
  platform?: NodeJS.Platform
}

const COMMANDS = new Set(['Bash', 'PowerShell'])
const CHANGES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const READS = new Set(['Read', 'Glob', 'Grep', 'LS'])
/** The Claude Code tools the agent gets on a plan (read-only web tools need no question). */
export const SDK_TOOLS = ['Bash', 'PowerShell', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch']
/** The app's own copies of what the SDK tools do: left out of plan runs so the model is not offered both. */
export const REPLACED_BY_SDK = new Set(['shell_run', 'run_code', 'files_list', 'files_read', 'files_write', 'files_find', 'files_move'])

function pathOf(input: Record<string, unknown>): string {
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

export function sdkPermission(deps: PermissionDeps): (name: string, input: Record<string, unknown>) => Promise<Permission> {
  const platform = deps.platform ?? process.platform
  const inside = (raw: string): boolean => {
    if (raw === '') return false
    const target = resolve(expandHome(raw))
    const folders = [...deps.settings().grantedFolders, ...(deps.alsoAllowed ?? [])]
    return folders.some((folder) => insideFolder(target, resolve(expandHome(folder)), platform))
  }

  return async (name, input) => {
    // "Run without asking": the person lets the agent act anywhere on this computer.
    const free = deps.settings().shell === 'always'
    if (COMMANDS.has(name)) {
      const real = refuseRealInput(String(input['command'] ?? ''))
      if (real !== null) return { allow: false, message: real }
      if (free) return { allow: true }
      if (deps.settings().shell === 'never') {
        return { allow: false, message: 'Shell commands are turned off on this computer (Settings, This computer). Do the job another way or ask the user to turn them on.' }
      }
      const command = String(input['command'] ?? '').trim()
      const ok = await deps.approve('Run a command on this computer', command === '' ? '(empty command)' : command)
      return ok ? { allow: true } : { allow: false, message: 'The user declined this command. Do not run it; find another way or ask.' }
    }
    if (CHANGES.has(name)) {
      const path = pathOf(input)
      if (free || inside(path)) return { allow: true }
      const ok = await deps.approve('Change a file on this computer', path === '' ? 'A file outside your folders' : path)
      return ok ? { allow: true } : { allow: false, message: 'The user declined this change.' }
    }
    if (READS.has(name)) {
      const path = pathOf(input)
      if (free || path === '' || inside(path)) return { allow: true }
      const ok = await deps.approve('Read files on this computer', path)
      return ok ? { allow: true } : { allow: false, message: 'The user declined. Ask them to grant the folder in Settings if it is needed.' }
    }
    if (name === 'WebSearch' || name === 'WebFetch' || name.startsWith('mcp__agent__')) return { allow: true }
    return { allow: false, message: `${name} is not available inside the Agent app.` }
  }
}
