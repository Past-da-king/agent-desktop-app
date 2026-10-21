/**
 * Which app is probably holding a shortcut we could not register. Windows does not say who owns a global
 * shortcut, so this is a cheap guess: the running processes, matched against apps known to take shortcuts.
 * Only Windows is checked; elsewhere the generic words stay.
 */
import { execFile } from 'node:child_process'
import { join } from 'node:path'

import { canonicalAccelerator } from './hotkeys'

export interface KnownHolder {
  name: string
  /** Process image names, lower case. */
  processes: string[]
  /** Shortcuts the app takes out of the box, canonical ("Alt+Space"). */
  defaults: string[]
  /** The app lets people pick any shortcut, so it may hold any of ours. */
  anyShortcut?: boolean
}

/** Wispr Flow first: it is the dictation app this replaces and its shortcuts are the person's own choice. */
export const KNOWN_HOLDERS: KnownHolder[] = [
  { name: 'Wispr Flow', processes: ['wispr flow.exe', 'wispr flow helper.exe'], defaults: [], anyShortcut: true },
  { name: 'PowerToys Run', processes: ['powertoys.powerlauncher.exe'], defaults: ['Alt+Space'] },
  { name: 'ChatGPT', processes: ['chatgpt.exe'], defaults: ['Alt+Space'] },
  { name: 'Raycast', processes: ['raycast.exe'], defaults: ['Alt+Space'] },
]

/** The known app most likely holding `accelerator`, given the running process names (lower case). */
export function likelyHolder(accelerator: string, running: Set<string>, platform: NodeJS.Platform = 'win32'): string | null {
  const canonical = canonicalAccelerator(accelerator, platform)
  const isRunning = (holder: KnownHolder): boolean => holder.processes.some((name) => running.has(name))
  // An app where people choose their own shortcut (Wispr Flow) is the best guess whenever it runs; otherwise an
  // app that takes this shortcut out of the box.
  const flexible = KNOWN_HOLDERS.find((holder) => holder.anyShortcut === true && isRunning(holder))
  if (flexible !== undefined) return flexible.name
  return KNOWN_HOLDERS.find((holder) => holder.defaults.includes(canonical) && isRunning(holder))?.name ?? null
}

/** Image names from `tasklist /fo csv /nh`, lower case. */
export function parseTasklist(output: string): Set<string> {
  const names = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim())
    if (match?.[1] !== undefined) names.add(match[1].toLowerCase())
  }
  return names
}

export type ProcessLister = () => Promise<Set<string>>

/** The running processes on Windows (about a second, so callers cache it). Empty elsewhere or on failure. */
export const listProcesses: ProcessLister = () =>
  new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(new Set())
      return
    }
    const root = process.env['SystemRoot'] ?? 'C:\\Windows'
    execFile(join(root, 'System32', 'tasklist.exe'), ['/fo', 'csv', '/nh'], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error === null ? parseTasklist(String(stdout)) : new Set())
    })
  })

/** Caches the process list for a while: the guess runs on every retry and status change. */
export function cachedLister(list: ProcessLister, ttlMs = 30_000, now: () => number = Date.now): ProcessLister {
  let at = 0
  let last: Promise<Set<string>> | null = null
  return () => {
    if (last === null || now() - at > ttlMs) {
      at = now()
      last = list()
    }
    return last
  }
}
