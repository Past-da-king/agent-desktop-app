/**
 * Settings > Vault: passwords, logins, passkeys, API keys and tokens the agent uses without seeing (main/vault).
 *
 * Logins and passkeys are grouped by site, as a browser's password manager shows them. The list never holds a value.
 * Show and Copy are the person's own clicks: Show asks the computer for one value and hides it again after 20 seconds;
 * Copy puts it on the clipboard in the main process (cleared after 30 seconds). Editing never shows the old value:
 * a field left empty keeps it. Below the list: when the Vault asks (asking is the default, each can be switched off,
 * and one switch turns all asking off).
 */
import { VAULT_DEFAULT_FIELD, registrableDomain, type VaultImportResult, type VaultItemMeta, type VaultKind, type VaultPrefs } from '@agent/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agent } from '../bridge'
import { timeAgo } from '../lib/format'
import { toast } from '../state/useToast'
import { Pill } from '../ui/bits'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'

type EditableKind = Exclude<VaultKind, 'passkey'>
const KIND_LABEL: Record<VaultKind, string> = { login: 'Login', api_key: 'API key', token: 'Token', note: 'Secret note', passkey: 'Passkey' }
const SECRET_LABEL: Record<VaultKind, string> = { login: 'Password', api_key: 'Key', token: 'Token', note: 'Secret text', passkey: 'Private key' }
const FIRST_GROUPS = 6
const SHOW_MS = 20_000
const OTHER = 'Keys and notes'

function kindIcon(kind: VaultKind): 'key' | 'lock' | 'shield' | 'doc' | 'person' {
  if (kind === 'login') return 'lock'
  if (kind === 'api_key') return 'key'
  if (kind === 'token') return 'shield'
  if (kind === 'passkey') return 'person'
  return 'doc'
}

function detailLine(item: VaultItemMeta): string {
  const bits = [KIND_LABEL[item.kind]]
  if (item.username !== '') bits.push(item.username)
  if (item.kind !== 'login' && item.kind !== 'passkey' && item.hosts.length > 0) bits.push(item.hosts[0]!)
  if (item.lastUsedAt > 0) bits.push(`used ${timeAgo(item.lastUsedAt)}`)
  return bits.join(' · ')
}

/** The site a login or passkey belongs to; keys and notes without a site go together. */
function siteOf(item: VaultItemMeta): string {
  if (item.kind !== 'login' && item.kind !== 'passkey') return OTHER
  const host = item.passkey?.rpId ?? item.hosts[0] ?? ''
  return host === '' ? OTHER : registrableDomain(host)
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "Imported 12 and updated 3 from Bitwarden", or the reason it could not. */
export function importTitle(result: VaultImportResult): string {
  if (result.error !== undefined) return 'Nothing imported'
  if (result.imported === 0 && result.updated === 0) return 'Nothing to import in that file'
  const parts = [result.imported > 0 ? `Imported ${plural(result.imported, 'item', 'items')}` : '', result.updated > 0 ? `${result.imported > 0 ? 'updated' : 'Updated'} ${result.updated}` : ''].filter((p) => p !== '')
  return `${parts.join(' and ')}${result.format !== undefined ? ` from ${result.format}` : ''}`
}

export function importLine(result: VaultImportResult): string {
  if (result.error !== undefined) return result.error
  const read = `${plural(result.found, 'row', 'rows')} read`
  const skipped = result.skipped > 0 ? `, ${result.skipped} skipped (no password or value)` : ''
  return `${read}${skipped}. Delete the export file now: it holds your passwords in plain text.`
}

export function VaultSettings(): JSX.Element {
  const [items, setItems] = useState<VaultItemMeta[] | null>(null)
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const [editing, setEditing] = useState<VaultItemMeta | 'new' | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [shown, setShown] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
  const [imported, setImported] = useState<VaultImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const remote = agent.remote !== undefined

  const load = useCallback(() => {
    void agent.vault
      .list()
      .then(setItems)
      .catch(() => setItems([]))
  }, [])

  useEffect(() => {
    load()
    return agent.vault.onChange(load)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = items ?? []
    if (q === '') return list
    return list.filter((item) => [item.name, item.ref, item.username, item.hosts.join(' '), item.tags.join(' '), item.notes].join(' ').toLowerCase().includes(q))
  }, [items, query])

  const groups = useMemo(() => {
    const bySite = new Map<string, VaultItemMeta[]>()
    for (const item of filtered) {
      const site = siteOf(item)
      bySite.set(site, [...(bySite.get(site) ?? []), item])
    }
    return [...bySite.entries()].sort(([a], [b]) => (a === OTHER ? 1 : b === OTHER ? -1 : a.localeCompare(b)))
  }, [filtered])
  const visibleGroups = all || query.trim() !== '' ? groups : groups.slice(0, FIRST_GROUPS)

  const show = async (item: VaultItemMeta): Promise<void> => {
    if (shown[item.id] !== undefined) {
      setShown((now) => {
        const next = { ...now }
        delete next[item.id]
        return next
      })
      return
    }
    try {
      const value = await agent.vault.reveal(item.id)
      setShown((now) => ({ ...now, [item.id]: value }))
      window.setTimeout(() => {
        setShown((now) => {
          const next = { ...now }
          delete next[item.id]
          return next
        })
      }, SHOW_MS)
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not show it.')
    }
  }

  const copy = async (item: VaultItemMeta): Promise<void> => {
    try {
      await agent.vault.copy(item.id)
      toast('Copied. It leaves the clipboard in 30 seconds.')
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not copy it.')
    }
  }

  const importExport = async (file: File): Promise<void> => {
    if (file.size > 20 * 1024 * 1024) {
      setImported({ found: 0, imported: 0, updated: 0, skipped: 0, names: [], error: 'That file is too big to be a password export.' })
      return
    }
    setImporting(true)
    try {
      // The computer reads the file itself when it has a path (the window may not be allowed to); the text otherwise.
      const path = agent.files.pathsFor([file])[0] ?? ''
      const result = path !== '' ? await agent.vault.importFile(path) : await agent.vault.importText(await file.text(), file.name)
      setImported(result)
      if (result.error === undefined) toast(importTitle(result))
    } catch (cause) {
      setImported({ found: 0, imported: 0, updated: 0, skipped: 0, names: [], error: cause instanceof Error ? cause.message : 'Could not import it.' })
    } finally {
      setImporting(false)
    }
  }

  const count = items?.length ?? 0

  const row = (item: VaultItemMeta): JSX.Element => {
    const passkey = item.kind === 'passkey'
    return (
      <div className="rowc vault-row" key={item.id}>
        <div className="ri">
          <Icon name={kindIcon(item.kind)} size={22} />
        </div>
        <div className="rt">
          <b>{passkey ? item.username || 'Passkey' : item.kind === 'login' ? item.username || item.name : item.name}</b>
          <span>{passkey ? `Passkey · ${item.name}${item.lastUsedAt > 0 ? ` · used ${timeAgo(item.lastUsedAt)}` : ''}` : item.kind === 'login' ? `${item.name}${item.lastUsedAt > 0 ? ` · used ${timeAgo(item.lastUsedAt)}` : ''}` : detailLine(item)}</span>
          {passkey ? null : (
            <span className="vault-ref">
              <code>{`{{vault:${item.ref}}}`}</code>
              {shown[item.id] !== undefined ? <code className="vault-value">{shown[item.id]}</code> : null}
            </span>
          )}
        </div>
        <div className="vault-pills">
          {item.revealable ? <Pill tone="warn">Agents may see it</Pill> : null}
          {item.source !== '' && item.source !== 'agent' && item.source !== 'browser' ? <Pill tone="mute">{`From ${item.source}`}</Pill> : null}
          {item.fields.length === 0 ? <Pill tone="warn">No value</Pill> : null}
        </div>
        {remote ? null : (
          <div className="ai-row-acts">
            {passkey ? null : (
              <>
                <Button variant="text" size="sm" disabled={item.fields.length === 0} onClick={() => void show(item)}>
                  {shown[item.id] !== undefined ? 'Hide' : 'Show'}
                </Button>
                <Button variant="text" size="sm" disabled={item.fields.length === 0} onClick={() => void copy(item)}>
                  Copy
                </Button>
                <Button variant="text" size="sm" onClick={() => setEditing(item)}>
                  Change
                </Button>
              </>
            )}
            {confirmRemove === item.id ? (
              <>
                <Button
                  variant="text"
                  size="sm"
                  className="danger"
                  onClick={() => {
                    setConfirmRemove(null)
                    void agent.vault.remove(item.id).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not delete it.'))
                  }}
                >
                  Delete it
                </Button>
                <Button variant="text" size="sm" onClick={() => setConfirmRemove(null)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button variant="text" size="sm" onClick={() => setConfirmRemove(item.id)}>
                Delete
              </Button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <section>
      <SectionHeader eyebrow="VAULT" line="Passwords, passkeys and keys your agent uses without seeing them" />
      <div className="card vault" style={{ padding: 10 }}>
        <div className="vault-head">
          <label className="search vault-search" htmlFor="vault-search">
            <Icon name="search" size={20} />
            <input id="vault-search" placeholder={count === 0 ? 'Nothing in the vault yet' : `Search ${count} items`} value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
          </label>
          {remote ? null : (
            <div className="vault-head-acts">
              <Button variant="text" size="sm" disabled={importing} onClick={() => fileRef.current?.click()} title="Chrome or Edge CSV, Bitwarden CSV or JSON, 1Password CSV, or JSON of names and values">
                {importing ? 'Importing...' : 'Import'}
              </Button>
              <Button variant="tonal" size="sm" onClick={() => setEditing('new')}>
                <Icon name="plus" size={16} />
                Add
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.json,text/csv,application/json"
                aria-label="Import a password export"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file !== undefined) void importExport(file)
                }}
              />
            </div>
          )}
        </div>

        {imported === null ? null : (
          <div className="rowc vault-import-result" role="status">
            <div className="ri">
              <Icon name={imported.error === undefined ? 'check' : 'x'} size={22} />
            </div>
            <div className="rt">
              <b>{importTitle(imported)}</b>
              <span>{importLine(imported)}</span>
            </div>
            <Button variant="text" size="sm" onClick={() => setImported(null)}>
              Close
            </Button>
          </div>
        )}

        {items === null ? null : visibleGroups.length === 0 ? (
          <div className="rowc">
            <div className="ri">
              <Icon name="lock" size={22} />
            </div>
            <div className="rt">
              <b>{query.trim() === '' ? 'The vault is empty' : `Nothing matches "${query.trim()}"`}</b>
              <span>{query.trim() === '' ? 'Add a login or a key, import the passwords your browser or password manager exported, or sign in on a site in the browser and save it. Your agent fills it in for you and never sees it.' : 'Try a name, a website or a tag.'}</span>
            </div>
          </div>
        ) : (
          visibleGroups.map(([site, list]) => (
            <div className="vault-group" key={site}>
              <div className="vault-site">
                <b>{site}</b>
                <span>{list.length === 1 ? '1 saved' : `${list.length} saved`}</span>
              </div>
              {list.map(row)}
            </div>
          ))
        )}

        {!all && query.trim() === '' && groups.length > FIRST_GROUPS ? (
          <div className="vault-more">
            <Button variant="text" size="sm" onClick={() => setAll(true)}>
              Show all {groups.length} sites
            </Button>
          </div>
        ) : null}
        <p className="small muted vault-foot">
          Agents write <code>{'{{vault:name}}'}</code> where a key or password goes. It is put in at the last moment and taken out of everything they read back.
          {remote ? ' Values stay on the computer.' : ''}
        </p>
      </div>
      <VaultAsking />
      {editing !== null ? <VaultDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  )
}

/** When the Vault asks the person. Asking is the default; the master switch turns all of it off at once. */
function VaultAsking(): JSX.Element | null {
  const [prefs, setPrefs] = useState<VaultPrefs | null>(null)
  const remote = agent.remote !== undefined
  useEffect(() => {
    const load = (): void => {
      void agent.vault
        .prefs()
        .then(setPrefs)
        .catch(() => undefined)
    }
    load()
    return agent.vault.onChange(load)
  }, [])
  if (prefs === null) return null
  const change = (patch: Partial<VaultPrefs>): void => {
    setPrefs({ ...prefs, ...patch })
    void agent.vault
      .setPrefs(patch)
      .then(setPrefs)
      .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not change it.'))
  }
  const off = prefs.dontAsk
  const rows: Array<{ key: 'askReveal' | 'askPasskey' | 'offerSave'; icon: 'eye' | 'person' | 'lock'; title: string; line: string }> = [
    { key: 'askReveal', icon: 'eye', title: 'Ask before an agent sees a value', line: 'Filling in and sending never ask: the agent does not see those.' },
    { key: 'askPasskey', icon: 'person', title: 'Ask before a passkey is used', line: 'In the browser, and for an agent on any of your devices.' },
    { key: 'offerSave', icon: 'lock', title: 'Offer to save passwords I type', line: 'A Save or Update prompt after you sign in on a site.' },
  ]
  return (
    <div className="card vault-asking" style={{ padding: 10, marginTop: 10 }}>
      <div className="rowc">
        <div className="ri">
          <Icon name="bolt" size={22} />
        </div>
        <div className="rt">
          <b>{"Don't ask me"}</b>
          <span>{off ? 'Agents use the vault freely, and passwords you type are saved without a prompt.' : 'Agents use the vault freely: one switch for all of the asking below.'}</span>
        </div>
        <Switch label="Don't ask me" on={off} disabled={remote} onToggle={(next) => change({ dontAsk: next })} />
      </div>
      {rows.map((r) => (
        <div className="rowc" key={r.key}>
          <div className="ri">
            <Icon name={r.icon} size={22} />
          </div>
          <div className="rt">
            <b>{r.title}</b>
            <span>{off ? 'Off while "Don\'t ask me" is on.' : r.line}</span>
          </div>
          <Switch label={r.title} on={!off && prefs[r.key]} disabled={off || remote} onToggle={(next) => change({ [r.key]: next })} />
        </div>
      ))}
      {prefs.never.length > 0 ? (
        <div className="rowc">
          <div className="ri">
            <Icon name="x" size={22} />
          </div>
          <div className="rt">
            <b>Never offered on</b>
            <span>{prefs.never.join(', ')}</span>
          </div>
          {remote ? null : (
            <Button variant="text" size="sm" onClick={() => change({ never: [] })}>
              Clear
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}

function VaultDialog({ item, onClose }: { item?: VaultItemMeta; onClose: () => void }): JSX.Element {
  const [kind, setKind] = useState<EditableKind>(item === undefined || item.kind === 'passkey' ? 'login' : item.kind)
  const [name, setName] = useState(item?.name ?? '')
  const [username, setUsername] = useState(item?.username ?? '')
  const [url, setUrl] = useState(item?.url ?? '')
  const [secret, setSecret] = useState('')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [tags, setTags] = useState(item?.tags.filter((tag) => !tag.includes(':')).join(', ') ?? '')
  const [revealable, setRevealable] = useState(item?.revealable ?? false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const field = VAULT_DEFAULT_FIELD[kind]
  const has = item?.fields.includes(field) ?? false
  const otherFields = (item?.fields ?? []).filter((name) => name !== field)

  const save = async (): Promise<void> => {
    if (name.trim() === '') {
      setError('Give it a name.')
      return
    }
    if (item === undefined && secret === '') {
      setError(`Type the ${SECRET_LABEL[kind].toLowerCase()}.`)
      return
    }
    setBusy(true)
    try {
      const keptTags = item?.tags.filter((tag) => tag.includes(':')) ?? []
      await agent.vault.save({
        ...(item === undefined ? {} : { id: item.id }),
        name: name.trim(),
        kind,
        username: username.trim(),
        url: url.trim(),
        notes,
        tags: [...tags.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''), ...keptTags],
        revealable,
        ...(secret === '' ? {} : { fields: { [field]: secret } }),
      })
      setSecret('')
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save it.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog label={item === undefined ? 'Add to the vault' : `Change ${item.name}`} onClose={onClose} className="vault-dialog">
      <span className="eyebrow">{item === undefined ? 'ADD TO THE VAULT' : 'CHANGE'}</span>
      <h2 className="h2" style={{ marginTop: 6 }}>
        {item === undefined ? 'What should your agent keep safe?' : item.name}
      </h2>
      <Segmented
        ariaLabel="Kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'login', label: 'Login', icon: <Icon name="lock" size={18} /> },
          { value: 'api_key', label: 'Key', icon: <Icon name="key" size={18} /> },
          { value: 'token', label: 'Token', icon: <Icon name="shield" size={18} /> },
          { value: 'note', label: 'Note', icon: <Icon name="doc" size={18} /> },
        ]}
      />
      <Field label="Name" value={name} onChange={setName} placeholder={kind === 'login' ? 'Bank, school portal, a website' : 'Groq API, GitHub token'} />
      {kind === 'login' ? <Field label="Username or email" value={username} onChange={setUsername} autoComplete="off" /> : null}
      <Field label="Website" type="url" value={url} onChange={setUrl} placeholder="https://..." />
      <Field
        label={SECRET_LABEL[kind]}
        type="password"
        revealable
        revealLabel={SECRET_LABEL[kind].toLowerCase()}
        value={secret}
        onChange={(value) => {
          setSecret(value)
          setError('')
        }}
        placeholder={has ? 'Saved. Type a new one to change it' : `Paste the ${SECRET_LABEL[kind].toLowerCase()}`}
        autoComplete="new-password"
        error={error}
        onEnter={() => void save()}
      />
      {otherFields.length > 0 ? <p className="small muted" style={{ margin: '0 0 8px' }}>Also holds: {otherFields.join(', ')}.</p> : null}
      <div className="field">
        <label htmlFor="vault-notes">Notes (not secret)</label>
        <textarea id="vault-notes" className="input vault-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} placeholder="Which account, password rules, how to reset" />
      </div>
      <Field label="Tags" value={tags} onChange={setTags} placeholder="work, school" />
      <div className="ob-check">
        <span>Agents may see this one without asking</span>
        <Switch label="Agents may see this one without asking" on={revealable} onToggle={setRevealable} />
      </div>
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="fill" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving...' : 'Save'}
        </Button>
      </div>
    </Dialog>
  )
}
