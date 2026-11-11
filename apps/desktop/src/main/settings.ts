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

import { DEFAULT_SETTINGS, NO_LIMIT_CAP, VOICES, accountById, legacyFieldsOf, mainPickOf, type AiAccount, type AiPick, type AiPicks, type Settings, cleanRoster, knownRoster } from '@agent/core'

import { upgradeHotkeys } from './hotkeys'
import { validQuietHours } from '../shared/wakeups'

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
  recordingAudioKeep: ['today', 'week', 'always'],
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

  /**
   * Every setting back to its default, keeping a sensible device name. Chats, memory, keys and files are not touched:
   * this is "Reset settings only" in Settings > Privacy and data. The full wipe is the IPC `reset`.
   */
  resetSettings(): Settings {
    this.state = { ...DEFAULT_SETTINGS, grantedFolders: [] }
    this.state.deviceName = this.hostname() || 'This computer'
    this.writeState(this.state)
    this.emit()
    return clone(this.state)
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
  // Up to 0.2.56 `devicesJobCap` defaulted to 4 (0 = none). Only "none" was ever a real choice worth keeping:
  // every other stored value was the old default, and work for other devices now has no limit unless asked.
  if (!('devicesJobLimit' in raw) && raw['devicesJobCap'] === 0) merged.devicesJobLimit = -1
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
  if (key === 'devicesPreferred' || key === 'devicesShareGroups') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return INVALID
    const want = key === 'devicesPreferred' ? 'string' : 'boolean'
    const out: Record<string, unknown> = {}
    for (const [group, item] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
      if (/^[a-z]{1,20}$/.test(group) && typeof item === want) out[group] = typeof item === 'string' ? clamp(item) : item
    }
    return out
  }

  if (key === 'wakeupSnoozeMinutes') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return INVALID
    return Math.min(120, Math.max(1, Math.round(value)))
  }
  if (key === 'wakeupsIdleMinutes') {
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) return INVALID
    return Math.min(240, Math.max(1, Math.round(number)))
  }
  if (key === 'wakeupsPauseHereUntil') {
    // '' is not paused. Any time Date can read is kept as a local ISO time with its offset, so it reads back as meant.
    if (typeof value !== 'string') return INVALID
    const clean = value.trim()
    if (clean === '') return ''
    const at = Date.parse(clean)
    return Number.isFinite(at) ? localIso(at) : INVALID
  }
  if (key === 'gitMaxFileMb') {
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) return INVALID
    return Math.min(500, Math.max(1, Math.round(number)))
  }
  if (key === 'gitExclude') {
    if (typeof value !== 'string') return INVALID
    return value.slice(0, 2000)
  }
  if (key === 'wakeupVolume') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return INVALID
    return Math.min(1, Math.max(0.1, Math.round(value * 100) / 100))
  }
  if (key === 'wakeupQuietHours') {
    if (typeof value !== 'string') return INVALID
    const clean = value.replace(/\s+/g, '')
    return validQuietHours(clean) ? clean : INVALID
  }
  if (key === 'helpersRunOn') {
    if (typeof value !== 'string') return INVALID
    const clean = value.trim()
    return clean === 'best' || clean === 'here' || /^[A-Za-z0-9_-]{1,64}$/.test(clean) ? clean : INVALID
  }
  if (key === 'miniappPinCap') {
    // How many pinned mini-apps the sidebar shows. It was added to the defaults but never to this list, so a value
    // could not be saved at all; the Settings row for it needs it to work.
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) return INVALID
    return Math.min(20, Math.max(1, Math.round(number)))
  }
  if (key === 'devicesJobLimit') {
    if (value === null || value === '') return 0
    if (typeof value !== 'number' || !Number.isFinite(value)) return INVALID
    return value < 0 ? -1 : Math.min(NO_LIMIT_CAP, Math.round(value))
  }
  // 0 or blank = no limit; any positive whole number = at most that many. Never a ceiling of our own.
  if (key === 'helpersAtOnce' || key === 'helperMaxSteps' || key === 'routinesAtOnce' || key === 'helperQuietMinutes') {
    if (value === null || value === '') return 0
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) return INVALID
    return number <= 0 ? 0 : Math.min(NO_LIMIT_CAP, Math.round(number))
  }

  // Thresholds for this computer's spare memory, disk and CPU (runtime/resources.ts); 0 or blank = no check.
  if (key === 'helperMinFreeRamGb' || key === 'helperMinFreeDiskGb' || key === 'helperBusyCpu' || key === 'watchdogMs') {
    if (value === null || value === '') return 0
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) return INVALID
    const top = key === 'helperBusyCpu' ? 100 : key === 'watchdogMs' ? 60_000 : 1_000
    return number <= 0 ? 0 : Math.min(top, Math.round(number * 10) / 10)
  }

  // Real input under the input lock: how long he must be still, 3 seconds to 10 minutes.
  if (key === 'inputLockIdleSeconds') {
    const number = typeof value === 'string' ? Number(value.trim()) : value
    if (typeof number !== 'number' || !Number.isFinite(number)) return INVALID
    return Math.min(600, Math.max(3, Math.round(number)))
  }

  // Show me how: an account and a model, both '' for automatic.
  if (key === 'guideModel') return pickFrom(value)

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

/** "2026-11-02T08:00:00+02:00": this computer's local time, with its offset. */
function localIso(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(Math.abs(n)).padStart(2, '0')
  const offset = -d.getTimezoneOffset()
  const sign = offset < 0 ? '-' : '+'
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}${sign}${two(Math.trunc(offset / 60))}:${two(offset % 60)}`
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
  // Pictures: kept on any account kind (a plan's engine reads them too). 'auto' is what absent means, so it is not stored.
  if (o['pictures'] === 'on' || o['pictures'] === 'off') account.pictures = o['pictures']
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
