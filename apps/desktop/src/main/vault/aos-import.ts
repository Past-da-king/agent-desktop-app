/**
 * Import the credential vault of A.O.S, the person's earlier agent desktop, into this Vault.
 *
 * A.O.S kept it in `<runtime>/credentials.db` (SQLite, table `credentials`) with each value sealed by AES-256-GCM
 * under the 32-byte key in `<runtime>/credentials.key` (base64). The import copies the database (and its WAL) to a
 * private temporary folder, reads it there, and deletes the copy straight after: values are only ever in memory,
 * on their way into this vault's own encrypted file. Running it again updates what it brought in before.
 */
import { createDecipheriv } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { DatabaseSync } from 'node:sqlite'

import { vaultRefOf, type VaultImportResult, type VaultItemInput, type VaultKind } from '@agent/core'

import type { VaultStore } from './store'

export const AOS_SOURCE = 'A.O.S'

interface AosRow {
  id: string
  service: string
  username: string | null
  url: string | null
  kind: string
  identity: string | null
  notes: string | null
  tags: string
  iv: string
  tag_b64: string
  secret: string
}

const KIND_MAP: Record<string, { kind: VaultKind; field: string }> = {
  password: { kind: 'login', field: 'password' },
  'api-key': { kind: 'api_key', field: 'key' },
  token: { kind: 'token', field: 'token' },
  'ssh-key': { kind: 'note', field: 'text' },
  note: { kind: 'note', field: 'text' },
}

/** Where an A.O.S runtime folder may be on this computer: $AOS_HOME, ~/.aos/.aos, and on Windows inside WSL. */
export function aosCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = []
  const env = process.env['AOS_HOME']
  if (env !== undefined && env.trim() !== '') out.push(join(env.trim(), '.aos'), env.trim())
  out.push(join(homedir(), '.aos', '.aos'))
  if (platform === 'win32') {
    for (const root of ['\\\\wsl.localhost', '\\\\wsl$']) {
      let distros: string[] = []
      try {
        distros = readdirSync(root)
      } catch {
        continue
      }
      for (const distro of distros) {
        let users: string[] = []
        try {
          users = readdirSync(join(root, distro, 'home'))
        } catch {
          continue
        }
        for (const user of users) out.push(join(root, distro, 'home', user, '.aos', '.aos'))
      }
      if (out.length > 2) break
    }
  }
  return out
}

/** The first folder that holds both files, or null. A folder passed in is checked as given and with .aos below it. */
export function findAosFolder(folder?: string): string | null {
  const list = folder !== undefined && folder.trim() !== '' ? [folder.trim(), join(folder.trim(), '.aos'), join(folder.trim(), '.aos', '.aos')] : aosCandidates()
  for (const dir of list) {
    try {
      if (existsSync(join(dir, 'credentials.db')) && existsSync(join(dir, 'credentials.key')) && statSync(dir).isDirectory()) return dir
    } catch {
      // Not readable: try the next.
    }
  }
  return null
}

/** Read every A.O.S item and save it here. Never logs or returns a value. */
export function importAos(vault: VaultStore, folder?: string, who = 'person'): VaultImportResult {
  const dir = findAosFolder(folder)
  if (dir === null) return { found: 0, imported: 0, updated: 0, skipped: 0, names: [], error: 'I could not find an A.O.S vault (credentials.db and credentials.key) on this computer.' }
  const key = Buffer.from(readFileSync(join(dir, 'credentials.key'), 'utf8').trim(), 'base64')
  if (key.length !== 32) return { found: 0, imported: 0, updated: 0, skipped: 0, names: [], error: 'The A.O.S key file is damaged.' }

  const temp = mkdtempSync(join(tmpdir(), 'agent-aos-'))
  let rows: AosRow[] = []
  try {
    for (const name of ['credentials.db', 'credentials.db-wal', 'credentials.db-shm']) {
      if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(temp, name))
    }
    const db = new DatabaseSync(join(temp, 'credentials.db'))
    try {
      rows = db.prepare('SELECT id, service, username, url, kind, identity, notes, tags, iv, tag_b64, secret FROM credentials ORDER BY service').all() as unknown as AosRow[]
    } finally {
      db.close()
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }

  const result: VaultImportResult = { found: rows.length, imported: 0, updated: 0, skipped: 0, names: [] }
  const byService = new Map<string, number>()
  for (const row of rows) byService.set(row.service.toLowerCase(), (byService.get(row.service.toLowerCase()) ?? 0) + 1)
  const existing = vault.list()

  for (const row of rows) {
    let value: string
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(row.tag_b64, 'base64'))
      value = Buffer.concat([decipher.update(Buffer.from(row.secret, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      result.skipped += 1
      continue
    }
    const map = KIND_MAP[row.kind] ?? KIND_MAP['password']!
    const tag = `aos:${row.id}`
    let tags: string[] = []
    try {
      const parsed = JSON.parse(row.tags) as unknown
      if (Array.isArray(parsed)) tags = parsed.map(String)
    } catch {
      // A hand-edited row: no tags.
    }
    const shared = (byService.get(row.service.toLowerCase()) ?? 0) > 1
    const user = (row.username ?? '').trim()
    const notes = [row.identity ? `Account: ${row.identity}` : '', row.notes ?? ''].filter((part) => part.trim() !== '').join('\n')
    const before = existing.find((item) => item.tags.includes(tag))
    const input: VaultItemInput = {
      ...(before === undefined ? {} : { id: before.id }),
      name: row.service,
      ...(before === undefined ? { ref: shared && user !== '' ? `${vaultRefOf(row.service).slice(0, 40).replace(/-+$/, '')}-${vaultRefOf(user.split('@')[0] ?? user).slice(0, 22)}` : vaultRefOf(row.service) } : {}),
      kind: map.kind,
      username: user,
      url: row.url ?? '',
      notes,
      tags: [...tags, tag],
      source: AOS_SOURCE,
      fields: { [map.field]: value },
    }
    vault.save(input, who)
    if (before === undefined) result.imported += 1
    else result.updated += 1
    result.names.push(row.service)
  }
  // One audit line for the whole import (the saves above are logged one by one too).
  return result
}
