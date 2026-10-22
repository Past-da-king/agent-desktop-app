/**
 * Taking in the state bundle (protocol s6) after pairing.
 *
 * SEAM: workstream B owns the real `applyBundle` (devices/bundle.ts). Until it is merged, this minimal version takes
 * the parts a brain needs to run turns: the non-secret settings (with the AI accounts in them), profiles, learned
 * apps, and the secrets (AI keys, Composio key, the mesh pass-hash table). At merge, `applyBundle` here is replaced by
 * a call into B's module; the CLI only calls this one function.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Settings } from '@agent/core'

import { SecretPassTable } from '../main/devices/passes'
import type { Secrets } from '../main/secrets'
import type { SettingsStore } from '../main/settings'

export interface BundleTargets {
  dataDir: string
  settings: SettingsStore
  secrets: Secrets
}

/** Settings that describe this device, never copied from another one. */
const LOCAL_ONLY: ReadonlyArray<keyof Settings> = [
  'launchAtLogin',
  'closeToTray',
  'quickAskHotkey',
  'dictateHotkey',
  'dictateCleanHotkey',
] as ReadonlyArray<keyof Settings>

const SECRET_NAME = /^[A-Za-z0-9_-]{1,64}$/

export interface ApplyResult {
  settings: number
  secrets: number
  passHashes: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function applyBundle(targets: BundleTargets, bundle: unknown): Promise<ApplyResult> {
  if (!isObject(bundle)) throw new Error('The other device sent an empty bundle.')
  const result: ApplyResult = { settings: 0, secrets: 0, passHashes: 0 }

  if (isObject(bundle['settings'])) {
    const patch: Record<string, unknown> = { ...bundle['settings'] }
    for (const key of LOCAL_ONLY) delete patch[key]
    if (Array.isArray(bundle['accounts'])) patch['accounts'] = bundle['accounts']
    targets.settings.save(patch as Partial<Settings>)
    result.settings = Object.keys(patch).length
  }
  for (const [name, file] of [['profiles', 'profiles.json'], ['learnedApps', 'learned-apps.json']] as const) {
    const value = bundle[name]
    // Both files hold exactly what the desktop app keeps (profiles.ts, store.ts), so the rows pass through as they are.
    if (Array.isArray(value) || (name === 'learnedApps' && isObject(value))) writeFileSync(join(targets.dataDir, file), JSON.stringify(value, null, 2), { mode: 0o600 })
  }
  const secrets = bundle['secrets']
  if (isObject(secrets)) {
    for (const [name, value] of Object.entries(secrets)) {
      if (name === 'passHashes' && isObject(value)) {
        const table = Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        new SecretPassTable(targets.secrets).replaceAll(table)
        result.passHashes = Object.keys(table).length
      } else if (typeof value === 'string' && SECRET_NAME.test(name)) {
        targets.secrets.set(name as Parameters<Secrets['set']>[0], value)
        result.secrets++
      }
    }
  }
  return result
}
