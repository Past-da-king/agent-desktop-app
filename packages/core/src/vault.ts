/**
 * The Vault: passwords, logins, API keys and tokens the agent can USE without ever SEEING.
 *
 * An agent names an item (`{{vault:groq}}`, `{{vault:afrihost.password}}`, vault_fill, vault_login); the value is
 * put in at the last moment inside the app and every result that comes back has it taken out again. Only
 * vault_reveal hands a value to the model, and it asks the person first unless the item says it may be shown.
 *
 * What the window and every agent see is VaultItemMeta: names, kinds, hosts, which secret fields exist. Never values.
 */

export type VaultKind = 'login' | 'api_key' | 'token' | 'note' | 'passkey'

export const VAULT_KINDS: readonly VaultKind[] = ['login', 'api_key', 'token', 'note', 'passkey']

/** The secret field a bare `{{vault:ref}}` means, per kind. */
export const VAULT_DEFAULT_FIELD: Readonly<Record<VaultKind, string>> = {
  login: 'password',
  api_key: 'key',
  token: 'token',
  note: 'text',
  passkey: 'privateKey',
}

/** A field name: letters, digits, underscore and dash. */
export const VAULT_FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

/** A ref: the short unique handle placeholders use. Lower case, digits and dashes. */
export const VAULT_REF = /^[a-z0-9][a-z0-9-]{0,63}$/

/** `{{vault:ref}}` or `{{vault:ref.field}}`. The ref may also be the item's id or its exact name. */
export const VAULT_PLACEHOLDER = /\{\{\s*vault:([^{}]+?)\s*\}\}/g

export interface VaultItemMeta {
  id: string
  /** What the person calls it: "Groq API", "Afrihost ClientZone". */
  name: string
  /** Unique short handle for placeholders: groq-api. */
  ref: string
  kind: VaultKind
  /** Not secret: the login name, email or key id. */
  username: string
  /** Where it is used. Hosts are matched for vault_login. */
  url: string
  hosts: string[]
  /** Not secret: hints, password rules, which account it belongs to. */
  notes: string
  tags: string[]
  /** Only for this profile's agents, when set. */
  profile: string
  /** The secret fields that hold a value (names only). */
  fields: string[]
  /** An agent may see the value with vault_reveal without asking. Default false. */
  revealable: boolean
  /** A passkey: who it is for and which credential. None of this is secret; the private key is a field. */
  passkey?: VaultPasskey
  /** Where it came from, e.g. "A.O.S" for an imported item. */
  source: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
  useCount: number
  revealCount: number
}

export interface VaultPasskey {
  rpId: string
  /** base64 */
  credentialId: string
  /** base64 */
  userHandle: string
  signCount: number
}

/**
 * When the Vault asks the person. Asking is the default; each can be switched off, and dontAsk switches all asking
 * off at once (agents use the vault freely, typed passwords are saved without a prompt). Using a value without
 * showing it (placeholders, fill, sign in) never asks.
 */
export interface VaultPrefs {
  askReveal: boolean
  askPasskey: boolean
  offerSave: boolean
  dontAsk: boolean
  /** Sites (registrable domains) the person said never to offer saving for. */
  never: string[]
}

export const DEFAULT_VAULT_PREFS: VaultPrefs = { askReveal: true, askPasskey: true, offerSave: true, dontAsk: false, never: [] }

export interface VaultItemInput {
  id?: string
  name: string
  ref?: string
  kind?: VaultKind
  username?: string
  url?: string
  hosts?: string[]
  notes?: string
  tags?: string[]
  profile?: string
  /** Secret fields. A field left out keeps its value on an edit; a field set to '' is removed. */
  fields?: Record<string, string>
  revealable?: boolean
  source?: string
  passkey?: VaultPasskey
}

export interface VaultAuditEntry {
  at: number
  itemId: string
  name: string
  action: 'save' | 'delete' | 'reveal' | 'copy' | 'use' | 'import'
  who: string
}

export interface VaultImportResult {
  found: number
  imported: number
  updated: number
  skipped: number
  names: string[]
  /** Plain words when it could not read the folder. */
  error?: string
}

export interface VaultApi {
  list(): Promise<VaultItemMeta[]>
  save(input: VaultItemInput): Promise<VaultItemMeta>
  remove(id: string): Promise<void>
  /** The person's own click: the value of one field, shown in the window. Logged. */
  reveal(id: string, field?: string): Promise<string>
  /** Copies one field to the clipboard in the main process (cleared again after 30 s). Logged. */
  copy(id: string, field?: string): Promise<void>
  audit(limit?: number): Promise<VaultAuditEntry[]>
  /** Import an A.O.S credential vault: the folder holding its credentials.db and credentials.key. */
  importAos(folder?: string): Promise<VaultImportResult>
  prefs(): Promise<VaultPrefs>
  setPrefs(patch: Partial<VaultPrefs>): Promise<VaultPrefs>
  onChange(cb: () => void): () => void
}

/** A placeholder's ref and field, or null when it is not one. */
export function parseVaultRef(raw: string): { ref: string; field: string | null } {
  const text = raw.trim()
  const dot = text.lastIndexOf('.')
  if (dot > 0) {
    const field = text.slice(dot + 1)
    if (VAULT_FIELD_NAME.test(field)) return { ref: text.slice(0, dot).trim(), field }
  }
  return { ref: text, field: null }
}

/** A ref made from a name: "Groq API (console)" -> "groq-api-console". */
export function vaultRefOf(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return slug === '' ? 'item' : slug
}

/** Multi-part public suffixes common enough to matter (no full list: a near miss only widens a match to a sibling). */
const TWO_PART_SUFFIX = /^(?:co|com|net|org|gov|ac|edu|ltd|plc|nhs|me|mil|nom|or|ne|go|sch|info|biz|web)\.[a-z]{2}$/

/** The site a host belongs to, for matching logins: login.example.co.uk -> example.co.uk. */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/^\.+|\.+$/g, '')
  if (h === '' || /^[0-9.]+$/.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  if (parts.length <= 2) return h
  const lastTwo = parts.slice(-2).join('.')
  return TWO_PART_SUFFIX.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo
}

/** True when an item saved for these hosts belongs on this page host. */
export function hostMatches(itemHosts: readonly string[], pageHost: string): boolean {
  const site = registrableDomain(pageHost)
  return site !== '' && itemHosts.some((h) => registrableDomain(h) === site)
}
