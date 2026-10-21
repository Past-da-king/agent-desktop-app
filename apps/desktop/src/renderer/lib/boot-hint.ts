import type { MascotId, Settings } from '@agent/core'

/**
 * What the boot screen draws before settings arrive over IPC: the person's mascot, the agent's name, accent and
 * theme, remembered from the last run in localStorage. Absent on a fresh install, so the plain wordmark shows.
 */
export interface BootHint {
  mascot: MascotId
  agentName: string
  accent: string
  theme: 'system' | 'light' | 'dark'
}

const KEY = 'agent.boot'

export function readBootHint(storage: Pick<Storage, 'getItem'> | null = store()): BootHint | null {
  try {
    const raw = storage?.getItem(KEY)
    if (raw === null || raw === undefined) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const o = value as Record<string, unknown>
    if (typeof o['mascot'] !== 'string' || typeof o['agentName'] !== 'string') return null
    const theme = o['theme'] === 'light' || o['theme'] === 'dark' ? o['theme'] : 'system'
    return { mascot: o['mascot'] as MascotId, agentName: o['agentName'], accent: typeof o['accent'] === 'string' ? o['accent'] : 'iris', theme }
  } catch {
    return null
  }
}

export function writeBootHint(settings: Pick<Settings, 'mascot' | 'agentName' | 'accent' | 'theme'>, storage: Pick<Storage, 'setItem'> | null = store()): void {
  try {
    storage?.setItem(KEY, JSON.stringify({ mascot: settings.mascot, agentName: settings.agentName, accent: settings.accent, theme: settings.theme }))
  } catch {
    // Storage may be blocked; the next boot just shows the wordmark.
  }
}

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
