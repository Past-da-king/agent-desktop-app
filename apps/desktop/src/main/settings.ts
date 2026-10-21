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

import { DEFAULT_SETTINGS, VOICES, accountById, legacyFieldsOf, mainPickOf, type AiAccount, type AiPick, type AiPicks, type Settings, cleanRoster, knownRoster } from '@agent/core'

import { upgradeHotkeys } from './hotkeys'

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
    const raw = upgradeHotkeys(readObject(file))
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
    mirrorAccounts(next, Object.keys(patch))
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
  if (key === 'accounts') {
    if (!Array.isArray(value)) return INVALID
    const list = value.map(accountFrom).filter((item): item is AiAccount => item !== null)
    const seen = new Set<string>()
    return list.filter((item) => !seen.has(item.id) && seen.add(item.id) !== undefined).slice(0, 24)
  }
  if (key === 'ai') {
    const picks = picksFrom(value)
    return picks === null ? INVALID : picks
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

/** One stored account, cleaned; null when it is not one. */
function accountFrom(raw: unknown): AiAccount | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const id = typeof o['id'] === 'string' ? o['id'].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : ''
  const kind = o['kind']
  if (id === '' || (kind !== 'claude' && kind !== 'codex' && kind !== 'api')) return null
  const providers = STRING_ENUMS.provider ?? []
  const provider = typeof o['provider'] === 'string' && providers.includes(o['provider']) ? (o['provider'] as AiAccount['provider']) : undefined
  const account: AiAccount = {
    id,
    label: clamp(typeof o['label'] === 'string' ? o['label'].trim() : '').slice(0, 60) || (kind === 'api' ? 'API key' : kind === 'codex' ? 'ChatGPT plan' : 'Claude plan'),
    kind,
    model: clamp(typeof o['model'] === 'string' ? o['model'].trim() : ''),
    hasKey: o['hasKey'] === true,
  }
  if (kind === 'api') {
    account.provider = provider ?? 'anthropic'
    if (typeof o['baseUrl'] === 'string') account.baseUrl = clamp(o['baseUrl'].trim())
    if (o['allowHttp'] === true) account.allowHttp = true
  }
  return account
}

/** A pick as stored, cleaned. */
function pickFrom(raw: unknown): AiPick {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { account: '', model: '' }
  const o = raw as Record<string, unknown>
  return {
    account: typeof o['account'] === 'string' ? o['account'].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) : '',
    model: typeof o['model'] === 'string' ? clamp(o['model'].trim()) : '',
  }
}

/** Both picks as stored, or null when it is not an object. */
export function picksFrom(raw: unknown): AiPicks | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const roster = cleanRoster(o['roster'])
  return { main: pickFrom(o['main']), helpers: pickFrom(o['helpers']), ...(roster.length > 0 ? { roster } : {}) }
}

const LEGACY_KEYS = ['mode', 'cli', 'cliModel', 'provider', 'model', 'baseUrl', 'allowHttp', 'hasKey'] as const

/**
 * The old single-choice fields and the accounts list say the same thing: a change to either is copied to the other.
 * The accounts win when both are in one patch. Older code (onboarding, the first Settings page) keeps working.
 */
function mirrorAccounts(next: Settings, patched: string[]): void {
  const accountsChanged = patched.includes('accounts') || patched.includes('ai')
  const legacyChanged = patched.some((key) => (LEGACY_KEYS as readonly string[]).includes(key))
  if (accountsChanged || (!legacyChanged && next.accounts.length > 0)) {
    // A pick that names an account that is gone falls back to the first account (mainPickOf); keep it tidy.
    const main = next.accounts.length === 0 ? { account: '', model: '' } : mainPickOf(next, 'main')
    const helpers = next.ai.helpers
    // The helper models keep only accounts that still exist; the one helpers pick mirrors the first of them.
    const roster = knownRoster(next, next.ai.roster)
    const first = roster[0]
    next.ai = {
      main,
      helpers:
        first !== undefined
          ? { account: first.account, model: first.model }
          : accountById(next, helpers.account) === null
            ? { account: '', model: helpers.account === '' ? helpers.model : '' }
            : helpers,
      ...(roster.length > 0 ? { roster } : {}),
    }
    Object.assign(next, legacyFieldsOf(accountById(next, main.account), main.model))
    return
  }
  if (!legacyChanged || next.accounts.length === 0) return
  // The old fields changed (onboarding): the main account follows them.
  const mainPick = mainPickOf(next, 'main')
  const main = accountById(next, mainPick.account)
  if (main === null) return
  const fresh: AiAccount =
    next.mode === 'subscription'
      ? { id: main.id, label: main.kind === (next.cli === 'codex' ? 'codex' : 'claude') ? main.label : next.cli === 'codex' ? 'ChatGPT plan' : 'Claude plan', kind: next.cli === 'codex' ? 'codex' : 'claude', model: next.cliModel.trim(), hasKey: false }
      : next.mode === 'api_key'
        ? { id: main.id, label: main.kind === 'api' && main.provider === next.provider ? main.label : (STRING_ENUMS.provider ?? []).includes(next.provider) ? providerLabel(next.provider) : next.provider, kind: 'api', provider: next.provider, baseUrl: next.baseUrl.trim(), model: next.model.trim(), hasKey: next.hasKey, ...(next.allowHttp ? { allowHttp: true } : {}) }
        : main
  next.accounts = next.accounts.map((account) => (account.id === main.id ? fresh : account))
  // The main pick's own model override gives way to what onboarding just chose.
  next.ai = { ...next.ai, main: { account: main.id, model: '' } }
}

function providerLabel(id: string): string {
  const labels: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini', deepseek: 'DeepSeek', opencode_go: 'OpenCode Go', opencode_zen: 'OpenCode Zen', openrouter: 'OpenRouter', custom: 'Other' }
  return labels[id] ?? id
}

function clamp(value: string): string {
  return value.length > MAX_STRING ? value.slice(0, MAX_STRING) : value
}

/** Tests use this to prove a leftover temp file cannot leak into a read. */
export function removeStaleTemp(file: string): void {
  rmSync(`${file}.tmp`, { force: true })
}
