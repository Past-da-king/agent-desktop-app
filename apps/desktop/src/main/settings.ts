/**
 * Non-secret settings, stored as JSON under the app's user-data folder.
 *
 * Reads merge whatever is on disk over `DEFAULT_SETTINGS`, so an old file and a new field both
 * work. Writes go to a temp file and are renamed into place, so a crash mid-write cannot leave a
 * half-written settings.json. Unknown keys are ignored and every string is clamped to 500 chars.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { dirname } from 'node:path'

import { DEFAULT_SETTINGS, VOICES, type Settings } from '@agent/core'

export type SettingsChangeListener = (settings: Settings) => void

export interface SettingsStoreOptions {
  /** Tests can pin the fallback device name instead of using this computer's hostname. */
  hostname?: () => string
}

const MAX_STRING = 500
const INVALID = Symbol('invalid')

const STRING_ENUMS: Partial<Record<keyof Settings, readonly string[]>> = {
  mode: ['none', 'api_key', 'subscription'],
  cli: ['claude', 'codex', ''],
  provider: ['anthropic', 'openai', 'gemini', 'deepseek', 'opencode_go', 'opencode_zen', 'openrouter', 'custom'],
  theme: ['system', 'light', 'dark'],
  mascot: ['scout', 'ghost', 'clover', 'bloom', 'puff', 'gem', 'pebble', 'heart', 'bun'],
  shell: ['always', 'ask', 'never'],
  voiceName: VOICES.map((voice) => voice.id),
}

export class SettingsStore {
  private readonly file: string
  private readonly hostname: () => string
  private readonly listeners = new Set<SettingsChangeListener>()
  private state: Settings

  constructor(file: string, options: SettingsStoreOptions = {}) {
    this.file = file
    this.hostname = options.hostname ?? osHostname
    const raw = readObject(file)
    const merged = mergeSettings(raw)
    if (merged.deviceName.trim() === '') merged.deviceName = this.hostname() || 'This computer'
    this.state = merged
    if (raw === null || raw['deviceName'] !== merged.deviceName) {
      try {
        this.writeState(merged)
      } catch {
        // A read-only folder must not stop the app from starting with defaults.
      }
    }
  }

  get(): Settings {
    return clone(this.state)
  }

  /** Apply a patch. Invalid values and unknown keys are ignored rather than failing the whole save. */
  save(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.state }
    const entries = Object.entries(patch as Record<string, unknown>)
    const target = next as unknown as Record<string, unknown>
    for (const [key, value] of entries) {
      if (!(key in DEFAULT_SETTINGS)) continue
      const coerced = coerce(key as keyof Settings, value)
      if (coerced === INVALID) continue
      target[key] = coerced
    }
    this.state = next
    this.writeState(next)
    this.emit()
    return clone(next)
  }

  /** Back to defaults, keeping a sensible device name. */
  reset(): Settings {
    this.state = { ...DEFAULT_SETTINGS, grantedFolders: [] }
    this.state.deviceName = this.hostname() || 'This computer'
    this.writeState(this.state)
    this.emit()
    return clone(this.state)
  }

  onChange(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    const snapshot = clone(this.state)
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // Settings listeners are UI code; one failing must not stop a save.
      }
    }
  }

  private writeState(state: Settings): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, this.file)
  }
}

function clone(settings: Settings): Settings {
  return { ...settings, grantedFolders: [...settings.grantedFolders] }
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function mergeSettings(raw: Record<string, unknown> | null): Settings {
  const merged: Settings = { ...DEFAULT_SETTINGS, grantedFolders: [] }
  if (raw === null) return merged
  const target = merged as unknown as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof Settings>) {
    if (!(key in raw)) continue
    const coerced = coerce(key, raw[key])
    if (coerced !== INVALID) target[key] = coerced
  }
  return merged
}

function coerce(key: keyof Settings, value: unknown): unknown {
  if (key === 'syncEmail') {
    if (value === null) return null
    if (typeof value === 'string') return clamp(value)
    return INVALID
  }
  if (key === 'grantedFolders') {
    if (!Array.isArray(value)) return INVALID
    if (!value.every((item) => typeof item === 'string')) return INVALID
    return value.map((item) => clamp(item as string))
  }

  const expected = DEFAULT_SETTINGS[key]
  if (typeof expected === 'boolean') return typeof value === 'boolean' ? value : INVALID
  if (typeof expected === 'string') {
    if (typeof value !== 'string') return INVALID
    const allowed = STRING_ENUMS[key]
    if (allowed !== undefined && !allowed.includes(value)) return INVALID
    return clamp(value)
  }
  return INVALID
}

function clamp(value: string): string {
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
}

/** Tests use this to prove a leftover temp file cannot leak into a read. */
export function removeStaleTemp(file: string): void {
  rmSync(`${file}.tmp`, { force: true })
}
