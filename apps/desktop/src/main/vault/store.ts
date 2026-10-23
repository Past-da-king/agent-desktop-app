/**
 * The Vault store: every item, values and all, in ONE secret (`vault.secret`), encrypted the way the app keeps its
 * other keys (Electron safeStorage on a computer, the 0600 key file on a headless node). Nothing of it goes into the
 * synced rows table: a brain gets the whole vault in the state bundle, over the device link (devices/bundle.ts).
 *
 * Only this module and the vault guard ever hold a value. meta() and list() never carry one.
 */
import { randomBytes } from 'node:crypto'

import {
  DEFAULT_VAULT_PREFS,
  VAULT_DEFAULT_FIELD,
  VAULT_FIELD_NAME,
  VAULT_KINDS,
  VAULT_REF,
  parseVaultRef,
  hostMatches,
  registrableDomain,
  vaultRefOf,
  type VaultAuditEntry,
  type VaultItemInput,
  type VaultItemMeta,
  type VaultKind,
  type VaultPasskey,
  type VaultPrefs,
} from '@agent/core'

export const VAULT_SECRET = 'vault'
const MAX_ITEMS = 5_000
const MAX_VALUE = 20_000
const MAX_AUDIT = 300
/** Values shorter than this are not scrubbed out of text: too likely to be ordinary words or numbers. */
export const MIN_REDACT = 6

export interface SecretsLike {
  get(name: string): string | null
  set(name: string, value: string): void
  delete(name: string): void
}

/** One item as stored (inside the encrypted file only). */
export interface VaultRecord extends Omit<VaultItemMeta, 'fields'> {
  values: Record<string, string>
}

interface VaultFile {
  v: 1
  items: VaultRecord[]
  audit: VaultAuditEntry[]
  /** When the vault last changed, for the bundle (newest wins). */
  changedAt: number
  prefs: VaultPrefs
}

/** A placeholder resolved: the item, the field and the value. */
export interface VaultHit {
  item: VaultRecord
  field: string
  value: string
}

export class VaultStore {
  private cache: VaultFile | null = null
  private readonly listeners = new Set<() => void>()
  private redactList: Array<{ needle: string; label: string }> | null = null

  constructor(
    private readonly secrets: SecretsLike,
    private readonly now: () => number = Date.now,
  ) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Every item without values, sorted by name. */
  list(profile?: string): VaultItemMeta[] {
    return this.file()
      .items.filter((item) => profile === undefined || item.profile === '' || item.profile === profile)
      .map(toMeta)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(id: string): VaultItemMeta | null {
    const item = this.file().items.find((entry) => entry.id === id)
    return item === undefined ? null : toMeta(item)
  }

  count(): number {
    return this.file().items.length
  }

  /** Add or change one item. A field left out of `fields` keeps its value; one set to '' is removed. */
  save(input: VaultItemInput, who = 'person'): VaultItemMeta {
    const file = this.file()
    const name = clean(input.name, 200)
    if (name === '') throw new Error('An item needs a name.')
    const existing = input.id === undefined ? undefined : file.items.find((item) => item.id === input.id)
    if (input.id !== undefined && input.id !== '' && existing === undefined) throw new Error('There is no such vault item.')
    if (existing === undefined && file.items.length >= MAX_ITEMS) throw new Error('The vault is full.')
    const kind: VaultKind = VAULT_KINDS.includes(input.kind as VaultKind) ? (input.kind as VaultKind) : (existing?.kind ?? 'login')

    const values: Record<string, string> = { ...(existing?.values ?? {}) }
    for (const [field, value] of Object.entries(input.fields ?? {})) {
      if (!VAULT_FIELD_NAME.test(field)) throw new Error(`"${field}" is not a field name (letters, digits, _ and -).`)
      if (typeof value !== 'string') continue
      if (value.length > MAX_VALUE) throw new Error('That value is too long.')
      if (value === '') delete values[field]
      else values[field] = value
    }

    const wantedRef = clean(input.ref ?? '', 64).toLowerCase()
    const ref = this.uniqueRef(wantedRef !== '' && VAULT_REF.test(wantedRef) ? wantedRef : existing?.ref ?? vaultRefOf(name), existing?.id)
    const url = clean(input.url ?? existing?.url ?? '', 2_000)
    const hosts = input.hosts !== undefined ? cleanList(input.hosts).map((h) => h.toLowerCase()) : existing?.hosts ?? hostsOf(url)
    const ts = this.now()
    const record: VaultRecord = {
      id: existing?.id ?? `v_${randomBytes(6).toString('hex')}`,
      name,
      ref,
      kind,
      username: clean(input.username ?? existing?.username ?? '', 500),
      url,
      hosts: hosts.length === 0 ? hostsOf(url) : hosts,
      notes: clean(input.notes ?? existing?.notes ?? '', 4_000),
      tags: input.tags !== undefined ? cleanList(input.tags) : existing?.tags ?? [],
      profile: clean(input.profile ?? existing?.profile ?? '', 100),
      values,
      revealable: input.revealable ?? existing?.revealable ?? false,
      source: clean(input.source ?? existing?.source ?? '', 100),
      ...(input.passkey !== undefined ? { passkey: passkeyOf(input.passkey) ?? undefined } : existing?.passkey !== undefined ? { passkey: existing.passkey } : {}),
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
      lastUsedAt: existing?.lastUsedAt ?? 0,
      useCount: existing?.useCount ?? 0,
      revealCount: existing?.revealCount ?? 0,
    }
    const items = existing === undefined ? [...file.items, record] : file.items.map((item) => (item.id === record.id ? record : item))
    this.write({ ...file, items }, { at: ts, itemId: record.id, name: record.name, action: 'save', who })
    return toMeta(record)
  }

  remove(id: string, who = 'person'): boolean {
    const file = this.file()
    const item = file.items.find((entry) => entry.id === id)
    if (item === undefined) return false
    this.write({ ...file, items: file.items.filter((entry) => entry.id !== id) }, { at: this.now(), itemId: id, name: item.name, action: 'delete', who })
    return true
  }

  /**
   * Find an item by ref, id or exact name (any case), then by a single partial match on name or ref. With
   * `ref.field` the field is split off when the whole text is not an item.
   */
  find(text: string, profile?: string): { item: VaultRecord; field: string | null } | { error: string } {
    const whole = this.lookup(text.trim(), profile)
    if (whole !== null) return { item: whole, field: null }
    const parsed = parseVaultRef(text)
    if (parsed.field !== null) {
      const item = this.lookup(parsed.ref, profile)
      if (item !== null) return { item, field: parsed.field }
    }
    const q = text.trim().toLowerCase()
    const near = this.visible(profile).filter((item) => item.name.toLowerCase().includes(q) || item.ref.includes(q))
    if (near.length === 1) return { item: near[0]!, field: null }
    if (near.length > 1) return { error: `"${text}" matches ${near.length} vault items: ${near.slice(0, 8).map((i) => i.ref).join(', ')}. Use the ref.` }
    return { error: `There is no vault item "${text}". vault_list shows what is there.` }
  }

  /** The value a placeholder or tool means. The value never leaves the app's own process. */
  resolve(text: string, field?: string, profile?: string): VaultHit | { error: string } {
    const found = this.find(text, profile)
    if ('error' in found) return found
    const item = found.item
    const want = field ?? found.field ?? VAULT_DEFAULT_FIELD[item.kind]
    let value = item.values[want]
    // A bare ref on an item whose only value has another name: use that one.
    if (value === undefined && field === undefined && found.field === null) {
      const names = Object.keys(item.values)
      if (names.length === 1) return { item, field: names[0]!, value: item.values[names[0]!]! }
    }
    if (value === undefined && want === 'username' && item.username !== '') value = item.username
    if (value === undefined) {
      const names = Object.keys(item.values)
      return { error: `"${item.ref}" has no field "${want}"${names.length === 0 ? '' : `; it has ${names.join(', ')}`}.` }
    }
    return { item, field: want, value }
  }

  /** Count one use (placeholder, fill, login), without a write for every call within a minute. */
  markUsed(itemId: string): void {
    const file = this.file()
    const item = file.items.find((entry) => entry.id === itemId)
    if (item === undefined) return
    const ts = this.now()
    const recent = ts - item.lastUsedAt < 60_000
    item.useCount += 1
    item.lastUsedAt = ts
    if (!recent) this.persist(file)
  }

  /** Record a reveal or a copy (the audit trail). */
  log(itemId: string, action: VaultAuditEntry['action'], who: string): void {
    const file = this.file()
    const item = file.items.find((entry) => entry.id === itemId)
    if (item === undefined) return
    if (action === 'reveal') item.revealCount += 1
    this.write(file, { at: this.now(), itemId, name: item.name, action, who }, false)
  }

  audit(limit = 100): VaultAuditEntry[] {
    return this.file().audit.slice(-Math.max(1, Math.min(MAX_AUDIT, limit))).reverse()
  }

  /**
   * Every value to scrub out of text, with the label it becomes, longest first (so a value that contains another is
   * taken out whole). Also its JSON-escaped, URL-encoded and base64 forms.
   */
  redactions(): ReadonlyArray<{ needle: string; label: string }> {
    if (this.redactList !== null) return this.redactList
    const out = new Map<string, string>()
    for (const item of this.file().items) {
      for (const [field, value] of Object.entries(item.values)) {
        if (value.length < MIN_REDACT) continue
        const label = `[vault:${item.ref}${field === VAULT_DEFAULT_FIELD[item.kind] ? '' : `.${field}`}]`
        for (const form of formsOf(value)) if (form.length >= MIN_REDACT && !out.has(form)) out.set(form, label)
      }
    }
    this.redactList = [...out.entries()].map(([needle, label]) => ({ needle, label })).sort((a, b) => b.needle.length - a.needle.length)
    return this.redactList
  }

  /** Take every vault value out of a text. */
  redact(text: string): string {
    if (text === '') return text
    let result = text
    for (const { needle, label } of this.redactions()) if (result.includes(needle)) result = result.split(needle).join(label)
    return result
  }

  // ---- prefs, sites and passkeys ----

  prefs(): VaultPrefs {
    const p = this.file().prefs
    return { ...p, never: [...p.never] }
  }

  setPrefs(patch: Partial<VaultPrefs>, who = 'person'): VaultPrefs {
    const file = this.file()
    const next = prefsOf({ ...file.prefs, ...patch })
    this.write({ ...file, prefs: next }, { at: this.now(), itemId: '', name: 'Vault settings', action: 'save', who })
    return this.prefs()
  }

  /** Whether to ask before an agent sees a value, or before a passkey is used. */
  asks(what: 'reveal' | 'passkey'): boolean {
    const p = this.file().prefs
    if (p.dontAsk) return false
    return what === 'reveal' ? p.askReveal : p.askPasskey
  }

  /** Logins for a page host (same site), newest first. */
  loginsFor(host: string, profile?: string): VaultRecord[] {
    return this.visible(profile)
      .filter((item) => item.kind === 'login' && hostMatches(item.hosts, host))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.updatedAt - a.updatedAt)
  }

  record(id: string): VaultRecord | null {
    return this.file().items.find((item) => item.id === id) ?? null
  }

  /** Passkeys for a relying party id. */
  passkeysFor(rpId: string): VaultRecord[] {
    const rp = rpId.toLowerCase()
    return this.file().items.filter((item) => item.kind === 'passkey' && item.passkey !== undefined && item.passkey.rpId.toLowerCase() === rp && item.values['privateKey'] !== undefined)
  }

  /** A passkey the browser just made, or a newer sign count for one we have. */
  savePasskey(input: { rpId: string; rpName?: string; userName?: string; credentialId: string; userHandle: string; signCount: number; privateKey: string }, who: string): VaultItemMeta {
    const existing = this.file().items.find((item) => item.kind === 'passkey' && item.passkey?.credentialId === input.credentialId)
    const passkey: VaultPasskey = { rpId: input.rpId, credentialId: input.credentialId, userHandle: input.userHandle, signCount: input.signCount }
    if (existing !== undefined) {
      // A sign-in: only the sign count moves. Logged as a use, and still a change, so the other brains get it.
      const file = this.file()
      const items = file.items.map((item) => (item.id === existing.id ? { ...item, passkey, lastUsedAt: this.now(), useCount: item.useCount + 1 } : item))
      this.write({ ...file, items }, { at: this.now(), itemId: existing.id, name: existing.name, action: 'use', who })
      return toMeta(items.find((item) => item.id === existing.id)!)
    }
    const site = input.rpName !== undefined && input.rpName.trim() !== '' ? input.rpName.trim() : input.rpId
    return this.save({ name: `${site} passkey`, kind: 'passkey', username: input.userName ?? '', url: `https://${input.rpId}`, hosts: [input.rpId], passkey, source: 'browser', fields: { privateKey: input.privateKey } }, who)
  }

  /** Never offer to save passwords on this site again. */
  never(host: string): void {
    const site = registrableDomain(host)
    const p = this.prefs()
    if (site === '' || p.never.includes(site)) return
    this.setPrefs({ never: [...p.never, site] })
  }

  // ---- the bundle (devices) ----

  changedAt(): number {
    return this.file().changedAt
  }

  /** The whole vault for another brain (values included: only ever sent to a brain, over the device link). */
  exportAll(): { changedAt: number; items: VaultRecord[]; prefs: VaultPrefs } {
    const file = this.file()
    // Use counters are this device's own: left out, so using a key is not a change to send to every brain.
    return { changedAt: file.changedAt, items: file.items.map((item) => ({ ...item, values: { ...item.values }, lastUsedAt: 0, useCount: 0, revealCount: 0 })), prefs: { ...file.prefs, never: [...file.prefs.never] } }
  }

  /** Take another brain's vault when it is newer. True when it was taken. */
  replaceAll(incoming: { changedAt: number; items: unknown[]; prefs?: unknown }, force = false): boolean {
    const file = this.file()
    if (!force && !(incoming.changedAt > file.changedAt)) return false
    const mine = new Map(file.items.map((item) => [item.id, item]))
    const items = incoming.items
      .map(recordOf)
      .filter((item): item is VaultRecord => item !== null)
      .map((item) => {
        const own = mine.get(item.id)
        return own === undefined ? item : { ...item, lastUsedAt: own.lastUsedAt, useCount: own.useCount, revealCount: own.revealCount }
      })
    this.cache = { v: 1, items, audit: file.audit, changedAt: incoming.changedAt, prefs: incoming.prefs === undefined ? file.prefs : prefsOf(incoming.prefs) }
    this.persist(this.cache)
    this.changed()
    return true
  }

  // ---- inside ----

  private visible(profile?: string): VaultRecord[] {
    return this.file().items.filter((item) => profile === undefined || item.profile === '' || item.profile === profile)
  }

  private lookup(text: string, profile?: string): VaultRecord | null {
    if (text === '') return null
    const q = text.toLowerCase()
    const items = this.visible(profile)
    return items.find((item) => item.ref === q) ?? items.find((item) => item.id === text) ?? oneOf(items.filter((item) => item.name.toLowerCase() === q))
  }

  private uniqueRef(base: string, selfId: string | undefined): string {
    const taken = new Set(this.file().items.filter((item) => item.id !== selfId).map((item) => item.ref))
    if (!taken.has(base)) return base
    for (let n = 2; n < 10_000; n += 1) {
      const candidate = `${base.slice(0, 60)}-${n}`
      if (!taken.has(candidate)) return candidate
    }
    return `${base.slice(0, 50)}-${randomBytes(3).toString('hex')}`
  }

  private file(): VaultFile {
    if (this.cache !== null) return this.cache
    const raw = this.secrets.get(VAULT_SECRET)
    let parsed: VaultFile = { v: 1, items: [], audit: [], changedAt: 0, prefs: { ...DEFAULT_VAULT_PREFS } }
    if (raw !== null && raw.trim() !== '') {
      const data = JSON.parse(raw) as Partial<VaultFile>
      parsed = {
        v: 1,
        items: Array.isArray(data.items) ? data.items.map(recordOf).filter((item): item is VaultRecord => item !== null) : [],
        audit: Array.isArray(data.audit) ? data.audit.slice(-MAX_AUDIT) : [],
        changedAt: typeof data.changedAt === 'number' ? data.changedAt : 0,
        prefs: prefsOf(data.prefs),
      }
    }
    this.cache = parsed
    return parsed
  }

  private write(file: VaultFile, entry: VaultAuditEntry, contentChanged = true): void {
    const next: VaultFile = { ...file, audit: [...file.audit, entry].slice(-MAX_AUDIT), changedAt: contentChanged ? Math.max(this.now(), file.changedAt + 1) : file.changedAt }
    this.cache = next
    this.persist(next)
    if (contentChanged) this.changed()
  }

  private persist(file: VaultFile): void {
    this.secrets.set(VAULT_SECRET, JSON.stringify(file))
  }

  private changed(): void {
    this.redactList = null
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // One listener failing must not stop the others.
      }
    }
  }
}

function toMeta(item: VaultRecord): VaultItemMeta {
  const { values, ...rest } = item
  return { ...rest, hosts: [...item.hosts], tags: [...item.tags], fields: Object.keys(values) }
}

function oneOf<T>(list: T[]): T | null {
  return list.length === 1 ? list[0]! : null
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function cleanList(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return [...new Set(list.map((entry) => clean(entry, 100)).filter((entry) => entry !== ''))].slice(0, 30)
}

/** The host names in a url-ish text: "https://my.site.com/login (old)" -> ["my.site.com"]. */
export function hostsOf(url: string): string[] {
  const out: string[] = []
  for (const match of url.matchAll(/(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})/gi)) {
    const host = match[1]!.toLowerCase()
    if (!out.includes(host)) out.push(host)
  }
  return out.slice(0, 10)
}

function formsOf(value: string): string[] {
  const forms = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value, 'utf8').toString('base64')]
  // base64 without its padding, as it sits inside a longer encoded string
  forms.push(forms[3]!.replace(/=+$/, ''))
  return [...new Set(forms)]
}

function recordOf(raw: unknown): VaultRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['id'] !== 'string' || typeof r['name'] !== 'string') return null
  const values: Record<string, string> = {}
  if (typeof r['values'] === 'object' && r['values'] !== null) {
    for (const [k, v] of Object.entries(r['values'] as Record<string, unknown>)) if (typeof v === 'string' && VAULT_FIELD_NAME.test(k)) values[k] = v
  }
  const str = (key: string): string => (typeof r[key] === 'string' ? (r[key] as string) : '')
  const num = (key: string): number => (typeof r[key] === 'number' ? (r[key] as number) : 0)
  const kind = VAULT_KINDS.includes(r['kind'] as VaultKind) ? (r['kind'] as VaultKind) : 'login'
  return {
    id: r['id'],
    name: r['name'],
    ref: VAULT_REF.test(str('ref')) ? str('ref') : vaultRefOf(r['name']),
    kind,
    username: str('username'),
    url: str('url'),
    hosts: cleanList(r['hosts']),
    notes: str('notes'),
    tags: cleanList(r['tags']),
    profile: str('profile'),
    values,
    revealable: r['revealable'] === true,
    ...(passkeyOf(r['passkey']) === null ? {} : { passkey: passkeyOf(r['passkey'])! }),
    source: str('source'),
    createdAt: num('createdAt'),
    updatedAt: num('updatedAt'),
    lastUsedAt: num('lastUsedAt'),
    useCount: num('useCount'),
    revealCount: num('revealCount'),
  }
}

function passkeyOf(raw: unknown): VaultPasskey | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['rpId'] !== 'string' || typeof r['credentialId'] !== 'string') return null
  return {
    rpId: r['rpId'],
    credentialId: r['credentialId'],
    userHandle: typeof r['userHandle'] === 'string' ? r['userHandle'] : '',
    signCount: typeof r['signCount'] === 'number' ? r['signCount'] : 0,
  }
}

function prefsOf(raw: unknown): VaultPrefs {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const flag = (key: keyof VaultPrefs): boolean => (typeof r[key] === 'boolean' ? (r[key] as boolean) : (DEFAULT_VAULT_PREFS[key] as boolean))
  return {
    askReveal: flag('askReveal'),
    askPasskey: flag('askPasskey'),
    offerSave: flag('offerSave'),
    dontAsk: flag('dontAsk'),
    never: Array.isArray(r['never']) ? [...new Set((r['never'] as unknown[]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase()))].slice(0, 500) : [],
  }
}
