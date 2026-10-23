/**
 * Import passwords and keys from a file another password manager or browser exported:
 *  - Chrome or Edge passwords CSV: name,url,username,password(,note)
 *  - Bitwarden CSV (folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp)
 *  - Bitwarden JSON, the unencrypted export ({ encrypted: false, items: [...] })
 *  - 1Password CSV (Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes; older exports too)
 *  - a plain JSON file of name and value pairs: { "Groq API": "gsk_..." } or [{ name, value, username?, url?, kind?, notes?, tags? }]
 *
 * An item that matches one already in the vault (same site and username; without a site, same name and username) is
 * updated, not added twice. Nothing here logs or returns a value: only counts and names come back.
 */
import { readFileSync, statSync } from 'node:fs'

import { VAULT_DEFAULT_FIELD, VAULT_FIELD_NAME, VAULT_KINDS, registrableDomain, vaultRefOf, type VaultImportResult, type VaultItemInput, type VaultItemMeta, type VaultKind } from '@agent/core'

import type { VaultStore } from './store'

/** The largest file the import reads. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024

/** One item read from a file, before it is saved. */
export interface ImportedItem {
  name: string
  kind: VaultKind
  username: string
  url: string
  notes: string
  tags: string[]
  /** Secret fields: { password }, { key }, { token }, { text }, plus extras such as totp. */
  fields: Record<string, string>
}

export interface ParsedImport {
  format: string
  items: ImportedItem[]
  /** Rows that were read but carry nothing to keep (no value, or a kind the vault does not hold). */
  skipped: number
}

/** Read a file's text into items. Throws plain words when it is not a format the vault knows. */
export function parseImport(text: string, fileName = ''): ParsedImport {
  const body = text.replace(/^﻿/, '')
  const trimmed = body.trim()
  if (trimmed === '') throw new Error('The file is empty.')
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[') || /\.json$/i.test(fileName)
  if (looksJson) {
    let data: unknown
    try {
      data = JSON.parse(trimmed)
    } catch {
      throw new Error('The file is not valid JSON.')
    }
    return parseJson(data)
  }
  return parseCsv(body)
}

/** Read a file from disk and import it. */
export function importFile(vault: VaultStore, path: string, who = 'person'): VaultImportResult {
  const empty: VaultImportResult = { found: 0, imported: 0, updated: 0, skipped: 0, names: [] }
  const clean = typeof path === 'string' ? path.trim().replace(/^"(.*)"$/, '$1') : ''
  if (clean === '') return { ...empty, error: 'Name the file to import.' }
  let size = 0
  try {
    size = statSync(clean).size
  } catch {
    return { ...empty, error: 'I could not find that file.' }
  }
  if (size > MAX_IMPORT_BYTES) return { ...empty, error: 'That file is too big to be a password export.' }
  return importText(vault, readFileSync(clean, 'utf8'), clean.split(/[\\/]/).pop() ?? '', who)
}

/** Import a file's text: parse it, then add or update each item. */
export function importText(vault: VaultStore, text: string, fileName = '', who = 'person'): VaultImportResult {
  const empty: VaultImportResult = { found: 0, imported: 0, updated: 0, skipped: 0, names: [] }
  if (typeof text !== 'string') return { ...empty, error: 'That is not a file.' }
  if (text.length > MAX_IMPORT_BYTES) return { ...empty, error: 'That file is too big to be a password export.' }
  let parsed: ParsedImport
  try {
    parsed = parseImport(text, fileName)
  } catch (cause) {
    return { ...empty, error: cause instanceof Error ? cause.message : 'I could not read that file.' }
  }
  return saveImported(vault, parsed, who)
}

/**
 * Add or update every item. A login matches one already in the vault with the same site and username; a key, token
 * or note matches the same name, username and kind. Each item already there is matched at most once per import (the
 * one with the same name first), so two rows of one file for the same site and username stay two items, and the
 * same file imported again updates each of them in place.
 */
export function saveImported(vault: VaultStore, parsed: ParsedImport, who = 'person'): VaultImportResult {
  const result: VaultImportResult = { found: parsed.items.length + parsed.skipped, imported: 0, updated: 0, skipped: parsed.skipped, names: [], format: parsed.format }
  const nameCount = new Map<string, number>()
  for (const item of parsed.items) nameCount.set(item.name.toLowerCase(), (nameCount.get(item.name.toLowerCase()) ?? 0) + 1)
  const before = vault.list()
  const used = new Set<string>()
  for (const item of parsed.items) {
    const key = matchKeyOf(item)
    const candidates = before.filter((other) => !used.has(other.id) && matchKey(other) === key)
    const match = candidates.find((other) => other.name.trim().toLowerCase() === item.name.trim().toLowerCase()) ?? candidates[0]
    const user = item.username.trim()
    const shared = (nameCount.get(item.name.toLowerCase()) ?? 0) > 1
    const input: VaultItemInput = {
      ...(match === undefined ? {} : { id: match.id }),
      name: item.name,
      ...(match === undefined && shared && user !== '' ? { ref: `${vaultRefOf(item.name).slice(0, 40).replace(/-+$/, '')}-${vaultRefOf(user.split('@')[0] ?? user).slice(0, 22)}` } : {}),
      kind: item.kind,
      username: user,
      url: item.url,
      notes: item.notes,
      tags: match === undefined ? item.tags : [...new Set([...match.tags, ...item.tags])],
      source: parsed.format,
      fields: item.fields,
    }
    try {
      const saved = vault.save(input, who)
      used.add(saved.id)
      if (match === undefined) result.imported += 1
      else result.updated += 1
      result.names.push(item.name)
    } catch {
      result.skipped += 1
    }
  }
  return result
}

function siteOfUrl(url: string): string {
  const text = url.trim()
  if (text === '') return ''
  if (/^android:/i.test(text)) return ''
  // The host at the start, also when the field holds more than a URL ("https://mail.tm (API at api.mail.tm)").
  const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+|localhost)(?=[:/\s?#]|$)/i.exec(text)
  return host === null ? '' : registrableDomain(host[1]!.toLowerCase())
}

function keyOf(kind: VaultKind, name: string, site: string, username: string): string {
  const user = username.trim().toLowerCase()
  if (kind === 'login' && site !== '') return `login|${site}|${user}`
  return `${kind}|name:${name.trim().toLowerCase()}|${user}`
}

function matchKeyOf(item: ImportedItem): string {
  return keyOf(item.kind, item.name, siteOfUrl(item.url), item.username)
}

function matchKey(item: VaultItemMeta): string {
  // The same reading of the URL as for an imported row, so a file imported again matches what it added.
  const site = siteOfUrl(item.url) || (item.hosts[0] !== undefined ? registrableDomain(item.hosts[0]) : '')
  return keyOf(item.kind, item.name, site, item.username)
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
}

/** A name for an item without one: the site, else "Imported item". */
function nameFor(name: string, url: string, username: string): string {
  const n = name.trim()
  if (n !== '') return n
  const site = siteOfUrl(url)
  if (site !== '') return site
  return username.trim() !== '' ? username.trim() : 'Imported item'
}

function fieldName(raw: string): string | null {
  const name = raw.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^[^A-Za-z]+/, '').slice(0, 32)
  return name !== '' && VAULT_FIELD_NAME.test(name) ? name : null
}

function login(name: string, url: string, username: string, password: string, notes: string, extra: Record<string, string> = {}, tags: string[] = []): ImportedItem | null {
  const fields: Record<string, string> = {}
  if (password !== '') fields['password'] = password
  for (const [key, value] of Object.entries(extra)) if (value !== '' && key !== 'password') fields[key] = value
  if (Object.keys(fields).length === 0) return null
  // "forum.test" (1Password's older Website column) is a site too.
  const site = url.trim()
  const full = site !== '' && !/^[a-z][a-z0-9+.-]*:/i.test(site) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?(\/.*)?$/i.test(site) ? `https://${site}` : site
  return { name: nameFor(name, full, username), kind: 'login', username: username.trim(), url: full, notes: notes.trim(), tags, fields }
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF or LF. */
export function readCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

const COLUMN: Record<string, string[]> = {
  name: ['name', 'title', 'account', 'item'],
  url: ['url', 'login_uri', 'website', 'web site', 'login url', 'uri', 'urls', 'origin'],
  username: ['username', 'login_username', 'user', 'user name', 'email', 'login', 'login name'],
  password: ['password', 'login_password', 'pass'],
  notes: ['note', 'notes', 'extra', 'comment', 'comments'],
  totp: ['login_totp', 'otpauth', 'totp', 'one-time password', 'otp'],
  type: ['type'],
  tags: ['tags', 'folder', 'grouping'],
  fields: ['fields'],
}

function parseCsv(text: string): ParsedImport {
  const rows = readCsv(text)
  if (rows.length === 0) throw new Error('The file is empty.')
  const header = rows[0]!.map((h) => h.trim().toLowerCase())
  const at = (key: string): number => {
    for (const alias of COLUMN[key] ?? []) {
      const index = header.indexOf(alias)
      if (index >= 0) return index
    }
    return -1
  }
  const col = Object.fromEntries(Object.keys(COLUMN).map((key) => [key, at(key)])) as Record<keyof typeof COLUMN, number>
  if ((col['password'] ?? -1) < 0 && (col['notes'] ?? -1) < 0) {
    throw new Error('I do not know this file. Export passwords as CSV from Chrome, Edge, Bitwarden or 1Password, or use a JSON file of names and values.')
  }
  const format = header.includes('login_uri') || header.includes('login_password') ? 'Bitwarden' : header.includes('otpauth') || header.includes('title') ? '1Password' : 'Chrome or Edge'
  const items: ImportedItem[] = []
  let skipped = 0
  for (const row of rows.slice(1)) {
    const cell = (key: string): string => {
      const index = col[key] ?? -1
      return index >= 0 ? (row[index] ?? '') : ''
    }
    const type = cell('type').trim().toLowerCase()
    const name = cell('name')
    const notes = cell('notes')
    const tags = cell('tags')
      .split(/[,;]/)
      .map((t) => t.trim())
      .filter((t) => t !== '')
    if (type === 'note' || type === 'securenote' || type === 'secure note') {
      if (notes.trim() === '') skipped += 1
      else items.push({ name: nameFor(name, '', ''), kind: 'note', username: '', url: '', notes: '', tags, fields: { text: notes } })
      continue
    }
    if (type !== '' && type !== 'login' && format === 'Bitwarden') {
      skipped += 1
      continue
    }
    const url = cell('url').split(/[\n,]/)[0] ?? ''
    const extra: Record<string, string> = {}
    if (cell('totp').trim() !== '') extra['totp'] = cell('totp').trim()
    // Bitwarden custom fields: "name: value" lines.
    for (const line of cell('fields').split(/\r?\n/)) {
      const colon = line.indexOf(': ')
      if (colon <= 0) continue
      const key = fieldName(line.slice(0, colon))
      if (key !== null && line.slice(colon + 2) !== '') extra[key] = line.slice(colon + 2)
    }
    const item = login(name, url, cell('username'), cell('password'), notes, extra, tags)
    if (item === null) skipped += 1
    else items.push(item)
  }
  return { format, items, skipped }
}

// ---------------------------------------------------------------- JSON

interface BitwardenItem {
  type?: number
  name?: string
  notes?: string | null
  folderId?: string | null
  login?: { username?: string | null; password?: string | null; totp?: string | null; uris?: Array<{ uri?: string | null }> | null } | null
  fields?: Array<{ name?: string | null; value?: string | null; type?: number }> | null
}

function parseJson(data: unknown): ParsedImport {
  if (typeof data === 'object' && data !== null && !Array.isArray(data) && Array.isArray((data as { items?: unknown }).items) && ('encrypted' in data || 'folders' in data)) {
    return parseBitwarden(data as { encrypted?: boolean; items: BitwardenItem[]; folders?: Array<{ id: string; name: string }> })
  }
  if (typeof data === 'object' && data !== null && (data as { encrypted?: unknown }).encrypted === true) {
    throw new Error('That Bitwarden export is encrypted. Export it again as "JSON" (not encrypted), import it, then delete the file.')
  }
  return parsePlain(data)
}

function parseBitwarden(data: { encrypted?: boolean; items: BitwardenItem[]; folders?: Array<{ id: string; name: string }> }): ParsedImport {
  if (data.encrypted === true) throw new Error('That Bitwarden export is encrypted. Export it again as "JSON" (not encrypted), import it, then delete the file.')
  const folders = new Map((data.folders ?? []).map((f) => [f.id, f.name]))
  const items: ImportedItem[] = []
  let skipped = 0
  for (const entry of data.items) {
    if (typeof entry !== 'object' || entry === null) {
      skipped += 1
      continue
    }
    const tags = entry.folderId ? [folders.get(entry.folderId) ?? ''].filter((t) => t !== '') : []
    const extra: Record<string, string> = {}
    for (const field of entry.fields ?? []) {
      const key = fieldName(str(field?.name))
      if (key !== null && str(field?.value) !== '') extra[key] = str(field?.value)
    }
    if (entry.type === 2) {
      const text = str(entry.notes)
      if (text.trim() === '') skipped += 1
      else items.push({ name: nameFor(str(entry.name), '', ''), kind: 'note', username: '', url: '', notes: '', tags, fields: { text, ...extra } })
      continue
    }
    if (entry.type !== 1 && entry.type !== undefined) {
      skipped += 1
      continue
    }
    const l = entry.login ?? {}
    if (str(l.totp) !== '') extra['totp'] = str(l.totp)
    const item = login(str(entry.name), str(l.uris?.[0]?.uri), str(l.username), str(l.password), str(entry.notes), extra, tags)
    if (item === null) skipped += 1
    else items.push(item)
  }
  return { format: 'Bitwarden', items, skipped }
}

/**
 * { "Name": "value" }, [{ name, value | password | key | token | text | fields, username?, url?, kind?, notes?, tags? }]
 * or { source?, items: [the same] }.
 */
function parsePlain(data: unknown): ParsedImport {
  const items: ImportedItem[] = []
  let skipped = 0
  const list: unknown[] = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null
      ? Array.isArray((data as { items?: unknown }).items)
        ? ((data as { items: unknown[] }).items)
        : Object.entries(data as Record<string, unknown>).map(([name, value]) => (typeof value === 'object' && value !== null ? { name, ...(value as object) } : { name, value }))
      : []
  if (list.length === 0) throw new Error('There is nothing to import in that file.')
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) {
      skipped += 1
      continue
    }
    const entry = raw as Record<string, unknown>
    const name = str(entry['name'] ?? entry['title'])
    const username = str(entry['username'] ?? entry['user'] ?? entry['login'] ?? entry['email'])
    const url = str(entry['url'] ?? entry['website'] ?? entry['uri'])
    const wanted = str(entry['kind'] ?? entry['type']).toLowerCase().replace(/[\s-]+/g, '_')
    const fields: Record<string, string> = {}
    if (typeof entry['fields'] === 'object' && entry['fields'] !== null && !Array.isArray(entry['fields'])) {
      for (const [key, value] of Object.entries(entry['fields'] as Record<string, unknown>)) {
        const k = fieldName(key)
        if (k !== null && str(value) !== '') fields[k] = str(value)
      }
    }
    for (const key of ['password', 'key', 'token', 'text', 'secret', 'value']) {
      const value = str(entry[key])
      if (value !== '' && fields[key] === undefined) fields[key] = value
    }
    let kind: VaultKind = VAULT_KINDS.includes(wanted as VaultKind) && wanted !== 'passkey' ? (wanted as VaultKind) : wanted === 'password' ? 'login' : wanted === 'api_key' || wanted === 'apikey' ? 'api_key' : wanted === 'ssh_key' ? 'note' : fields['password'] !== undefined || username !== '' ? 'login' : fields['token'] !== undefined ? 'token' : fields['text'] !== undefined ? 'note' : 'api_key'
    if (wanted === 'note' || wanted === 'ssh_key') kind = 'note'
    // A bare value or secret goes in the kind's main field.
    const main = VAULT_DEFAULT_FIELD[kind]
    for (const loose of ['value', 'secret']) {
      if (fields[loose] !== undefined) {
        if (fields[main] === undefined) fields[main] = fields[loose]!
        delete fields[loose]
      }
    }
    if (Object.keys(fields).length === 0) {
      skipped += 1
      continue
    }
    const tags = Array.isArray(entry['tags']) ? (entry['tags'] as unknown[]).map(str).filter((t) => t !== '') : []
    items.push({ name: nameFor(name, url, username), kind, username: username.trim(), url: url.trim(), notes: str(entry['notes'] ?? entry['note']).trim(), tags, fields })
  }
  // { source: "My old vault", items: [...] } names where it came from (shown as "From My old vault").
  const named = typeof data === 'object' && data !== null && !Array.isArray(data) && Array.isArray((data as { items?: unknown }).items) ? str((data as { source?: unknown }).source).trim().slice(0, 40) : ''
  return { format: named !== '' ? named : 'a JSON file', items, skipped }
}
