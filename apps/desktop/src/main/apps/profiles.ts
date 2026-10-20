/**
 * Profiles: parts of the person's life ("Work", "Personal"), each the connected accounts that belong
 * to it and the browser sign-ins its helpers use. Every helper works inside exactly one profile and can
 * only use that profile's accounts. One account can sit in any number of profiles.
 *
 * Ported from reference phone data/Profiles.kt (ProfileStore). Two deliberate differences:
 * - General always exists (the phone makes it the first time it is needed), it never holds any of the
 *   person's accounts, and it cannot be renamed or deleted, so "none of your accounts" stays true.
 * - The phone names a browser profile per profile; here each profile has its own persistent Electron
 *   partition, and `browser` may point at another profile to share that one's sign-ins instead.
 *
 * Stored in profiles.json under userData. Not a synced entity yet: profiles stay on this computer.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  GENERAL_PROFILE,
  PROFILE_COLORS,
  type AgentProfileInfo,
  type ProfileAccount,
  type ProfileColor,
} from '@agent/core'

/** The id General always has. */
export const GENERAL_ID = 'general'
/** The agent browser's original partition: General (and the main agent) keep browsing in it. */
export const BASE_PARTITION = 'persist:agent-browser'
export const MAX_PROFILES = 24
export const MAX_NAME = 40

export function isProfileColor(value: unknown): value is ProfileColor {
  return typeof value === 'string' && (PROFILE_COLORS as readonly string[]).includes(value)
}

/** "  Strat   Edge work " -> "Strat Edge work", at most 40 characters. */
export function cleanName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME).trim()
}

/** The persistent partition a profile's own browser sign-ins live in. */
export function partitionFor(profileId: string | null | undefined): string {
  if (profileId === null || profileId === undefined || profileId === '' || profileId === GENERAL_ID) return BASE_PARTITION
  return `${BASE_PARTITION}-${profileId.replace(/[^A-Za-z0-9_-]/g, '')}`
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

function toAccount(raw: unknown): ProfileAccount | null {
  if (raw === null || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o['id'] !== 'string' || o['id'] === '') return null
  return { id: o['id'], app: typeof o['app'] === 'string' ? o['app'] : '', label: typeof o['label'] === 'string' ? o['label'] : '' }
}

function uniqueAccounts(list: ProfileAccount[]): ProfileAccount[] {
  const seen = new Set<string>()
  return list.filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)))
}

function general(color: ProfileColor = 'graphite'): AgentProfileInfo {
  return { id: GENERAL_ID, name: GENERAL_PROFILE, color, accounts: [], learned: [], browser: '', general: true }
}

export type Outcome<T = undefined> = { ok: true; message: string; value: T } | { ok: false; message: string }

export class ProfileStore {
  private list: AgentProfileInfo[]
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly path: string | null,
    private readonly newId: () => string = () => `p${randomBytes(4).toString('hex')}`,
  ) {
    const raw = path === null ? null : readJson(path)
    const rows = Array.isArray(raw) ? raw : []
    const loaded: AgentProfileInfo[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const o = row as Record<string, unknown>
      const id = typeof o['id'] === 'string' ? o['id'] : ''
      const name = cleanName(typeof o['name'] === 'string' ? o['name'] : '')
      if (id === '' || name === '' || loaded.some((p) => p.id === id)) continue
      const color = isProfileColor(o['color']) ? o['color'] : this.colorFor(loaded)
      if (id === GENERAL_ID) {
        loaded.push(general(color))
        continue
      }
      const accounts = Array.isArray(o['accounts']) ? uniqueAccounts(o['accounts'].map(toAccount).filter((a): a is ProfileAccount => a !== null)) : []
      const learned = Array.isArray(o['learned']) ? [...new Set(o['learned'].filter((l): l is string => typeof l === 'string' && l !== ''))] : []
      loaded.push({ id, name, color, accounts, learned, browser: typeof o['browser'] === 'string' ? o['browser'] : '', general: false })
    }
    if (!loaded.some((p) => p.general)) loaded.unshift(general())
    this.list = [...loaded.filter((p) => p.general), ...loaded.filter((p) => !p.general)]
  }

  /** General first, then the rest in the order they were made. */
  all(): AgentProfileInfo[] {
    return this.list.map((p) => ({ ...p, accounts: p.accounts.map((a) => ({ ...a })), learned: [...p.learned] }))
  }

  general(): AgentProfileInfo {
    return this.all()[0] ?? general()
  }

  /** By id, or by name ignoring case. */
  find(ref: string | null | undefined): AgentProfileInfo | null {
    const wanted = (ref ?? '').trim()
    if (wanted === '') return null
    const hit = this.list.find((p) => p.id === wanted) ?? this.list.find((p) => p.name.toLowerCase() === wanted.toLowerCase())
    return hit === undefined ? null : { ...hit, accounts: hit.accounts.map((a) => ({ ...a })), learned: [...hit.learned] }
  }

  /** A colour no other profile has yet, so each is easy to tell apart at a glance. Graphite is General's. */
  nextColor(): ProfileColor {
    return this.colorFor(this.list)
  }

  private colorFor(list: AgentProfileInfo[]): ProfileColor {
    const free = PROFILE_COLORS.find((c) => c !== 'graphite' && !list.some((p) => p.color === c))
    if (free !== undefined) return free
    const pool = PROFILE_COLORS.filter((c) => c !== 'graphite')
    return pool[list.length % pool.length] ?? 'iris'
  }

  create(name: string, accounts: ProfileAccount[] = [], color?: ProfileColor, browser = '', learned: string[] = []): Outcome<AgentProfileInfo> {
    const clean = cleanName(name)
    if (clean === '') return { ok: false, message: 'Give the profile a name.' }
    const taken = this.find(clean)
    if (taken !== null && taken.name.toLowerCase() === clean.toLowerCase()) {
      return { ok: false, message: `There is already a profile called ${taken.name}.` }
    }
    if (this.list.length >= MAX_PROFILES) return { ok: false, message: `You can have up to ${MAX_PROFILES} profiles.` }
    const profile: AgentProfileInfo = {
      id: this.newId(),
      name: clean,
      color: color ?? this.nextColor(),
      accounts: uniqueAccounts(accounts),
      learned: [...new Set(learned)],
      browser: this.validBrowser(browser, null),
      general: false,
    }
    this.list = [...this.list, profile]
    this.persist()
    return { ok: true, message: `Made the profile ${clean}.`, value: { ...profile } }
  }

  update(id: string, patch: { name?: string; color?: ProfileColor; accounts?: ProfileAccount[]; learned?: string[]; browser?: string }): Outcome {
    const current = this.list.find((p) => p.id === id)
    if (current === undefined) return { ok: false, message: 'That profile is gone.' }
    let name = current.name
    if (patch.name !== undefined) {
      name = cleanName(patch.name)
      if (name === '') return { ok: false, message: 'Give the profile a name.' }
      if (current.general && name !== current.name) return { ok: false, message: `${GENERAL_PROFILE} keeps its name.` }
      if (this.list.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, message: `There is already a profile called ${name}.` }
      }
    }
    const next: AgentProfileInfo = {
      ...current,
      name,
      color: patch.color ?? current.color,
      // General never holds any of the person's accounts.
      accounts: current.general ? [] : patch.accounts === undefined ? current.accounts : uniqueAccounts(patch.accounts),
      learned: current.general ? [] : patch.learned === undefined ? current.learned : [...new Set(patch.learned)],
      browser: current.general ? '' : patch.browser === undefined ? current.browser : this.validBrowser(patch.browser, id),
    }
    this.list = this.list.map((p) => (p.id === id ? next : p))
    this.persist()
    return { ok: true, message: 'Saved.', value: undefined }
  }

  remove(id: string): boolean {
    const current = this.list.find((p) => p.id === id)
    if (current === undefined || current.general) return false
    // Profiles that borrowed its browser sign-ins go back to their own.
    this.list = this.list.filter((p) => p.id !== id).map((p) => (p.browser === id ? { ...p, browser: '' } : p))
    this.persist()
    return true
  }

  setMember(profileId: string, account: ProfileAccount, member: boolean): boolean {
    const current = this.list.find((p) => p.id === profileId)
    if (current === undefined || current.general) return false
    const rest = current.accounts.filter((a) => a.id !== account.id)
    this.list = this.list.map((p) => (p.id === profileId ? { ...p, accounts: member ? [...rest, { ...account }] : rest } : p))
    this.persist()
    return true
  }

  /** Lets a profile's helpers run a learned app, or takes it away. */
  setLearned(profileId: string, appId: string, member: boolean): boolean {
    const current = this.list.find((p) => p.id === profileId)
    if (current === undefined || current.general) return false
    const rest = current.learned.filter((id) => id !== appId)
    this.list = this.list.map((p) => (p.id === profileId ? { ...p, learned: member ? [...rest, appId] : rest } : p))
    this.persist()
    return true
  }

  /** A forgotten learned app leaves every profile. */
  forgetLearned(appId: string): void {
    if (!this.list.some((p) => p.learned.includes(appId))) return
    this.list = this.list.map((p) => ({ ...p, learned: p.learned.filter((id) => id !== appId) }))
    this.persist()
  }

  /** A disconnected account leaves every profile. */
  forgetAccount(accountId: string): void {
    if (!this.list.some((p) => p.accounts.some((a) => a.id === accountId))) return
    this.list = this.list.map((p) => ({ ...p, accounts: p.accounts.filter((a) => a.id !== accountId) }))
    this.persist()
  }

  profilesWith(accountId: string): AgentProfileInfo[] {
    return this.all().filter((p) => p.accounts.some((a) => a.id === accountId))
  }

  /** The partition whose sign-ins a profile's helpers browse with: its own, or the one it borrows. */
  partitionOf(profileId: string | null | undefined): string {
    let profile = this.find(profileId)
    if (profile === null) return BASE_PARTITION
    // Follow borrowed sign-ins a few steps at most, so a chain made by later edits still ends somewhere.
    for (let hop = 0; hop < 4 && profile.browser !== ''; hop += 1) {
      const lender = this.find(profile.browser)
      if (lender === null || lender.id === profile.id) break
      profile = lender
    }
    return partitionFor(profile.id)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** '' (its own), or another existing profile's id; a profile cannot borrow from one that borrows. */
  private validBrowser(browser: string, self: string | null): string {
    const wanted = browser.trim()
    if (wanted === '' || wanted === self) return ''
    const lender = this.list.find((p) => p.id === wanted)
    if (lender === undefined) return ''
    // Borrowing from a profile that itself borrows means the sign-ins it uses: one step, never a loop.
    const root = lender.browser === '' ? lender.id : lender.browser
    return root === self ? '' : root
  }

  private persist(): void {
    if (this.path !== null) {
      mkdirSync(dirname(this.path), { recursive: true })
      const temp = `${this.path}.tmp`
      writeFileSync(temp, JSON.stringify(this.list, null, 2), 'utf8')
      renameSync(temp, this.path)
    }
    for (const listener of this.listeners) listener()
  }
}
