/**
 * Settings > Vault: passwords, logins, API keys and tokens the agent uses without seeing (main/vault).
 *
 * The list never holds a value. Show and Copy are the person's own clicks: Show asks the computer for one value and
 * hides it again after 20 seconds; Copy puts it on the clipboard in the main process (cleared after 30 seconds), so
 * the value never comes into this window. Editing never shows the old value: a field left empty keeps it.
 */
import { VAULT_DEFAULT_FIELD, type VaultItemMeta, type VaultKind } from '@agent/core'
import { useCallback, useEffect, useMemo, useState } from 'react'

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

const KIND_LABEL: Record<VaultKind, string> = { login: 'Login', api_key: 'API key', token: 'Token', note: 'Secret note' }
const SECRET_LABEL: Record<VaultKind, string> = { login: 'Password', api_key: 'Key', token: 'Token', note: 'Secret text' }
const FIRST_PAGE = 8
const SHOW_MS = 20_000

function kindIcon(kind: VaultKind): 'key' | 'lock' | 'shield' | 'doc' {
  if (kind === 'login') return 'lock'
  if (kind === 'api_key') return 'key'
  if (kind === 'token') return 'shield'
  return 'doc'
}

function detailLine(item: VaultItemMeta): string {
  const bits = [KIND_LABEL[item.kind]]
  if (item.username !== '') bits.push(item.username)
  if (item.hosts.length > 0) bits.push(item.hosts[0]!)
  if (item.lastUsedAt > 0) bits.push(`used ${timeAgo(item.lastUsedAt)}`)
  return bits.join(' · ')
}

export function VaultSettings(): JSX.Element {
  const [items, setItems] = useState<VaultItemMeta[] | null>(null)
  const [query, setQuery] = useState('')
  const [all, setAll] = useState(false)
  const [editing, setEditing] = useState<VaultItemMeta | 'new' | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [shown, setShown] = useState<Record<string, string>>({})
  const [importing, setImporting] = useState(false)
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
  const visible = all || query.trim() !== '' ? filtered : filtered.slice(0, FIRST_PAGE)

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
      toast(`Copied. It leaves the clipboard in 30 seconds.`)
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not copy it.')
    }
  }

  const importAos = async (): Promise<void> => {
    setImporting(true)
    try {
      let result = await agent.vault.importAos()
      // Not where A.O.S usually keeps it: let the person point at the folder.
      if (result.error !== undefined && result.found === 0) {
        toast(`${result.error} Pick the A.O.S folder that holds credentials.db.`)
        const folder = await agent.files.pickFolder()
        if (folder === null) return
        result = await agent.vault.importAos(folder)
      }
      if (result.error !== undefined) toast(result.error)
      else toast(`From A.O.S: ${result.found} found, ${result.imported} added, ${result.updated} updated${result.skipped > 0 ? `, ${result.skipped} could not be read` : ''}.`)
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'The import did not finish.')
    } finally {
      setImporting(false)
    }
  }

  const count = items?.length ?? 0

  return (
    <section>
      <SectionHeader eyebrow="VAULT" line="Passwords and keys your agent uses without seeing them" />
      <div className="card vault" style={{ padding: 10 }}>
        <div className="vault-head">
          <label className="search vault-search" htmlFor="vault-search">
            <Icon name="search" size={20} />
            <input id="vault-search" placeholder={count === 0 ? 'Nothing in the vault yet' : `Search ${count} items`} value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" />
          </label>
          {remote ? null : (
            <div className="vault-head-acts">
              <Button variant="tonal" size="sm" onClick={() => setEditing('new')}>
                <Icon name="plus" size={16} />
                Add
              </Button>
              <Button variant="text" size="sm" disabled={importing} onClick={() => void importAos()}>
                {importing ? 'Importing...' : 'Import from A.O.S'}
              </Button>
            </div>
          )}
        </div>

        {items === null ? null : visible.length === 0 ? (
          <div className="rowc">
            <div className="ri">
              <Icon name="lock" size={22} />
            </div>
            <div className="rt">
              <b>{query.trim() === '' ? 'The vault is empty' : `Nothing matches "${query.trim()}"`}</b>
              <span>{query.trim() === '' ? 'Add a login or a key. Your agent fills it in or sends it for you, and never sees it.' : 'Try a name, a website or a tag.'}</span>
            </div>
          </div>
        ) : (
          visible.map((item) => (
            <div className="rowc vault-row" key={item.id}>
              <div className="ri">
                <Icon name={kindIcon(item.kind)} size={22} />
              </div>
              <div className="rt">
                <b>{item.name}</b>
                <span>{detailLine(item)}</span>
                <span className="vault-ref">
                  <code>{`{{vault:${item.ref}}}`}</code>
                  {shown[item.id] !== undefined ? <code className="vault-value">{shown[item.id]}</code> : null}
                </span>
              </div>
              <div className="vault-pills">
                {item.revealable ? <Pill tone="warn">Agents may see it</Pill> : null}
                {item.source === 'A.O.S' ? <Pill tone="mute">From A.O.S</Pill> : null}
                {item.fields.length === 0 ? <Pill tone="warn">No value</Pill> : null}
              </div>
              {remote ? null : (
                <div className="ai-row-acts">
                  <Button variant="text" size="sm" disabled={item.fields.length === 0} onClick={() => void show(item)}>
                    {shown[item.id] !== undefined ? 'Hide' : 'Show'}
                  </Button>
                  <Button variant="text" size="sm" disabled={item.fields.length === 0} onClick={() => void copy(item)}>
                    Copy
                  </Button>
                  <Button variant="text" size="sm" onClick={() => setEditing(item)}>
                    Change
                  </Button>
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
          ))
        )}

        {!all && query.trim() === '' && filtered.length > FIRST_PAGE ? (
          <div className="vault-more">
            <Button variant="text" size="sm" onClick={() => setAll(true)}>
              Show all {filtered.length}
            </Button>
          </div>
        ) : null}
        <p className="small muted vault-foot">
          Agents write <code>{'{{vault:name}}'}</code> where a key or password goes. It is put in at the last moment and taken out of everything they read back.
          {remote ? ' Values stay on the computer.' : ''}
        </p>
      </div>
      {editing !== null ? <VaultDialog item={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} /> : null}
    </section>
  )
}

function VaultDialog({ item, onClose }: { item?: VaultItemMeta; onClose: () => void }): JSX.Element {
  const [kind, setKind] = useState<VaultKind>(item?.kind ?? 'login')
  const [name, setName] = useState(item?.name ?? '')
  const [username, setUsername] = useState(item?.username ?? '')
  const [url, setUrl] = useState(item?.url ?? '')
  const [secret, setSecret] = useState('')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [tags, setTags] = useState(item?.tags.filter((tag) => !tag.startsWith('aos:')).join(', ') ?? '')
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
      const keptTags = item?.tags.filter((tag) => tag.startsWith('aos:')) ?? []
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
