/**
 * Importing a password export into the Vault: Chrome or Edge CSV, Bitwarden CSV and JSON, 1Password CSV and a plain
 * JSON file of names and values. Same site and username updates; only counts and names come back, never a value.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileKeyCipher } from '../src/headless/file-cipher'
import { Secrets } from '../src/main/secrets'
import { importFile, importText, parseImport, readCsv } from '../src/main/vault/import'
import { registerVaultIpc } from '../src/main/vault/ipc'
import { VaultStore } from '../src/main/vault/store'
import { VAULT_CHANNELS } from '../src/shared/vault-channels'

let dir = ''
let vault: VaultStore
const pw = (): string => 'pw-' + randomBytes(6).toString('hex')
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const valueOf = (ref: string, field?: string): string => {
  const hit = vault.resolve(ref, field)
  return 'error' in hit ? '' : hit.value
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-vault-import-'))
  vault = new VaultStore(new Secrets(join(dir, 'secrets'), new FileKeyCipher(join(dir, 'secrets.key'))))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('csv reader', () => {
  it('reads quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    expect(readCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"\nthere'],
    ])
  })
})

describe('vault import', () => {
  it('imports a Chrome or Edge CSV, by count and by hash, and updates on the second run', () => {
    const a = pw()
    const b = pw()
    const c = pw()
    const csv = `﻿name,url,username,password,note\r\naccounts.example.com,https://accounts.example.com/login,me@example.com,${a},\r\nexample.com,https://www.example.com/,other@example.com,"${b}",work\r\nshop.test,https://shop.test/,buyer,${c},\r\nempty.test,https://empty.test/,nobody,,\r\n`
    const result = importText(vault, csv, 'Chrome Passwords.csv')
    expect(result).toMatchObject({ format: 'Chrome or Edge', found: 4, imported: 3, updated: 0, skipped: 1 })
    expect(JSON.stringify(result)).not.toContain(a)
    const items = vault.list()
    expect(items).toHaveLength(3)
    const first = items.find((item) => item.username === 'me@example.com')!
    expect(first.kind).toBe('login')
    expect(first.source).toBe('Chrome or Edge')
    expect(first.hosts).toEqual(['accounts.example.com'])
    expect(hash(valueOf(first.ref))).toBe(hash(a))
    expect(hash(valueOf(items.find((item) => item.username === 'other@example.com')!.ref))).toBe(hash(b))
    expect(items.find((item) => item.username === 'other@example.com')!.notes).toBe('work')

    // Again with a changed password: same site and username is an update, not a second item.
    const a2 = pw()
    const again = importText(vault, csv.replace(a, a2), 'Chrome Passwords.csv')
    expect(again).toMatchObject({ imported: 0, updated: 3, skipped: 1 })
    expect(vault.list()).toHaveLength(3)
    expect(hash(valueOf(first.ref))).toBe(hash(a2))
  })

  it('updates a login already in the vault for the same site and username', () => {
    const before = vault.save({ name: 'Example', kind: 'login', username: 'me@example.com', url: 'https://example.com', fields: { password: 'old' } })
    const fresh = pw()
    const result = importText(vault, `name,url,username,password\nexample,https://login.example.com/,ME@example.com,${fresh}\n`)
    expect(result).toMatchObject({ imported: 0, updated: 1 })
    expect(vault.list()).toHaveLength(1)
    expect(valueOf(before.ref)).toBe(fresh)
  })

  it('imports a Bitwarden CSV: logins with TOTP and custom fields, secure notes, and skips cards', () => {
    const a = pw()
    const note = 'line one\nline two ' + pw()
    const csv = [
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      `Work,1,login,Portal,reset by email,"pin: 1234\nanswer: blue",0,https://portal.example.org/login,one@example.org,${a},JBSWY3DPEHPK3PXP`,
      `,,note,Recovery codes,"${note}",,0,,,,`,
      ',,card,Visa,,,0,,,,',
    ].join('\n')
    const result = importText(vault, csv, 'bitwarden_export.csv')
    expect(result).toMatchObject({ format: 'Bitwarden', found: 3, imported: 2, skipped: 1 })
    const portal = vault.list().find((item) => item.name === 'Portal')!
    expect(portal.fields.sort()).toEqual(['answer', 'password', 'pin', 'totp'])
    expect(portal.tags).toEqual(['Work'])
    expect(hash(valueOf(portal.ref))).toBe(hash(a))
    const codes = vault.list().find((item) => item.name === 'Recovery codes')!
    expect(codes.kind).toBe('note')
    expect(hash(valueOf(codes.ref))).toBe(hash(note))
  })

  it('imports a Bitwarden JSON export and refuses an encrypted one in plain words', () => {
    const a = pw()
    const b = pw()
    const json = JSON.stringify({
      encrypted: false,
      folders: [{ id: 'f1', name: 'Personal' }],
      items: [
        { type: 1, name: 'Mail', folderId: 'f1', notes: null, login: { username: 'me@mail.test', password: a, totp: null, uris: [{ uri: 'https://mail.test/' }] }, fields: [{ name: 'Recovery key', value: b, type: 1 }] },
        { type: 2, name: 'Wifi', notes: 'the wifi key ' + pw(), secureNote: { type: 0 } },
        { type: 3, name: 'Card', card: {} },
        { type: 1, name: 'No password', login: { username: 'x', password: null, uris: [] } },
      ],
    })
    const result = importText(vault, json, 'bitwarden.json')
    expect(result).toMatchObject({ format: 'Bitwarden', found: 4, imported: 2, skipped: 2 })
    const mail = vault.list().find((item) => item.name === 'Mail')!
    expect(mail.tags).toEqual(['Personal'])
    expect(mail.fields.sort()).toEqual(['Recovery_key', 'password'])
    expect(hash(valueOf(mail.ref))).toBe(hash(a))
    expect(hash(valueOf(mail.ref, 'Recovery_key'))).toBe(hash(b))
    expect(vault.list().find((item) => item.name === 'Wifi')?.kind).toBe('note')

    const locked = importText(vault, JSON.stringify({ encrypted: true, encKeyValidation_DO_NOT_EDIT: 'x', data: 'y' }), 'bitwarden.json')
    expect(locked.error).toContain('encrypted')
    expect(locked.imported).toBe(0)
  })

  it('imports a 1Password CSV, new and old column names', () => {
    const a = pw()
    const b = pw()
    const csv = `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\nBank,https://bank.test/,client1,${a},,false,false,money,branch 12\n`
    const result = importText(vault, csv, '1PasswordExport.csv')
    expect(result).toMatchObject({ format: '1Password', imported: 1 })
    const bank = vault.list()[0]!
    expect(bank).toMatchObject({ name: 'Bank', username: 'client1', notes: 'branch 12', tags: ['money'] })
    expect(hash(valueOf(bank.ref))).toBe(hash(a))
    const old = importText(vault, `title,website,username,password,notes\nForum,forum.test,poster,${b},\n`, 'export.csv')
    expect(old).toMatchObject({ format: '1Password', imported: 1 })
    expect(vault.list().find((item) => item.name === 'Forum')?.hosts).toEqual(['forum.test'])
  })

  it('imports a plain JSON file: a map of names to values, and a list of items with kinds', () => {
    const key = 'gsk_' + randomBytes(10).toString('hex')
    const token = 'ghp_' + randomBytes(10).toString('hex')
    const a = pw()
    const map = importText(vault, JSON.stringify({ 'Groq API': key }), 'keys.json')
    expect(map).toMatchObject({ format: 'a JSON file', found: 1, imported: 1 })
    const groq = vault.list().find((item) => item.name === 'Groq API')!
    expect(groq.kind).toBe('api_key')
    expect(hash(valueOf('groq-api'))).toBe(hash(key))

    const list = importText(
      vault,
      JSON.stringify([
        { name: 'GitHub token', kind: 'token', value: token, notes: 'repo scope', tags: ['code'] },
        { name: 'School portal', username: 'student', url: 'https://portal.school.test', password: a },
        { name: 'Deploy key', kind: 'ssh-key', value: 'not a real key' },
        { name: 'Nothing here' },
      ]),
      'items.json',
    )
    expect(list).toMatchObject({ found: 4, imported: 3, skipped: 1 })
    expect(list.names).toEqual(['GitHub token', 'School portal', 'Deploy key'])
    const gh = vault.list().find((item) => item.name === 'GitHub token')!
    expect(gh).toMatchObject({ kind: 'token', notes: 'repo scope', tags: ['code'] })
    expect(hash(valueOf(gh.ref))).toBe(hash(token))
    expect(vault.list().find((item) => item.name === 'School portal')).toMatchObject({ kind: 'login', username: 'student' })
    expect(vault.list().find((item) => item.name === 'Deploy key')?.kind).toBe('note')
    // The same list again updates every item.
    expect(importText(vault, JSON.stringify([{ name: 'GitHub token', kind: 'token', value: token }]))).toMatchObject({ imported: 0, updated: 1 })
  })

  it('keeps two rows for one site and username as two items, keys on one site apart, and updates each in place again', () => {
    const values = [pw(), pw(), pw(), pw(), pw()]
    const file = (v: string[]): string =>
      JSON.stringify({
        source: 'My old vault',
        items: [
          { name: 'Office (tenant A)', url: 'https://www.office.com', username: 'admin@corp.test', password: v[0] },
          { name: 'Office (tenant A)', url: 'https://www.office.com', username: 'admin@corp.test', password: v[1] },
          { name: 'Office (tenant B)', url: 'https://www.office.com', username: 'admin@corp.test', password: v[2] },
          { name: 'Mail API key', kind: 'api_key', url: 'https://mail.test', username: 'me', value: v[3] },
          { name: 'Mail API key (second)', kind: 'api_key', url: 'https://mail.test', username: 'me', value: v[4] },
        ],
      })
    expect(importText(vault, file(values), 'move.json')).toMatchObject({ format: 'My old vault', found: 5, imported: 5, updated: 0 })
    expect(vault.list()).toHaveLength(5)
    expect(vault.list()[0]!.source).toBe('My old vault')
    const stored = (): string[] => vault.list().map((item) => hash(valueOf(item.id))).sort()
    expect(stored()).toEqual(values.map(hash).sort())
    const next = values.map(() => pw())
    expect(importText(vault, file(next), 'move.json')).toMatchObject({ imported: 0, updated: 5 })
    expect(vault.list()).toHaveLength(5)
    expect(stored()).toEqual(next.map(hash).sort())
  })

  it('gives refs that tell apart two logins with the same name', () => {
    importText(vault, `name,url,username,password\nPortal,,one@example.org,${pw()}\nPortal,,two@example.org,${pw()}\n`)
    expect(vault.list().map((item) => item.ref).sort()).toEqual(['portal-one', 'portal-two'])
  })

  it('says plainly when a file is not an export', () => {
    expect(importText(vault, '').error).toBe('The file is empty.')
    expect(importText(vault, '{not json', 'x.json').error).toBe('The file is not valid JSON.')
    expect(importText(vault, 'colour,size\nred,big\n', 'x.csv').error).toContain('I do not know this file')
    expect(() => parseImport('[]')).toThrow('nothing to import')
  })

  it('imports a file from disk by path, and the window channels are all registered', async () => {
    const a = pw()
    const path = join(dir, 'export.csv')
    writeFileSync(path, `name,url,username,password\nsite.test,https://site.test/,me,${a}\n`)
    expect(importFile(vault, path)).toMatchObject({ imported: 1, format: 'Chrome or Edge' })
    expect(importFile(vault, join(dir, 'missing.csv')).error).toBe('I could not find that file.')

    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    registerVaultIpc({ handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void handlers.set(channel, fn) } as never, { vault })
    for (const channel of Object.values(VAULT_CHANNELS)) expect(handlers.has(channel), channel).toBe(true)
    const viaWindow = (await handlers.get(VAULT_CHANNELS.importText)!({}, `name,url,username,password\nother.test,https://other.test/,me,${pw()}\n`, 'x.csv')) as { imported: number }
    expect(viaWindow.imported).toBe(1)
    const viaPath = (await handlers.get(VAULT_CHANNELS.importFile)!({}, path)) as { updated: number }
    expect(viaPath.updated).toBe(1)
  })
})
