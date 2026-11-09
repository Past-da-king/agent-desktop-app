/**
 * The Connections hub for everything outside this computer: connected apps (Composio, with the
 * person's own key) grouped one row per app, profiles as the main organiser across the top, and the
 * learned apps (sites the agent mapped once in its own browser). Everything goes through
 * window.agent.apps and window.agent.profiles; the key never comes back to the renderer.
 */
import type { AccountRules, AgentProfileInfo, AppChoice, AppRule, AppsStatus, ConnectedAccount, LearnedAppInfo } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { agent } from '../bridge'
import { filterAccounts, groupAccounts, initialOf, profileSummary, searchCatalog, type AppGroup } from '../lib/profiles'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'
import { ProfileBadge, ProfileDialog, accountChips, errorText, learnedChips, tone, useProfiles } from './Profiles'

const COMPOSIO_SITE = 'https://platform.composio.dev'

const RULE_LABELS: Record<AppRule, string> = { allow: 'Allowed', ask: 'Ask me', never: 'Never' }
const RULES: AppRule[] = ['allow', 'ask', 'never']

const KEY_KINDS: Record<AppsStatus['keyKind'], string> = {
  project: 'Project key',
  user: 'Personal key',
  org: 'Organisation key',
  consumer: 'Composio Connect key',
  '': 'No key',
}

/** Three tonal pairs from the tokens, picked by the app's name, so each app keeps its own colour. */
const TONES = ['tone-p', 'tone-s', 'tone-t']

function toneFor(name: string): string {
  let sum = 0
  for (const char of name) sum = (sum + char.charCodeAt(0)) % 997
  return TONES[sum % TONES.length] ?? 'tone-p'
}

/** The app's real logo from Composio, or a lettered tile when there is none or it does not load. */
export function AppLogo({ name, logo, size = 'md' }: { name: string; logo?: string; size?: 'sm' | 'md' }): JSX.Element {
  const [broken, setBroken] = useState(false)
  const url = logo ?? ''
  const usable = (url.startsWith('https://') || url.startsWith('data:image/')) && !broken
  return (
    <span className={`app-logo${size === 'sm' ? ' sm' : ''} ${usable ? 'img' : toneFor(name)}`} aria-hidden="true">
      {usable ? <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} /> : initialOf(name)}
    </span>
  )
}

/** Live accounts, key state and learned apps, reloaded whenever the main process says they changed. */
export function useApps(): { status: AppsStatus | null; learned: LearnedAppInfo[] | null; learnedFailed: boolean; reload: () => void } {
  const [status, setStatus] = useState<AppsStatus | null>(null)
  const [learned, setLearned] = useState<LearnedAppInfo[] | null>(null)
  const [learnedFailed, setLearnedFailed] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let live = true
    agent.apps
      .status()
      .then((next) => {
        if (live) setStatus(next)
      })
      .catch(() => {
        if (live) setStatus({ hasKey: false, keyKind: '', accounts: [], connecting: [], message: 'Could not read your connected apps.' })
      })
    agent.apps
      .learned()
      .then((next) => {
        if (!live) return
        setLearned(next)
        setLearnedFailed(false)
      })
      .catch(() => {
        if (!live) return
        // Keep what was shown; an empty list here would read as "nothing learned".
        setLearned((now) => now ?? [])
        setLearnedFailed(true)
      })
    return () => {
      live = false
    }
  }, [tick])

  useEffect(() => agent.apps.onChanged(() => setTick((n) => n + 1)), [])

  return { status, learned, learnedFailed, reload: () => setTick((n) => n + 1) }
}

// ---- dialogs ------------------------------------------------------------------------------------

function KeyDialog({ replacing, onClose }: { replacing: boolean; onClose: () => void }): JSX.Element {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (key.trim() === '') {
      setError('Paste your Composio key first.')
      return
    }
    setBusy(true)
    try {
      const result = await agent.apps.setKey(key.trim())
      if (result.ok) {
        toast(result.message)
        onClose()
      } else {
        setError(result.message)
      }
    } catch (cause: unknown) {
      setError(errorText(cause, 'The key could not be checked. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog label="Composio key" onClose={onClose} labelledBy="apps-key-title">
      <div>
        <span className="eyebrow">CONNECTED APPS</span>
        <h2 className="h2" id="apps-key-title" style={{ marginTop: 6 }}>
          {replacing ? 'Use a different key' : 'Add your Composio key'}
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          Make a free account at Composio, open your project's Settings, then API Keys, and paste the key here. It is checked
          with Composio and kept encrypted on this computer.
        </p>
      </div>
      <Field
        label="Composio key"
        type="password"
        revealable
        revealLabel="key"
        value={key}
        onChange={(value) => {
          setKey(value)
          setError('')
        }}
        placeholder="ak_..."
        autoComplete="off"
        error={error}
        onEnter={() => {
          void save()
        }}
      />
      <div className="dialog-actions">
        <Button
          variant="text"
          onClick={() => {
            void agent.shell.openExternal(COMPOSIO_SITE)
          }}
        >
          <Icon name="ext" size={16} />
          Get a key
        </Button>
        <Button variant="tonal" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          {busy ? 'Checking...' : 'Save key'}
        </Button>
      </div>
    </Dialog>
  )
}

function ConfirmDialog({
  eyebrow,
  title,
  line,
  action,
  onConfirm,
  onClose,
}: {
  eyebrow: string
  title: string
  line: string
  action: string
  onConfirm: () => Promise<void>
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog label={title} onClose={onClose} labelledBy="apps-confirm-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h2 className="h2" id="apps-confirm-title" style={{ marginTop: 6 }}>
          {title}
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          {line}
        </p>
      </div>
      <div className="dialog-actions">
        <Button variant="tonal" onClick={onClose}>
          Keep it
        </Button>
        <Button
          disabled={busy}
          onClick={() => {
            setBusy(true)
            onConfirm()
              .then(onClose)
              .catch((cause: unknown) => {
                toast(errorText(cause, 'That did not work. Try again.'))
                setBusy(false)
              })
          }}
        >
          {action}
        </Button>
      </div>
    </Dialog>
  )
}

function ConnectDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [catalog, setCatalog] = useState<AppChoice[] | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState('')
  // A list that could not be loaded is said so; search still reaches all of Composio.
  const [catalogFailed, setCatalogFailed] = useState(false)

  useEffect(() => {
    let live = true
    agent.apps
      .catalog()
      .then((list) => {
        if (live) setCatalog(list)
      })
      .catch(() => {
        if (!live) return
        setCatalog([])
        setCatalogFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  // The list Composio gave up front can be partial (a Connect key cannot list everything), so what the person
  // types is also searched across all of Composio, and those matches join the list.
  const [found, setFound] = useState<{ query: string; apps: AppChoice[] } | null>(null)
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setFound(null)
      setSearching(false)
      return
    }
    let live = true
    setSearching(true)
    const timer = window.setTimeout(() => {
      agent.apps
        .search(q)
        .then((apps) => {
          if (live) setFound({ query: q, apps })
        })
        .catch(() => {
          if (live) setFound({ query: q, apps: [] })
        })
        .finally(() => {
          if (live) setSearching(false)
        })
    }, 350)
    return () => {
      live = false
      window.clearTimeout(timer)
    }
  }, [query])
  const merged = useMemo(() => {
    const base = catalog ?? []
    if (found === null) return base
    const have = new Set(base.map((app) => app.slug))
    return [...base, ...found.apps.filter((app) => !have.has(app.slug))]
  }, [catalog, found])
  const { shown: matched, total } = useMemo(() => searchCatalog(merged, query, 60), [merged, query])
  // Composio's own matches count even when the words differ from the app's name (a search for "video" finds YouTube).
  const shown = useMemo(() => {
    if (found === null) return matched
    const have = new Set(matched.map((app) => app.slug))
    return [...matched, ...found.apps.filter((app) => !have.has(app.slug))].slice(0, 60)
  }, [matched, found])
  const typed = query.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')

  const connect = async (slug: string): Promise<void> => {
    setBusy(slug)
    try {
      const result = await agent.apps.connect(slug)
      toast(result.message)
      if (result.ok) onClose()
    } catch (cause: unknown) {
      toast(errorText(cause, 'Could not start connecting. Try again.'))
    } finally {
      setBusy('')
    }
  }

  return (
    <Dialog label="Connect an app" onClose={onClose} labelledBy="apps-connect-title" className="connect-dialog">
      <div>
        <span className="eyebrow">CONNECT AN APP</span>
        <h2 className="h2" id="apps-connect-title" style={{ marginTop: 6 }}>
          Which app?
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          The sign-in opens in your own browser. Come back when you are done; this page updates by itself.
        </p>
      </div>
      <Field label="Search apps" value={query} onChange={setQuery} placeholder="Gmail, Notion, Slack..." autoComplete="off" />
      <p className="small muted connect-count" aria-live="polite">
        {catalog === null
          ? 'Loading the apps...'
          : searching
            ? 'Searching all of Composio...'
            : query.trim().length >= 2
              ? `${shown.length} ${shown.length === 1 ? 'match' : 'matches'} across all of Composio`
              : catalogFailed
                ? 'The list of apps could not be loaded. Type an app name to search for it.'
                : total > shown.length
                ? `Showing ${shown.length} of ${total} popular apps. Search to find any of Composio's apps.`
                : `${total} ${total === 1 ? 'app' : 'apps'}. Search to find any of Composio's apps.`}
      </p>
      <div className="app-pick" role="list">
        {shown.map((item) => (
          <button
            key={item.slug}
            type="button"
            role="listitem"
            className="app-pick-row"
            disabled={busy !== ''}
            onClick={() => void connect(item.slug)}
          >
            <AppLogo name={item.name} {...(item.logo === undefined ? {} : { logo: item.logo })} />
            <span className="rt">
              <b>{item.name}</b>
              <span>{item.line}</span>
            </span>
            <span className="app-pick-go">{busy === item.slug ? 'Opening...' : 'Connect'}</span>
          </button>
        ))}
        {catalog !== null && !searching && shown.length === 0 && typed !== '' ? (
          <button type="button" role="listitem" className="app-pick-row" disabled={busy !== ''} onClick={() => void connect(typed)}>
            <AppLogo name={query} />
            <span className="rt">
              <b>Connect "{query.trim()}"</b>
              <span>Not in the list. Composio may still know it by this name.</span>
            </span>
            <span className="app-pick-go">{busy === typed ? 'Opening...' : 'Connect'}</span>
          </button>
        ) : null}
      </div>
      <div className="dialog-actions">
        <Button variant="tonal" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  )
}

// ---- connected apps -----------------------------------------------------------------------------

function RuleSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string
  label: string
  value: AppRule
  onChange: (rule: AppRule) => void
}): JSX.Element {
  return (
    <label className="rule" htmlFor={id}>
      <span>{label}</span>
      <select id={id} className="rule-sel" value={value} onChange={(event) => onChange(event.target.value as AppRule)}>
        {RULES.map((rule) => (
          <option key={rule} value={rule}>
            {RULE_LABELS[rule]}
          </option>
        ))}
      </select>
    </label>
  )
}

function AccountLine({
  account,
  profiles,
  onDisconnect,
}: {
  account: ConnectedAccount
  profiles: AgentProfileInfo[]
  onDisconnect: () => void
}): JSX.Element {
  const pending = account.status === 'pending'
  const failed = account.status === 'failed'
  const sameName = account.label.trim() === '' || account.label === account.appName
  const title = sameName ? account.appName : account.label

  const setRules = (rules: AccountRules): void => {
    agent.apps.setRules(account.id, rules).catch((cause: unknown) => {
      toast(errorText(cause, 'The rule could not be saved.'))
    })
  }

  return (
    <div className="cacct">
      <div className="cacct-top">
        <span className="cacct-name">
          <b>{title}</b>
          {pending ? <span className="pill warn">Waiting for sign-in</span> : null}
          {failed ? <span className="pill mute">Not connected</span> : null}
        </span>
        <Button variant="text" size="sm" className="cacct-off" onClick={onDisconnect} aria-label={`${pending ? 'Cancel' : 'Disconnect'} ${title}`}>
          {pending ? 'Cancel' : 'Disconnect'}
        </Button>
      </div>
      {failed ? <p className="cacct-note">The sign-in did not work. Disconnect it and connect it again.</p> : null}
      {pending ? <p className="cacct-note">The sign-in is open in your browser.</p> : null}
      {pending || failed ? null : (
        <div className="cacct-body">
          <div className="rules">
            <RuleSelect id={`read-${account.id}`} label="Reading" value={account.rules.read} onChange={(read) => setRules({ ...account.rules, read })} />
            <RuleSelect
              id={`change-${account.id}`}
              label="Changing"
              value={account.rules.change}
              onChange={(change) => setRules({ ...account.rules, change })}
            />
          </div>
          {account.rules.change === 'allow' ? <p className="cacct-note">Deleting, paying and anything that cannot be undone still asks you.</p> : null}
          {accountChips(account, profiles)}
        </div>
      )}
    </div>
  )
}

function GroupRow({
  group,
  profiles,
  open,
  onToggle,
  onDisconnect,
}: {
  group: AppGroup
  profiles: AgentProfileInfo[]
  open: boolean
  onToggle: () => void
  onDisconnect: (account: ConnectedAccount) => void
}): JSX.Element {
  const n = group.accounts.length
  const waiting = group.accounts.filter((a) => a.status === 'pending').length
  const failed = group.accounts.filter((a) => a.status === 'failed').length
  const ids = new Set(group.accounts.map((a) => a.id))
  const inProfiles = profiles.filter((p) => p.accounts.some((a) => ids.has(a.id)))
  const one = n === 1 ? group.accounts[0] : undefined
  const line =
    one !== undefined && one.label.trim() !== '' && one.label !== one.appName ? one.label : `${n} ${n === 1 ? 'account' : 'accounts'}`
  const panel = `agrp-${group.app}`

  return (
    <div className={`agrp${open ? ' open' : ''}`}>
      <button type="button" className="agrp-row" aria-expanded={open} aria-controls={panel} onClick={onToggle}>
        <AppLogo name={group.appName} logo={group.logo} />
        <span className="rt">
          <b>{group.appName}</b>
          <span>
            {line}
            {waiting > 0 ? <span className="agrp-warn"> · {waiting} waiting</span> : null}
            {failed > 0 ? <span className="agrp-warn"> · {failed} not connected</span> : null}
          </span>
        </span>
        <span className="agrp-dots" aria-label={inProfiles.length === 0 ? 'In no profile' : `In ${inProfiles.map((p) => p.name).join(', ')}`}>
          {inProfiles.map((p) => (
            <span key={p.id} className="pf agrp-dot" style={tone(p.color)} title={p.name} />
          ))}
        </span>
        {n > 1 ? <span className="agrp-n">{n}</span> : null}
        <span className="agrp-chev">
          <Icon name="chevd" size={18} />
        </span>
      </button>
      {open ? (
        <div className="agrp-body" id={panel}>
          {group.accounts.map((account) => (
            <AccountLine key={account.id} account={account} profiles={profiles} onDisconnect={() => onDisconnect(account)} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** All, then one chip per profile, then New profile: the main way to organise the page. */
function ProfileBar({
  profiles,
  total,
  selected,
  onSelect,
  onNew,
}: {
  profiles: AgentProfileInfo[]
  total: number
  selected: string
  onSelect: (id: string) => void
  onNew: () => void
}): JSX.Element {
  return (
    <div className="pbar" role="tablist" aria-label="Show accounts for">
      <button type="button" role="tab" aria-selected={selected === ''} className={`pbar-chip${selected === '' ? ' on' : ''}`} onClick={() => onSelect('')}>
        All
        <span className="pbar-n">{total}</span>
      </button>
      {profiles.map((p) => (
        <button
          key={p.id}
          type="button"
          role="tab"
          aria-selected={selected === p.id}
          className={`pf pbar-chip prof${selected === p.id ? ' on' : ''}`}
          style={tone(p.color)}
          onClick={() => onSelect(p.id)}
        >
          <ProfileBadge name={p.name} color={p.color} size="sm" />
          {p.name}
          <span className="pbar-n">{p.accounts.length}</span>
        </button>
      ))}
      <button type="button" className="pbar-new" onClick={onNew}>
        <Icon name="plus" size={16} />
        New profile
      </button>
    </div>
  )
}

export function ConnectedAppsSection(): JSX.Element {
  const { status, learned } = useApps()
  const loaded = useProfiles()
  const profiles = loaded ?? []
  const [dialog, setDialog] = useState<'key' | 'replace' | 'connect' | 'removeKey' | null>(null)
  const [leaving, setLeaving] = useState<ConnectedAccount | null>(null)
  const [editing, setEditing] = useState<AgentProfileInfo | 'new' | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [query, setQuery] = useState('')
  const [openApps, setOpenApps] = useState<Set<string>>(new Set())
  const hasKey = status?.hasKey === true
  const accounts = status?.accounts ?? []
  const selected = profiles.find((p) => p.id === selectedId) ?? null
  const shown = filterAccounts(accounts, query, selected)
  const groups = groupAccounts(shown)
  const searching = query.trim() !== ''
  const appCount = groupAccounts(accounts).length

  const toggle = (app: string): void => {
    setOpenApps((now) => {
      const next = new Set(now)
      if (next.has(app)) next.delete(app)
      else next.add(app)
      return next
    })
  }

  return (
    <>
      <section className="hub">
        <SectionHeader
          eyebrow="CONNECTED APPS"
          line={
            hasKey && accounts.length > 0
              ? `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'} in ${appCount} ${appCount === 1 ? 'app' : 'apps'}, grouped by profile`
              : 'Gmail, Calendar, Slack and more, through Composio'
          }
          right={
            hasKey ? (
              <Button size="sm" onClick={() => setDialog('connect')}>
                <Icon name="plus" size={16} />
                Connect an app
              </Button>
            ) : undefined
          }
        />
        {status === null ? (
          <div className="list" style={{ padding: 18 }}>
            <p className="small muted">Looking for your connected apps...</p>
          </div>
        ) : !hasKey ? (
          <div className="apps-empty">
            <div className="apps-empty-head">
              <div className="ri">
                <Icon name="apps" size={22} />
              </div>
              <div className="rt">
                <b>Connect your apps</b>
                <span>
                  Connect Gmail, Calendar, Slack and 500 more apps through Composio, with your own free key. Your agent then reads
                  and acts in them, by the rules you set per account.
                </span>
              </div>
            </div>
            <div className="apps-empty-actions">
              <Button size="sm" onClick={() => setDialog('key')}>
                <Icon name="key" size={16} />
                Add key
              </Button>
              <Button
                variant="tonal"
                size="sm"
                onClick={() => {
                  void agent.shell.openExternal(COMPOSIO_SITE)
                }}
              >
                <Icon name="ext" size={16} />
                Get a free key
              </Button>
            </div>
            {status.message !== '' ? <p className="small apps-note">{status.message}</p> : null}
          </div>
        ) : (
          <div className="hub-card">
            <ProfileBar profiles={profiles} total={accounts.length} selected={selected?.id ?? ''} onSelect={setSelectedId} onNew={() => setEditing('new')} />
            {selected !== null ? (
              <div className="pf hub-prof" style={tone(selected.color)}>
                <ProfileBadge name={selected.name} color={selected.color} />
                <span className="rt">
                  <b>{selected.name}</b>
                  <span>{profileSummary(selected, profiles)}</span>
                </span>
                <Button variant="tonal" size="sm" onClick={() => setEditing(selected)}>
                  <Icon name="edit" size={16} />
                  Edit profile
                </Button>
              </div>
            ) : profiles.length === 0 ? (
              <div className="hub-teach">
                <b>Make your first profile</b>
                <span>Say Work with Slack, Outlook and Teams, or Personal with your own Gmail. Each helper then uses only its profile.</span>
              </div>
            ) : null}
            <label className="hub-search">
              <Icon name="search" size={18} />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={selected === null ? 'Search apps and accounts' : `Search ${selected.name}`}
                aria-label="Search apps and accounts"
              />
              {searching ? (
                <button type="button" className="hub-clear" aria-label="Clear the search" onClick={() => setQuery('')}>
                  <Icon name="x" size={16} />
                </button>
              ) : null}
            </label>
            {status.message !== '' ? <p className="small apps-note apps-warn">{status.message}</p> : null}
            <div className="agrp-list">
              {accounts.length === 0 ? (
                <p className="small muted apps-teach">
                  No apps connected yet. Connect one, or ask your agent: it can connect apps itself when a task needs one.
                </p>
              ) : groups.length === 0 ? (
                <p className="small muted apps-teach">
                  {searching
                    ? `Nothing matches "${query.trim()}"${selected === null ? '' : ` in ${selected.name}`}.`
                    : `No accounts in ${selected?.name ?? 'this profile'} yet. Edit the profile, or add accounts from All.`}
                </p>
              ) : (
                groups.map((group) => (
                  <GroupRow
                    key={group.app}
                    group={group}
                    profiles={profiles}
                    open={searching || openApps.has(group.app)}
                    onToggle={() => toggle(group.app)}
                    onDisconnect={setLeaving}
                  />
                ))
              )}
            </div>
            <div className="hub-key">
              <Icon name="key" size={18} />
              <span className="small">
                <b>Composio key</b> · {KEY_KINDS[status.keyKind]}, encrypted on this computer
              </span>
              <span className="app-key-actions">
                <Button variant="text" size="sm" onClick={() => setDialog('replace')}>
                  Replace
                </Button>
                <Button variant="text" size="sm" onClick={() => setDialog('removeKey')}>
                  Remove
                </Button>
              </span>
            </div>
          </div>
        )}
        {hasKey ? (
          <p className="small muted hub-foot">
            Reading and changing are set per account; Ask me shows a card in Chat first. Each helper works inside one profile and uses
            only what is in it. Your main agent can use everything.
          </p>
        ) : null}
      </section>

      {dialog === 'key' || dialog === 'replace' ? <KeyDialog replacing={dialog === 'replace'} onClose={() => setDialog(null)} /> : null}
      {dialog === 'connect' ? <ConnectDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'removeKey' ? (
        <ConfirmDialog
          eyebrow="CONNECTED APPS"
          title="Remove your Composio key?"
          line="Your agent stops using your connected apps on this computer. The accounts stay connected at Composio, so adding the key again brings them back."
          action="Remove key"
          onConfirm={async () => {
            const result = await agent.apps.setKey('')
            toast(result.message)
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {leaving !== null ? (
        <ConfirmDialog
          eyebrow="CONNECTED APPS"
          title={`Disconnect ${leaving.appName}?`}
          line={`${
            leaving.label !== '' && leaving.label !== leaving.appName ? leaving.label : 'This account'
          } is signed out at Composio and your agent can no longer use it. It leaves every profile. You can connect it again any time.`}
          action="Disconnect"
          onConfirm={async () => {
            await agent.apps.disconnect(leaving.id)
            toast(`Disconnected ${leaving.appName}.`)
          }}
          onClose={() => setLeaving(null)}
        />
      ) : null}
      {editing !== null ? (
        <ProfileDialog
          key={editing === 'new' ? 'new' : editing.id}
          profile={editing === 'new' ? null : (profiles.find((p) => p.id === editing.id) ?? editing)}
          all={profiles}
          accounts={accounts}
          learnedApps={learned ?? []}
          onClose={() => setEditing(null)}
          onMade={(made) => setSelectedId(made.id)}
        />
      ) : null}
    </>
  )
}

/** Sites the agent taught itself, each with the profiles that may run it. */
export function LearnedAppsSection({ bare = false }: { bare?: boolean }): JSX.Element {
  const { learned, learnedFailed, reload } = useApps()
  const profiles = useProfiles() ?? []
  const [removing, setRemoving] = useState<LearnedAppInfo | null>(null)
  return (
    <section className="learned-section">
      {bare ? null : <SectionHeader eyebrow="LEARNED APPS" line="Sites your agent taught itself to use" />}
      {learned === null ? (
        <div className="list" style={{ padding: 18 }}>
          <p className="small muted">Loading...</p>
        </div>
      ) : learnedFailed && learned.length === 0 ? (
        <div className="apps-empty" role="alert">
          <div className="apps-empty-head">
            <div className="ri">
              <Icon name="x" size={22} />
            </div>
            <div className="rt">
              <b>Your learned apps could not be read</b>
              <span>Nothing is lost. Try again in a moment.</span>
            </div>
          </div>
          <div className="apps-empty-actions">
            <Button variant="tonal" size="sm" onClick={reload}>
              Try again
            </Button>
          </div>
        </div>
      ) : learned.length === 0 ? (
        <div className="apps-empty">
          <div className="apps-empty-head">
            <div className="ri">
              <Icon name="globe" size={22} />
            </div>
            <div className="rt">
              <b>Nothing learned yet</b>
              <span>
                Ask your agent to learn a site, for example: Learn news.ycombinator.com so you can read the front page. It maps the
                site once in its own browser and saves tools for it. Deleting, paying and anything that cannot be undone asks you first.
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="hub-card">
          {learnedFailed ? (
            <p className="small apps-note apps-warn">
              The list could not be refreshed, so this may be out of date.{' '}
              <Button variant="text" size="sm" onClick={reload}>
                Try again
              </Button>
            </p>
          ) : null}
          <div className="agrp-list">
            {learned.map((app) => (
              <LearnedRow key={app.id} app={app} profiles={profiles} onRemove={() => setRemoving(app)} />
            ))}
          </div>
        </div>
      )}
      {removing !== null ? (
        <ConfirmDialog
          eyebrow="LEARNED APPS"
          title={`Remove ${removing.name}?`}
          line={`Its ${removing.tools.length} saved ${
            removing.tools.length === 1 ? 'tool is' : 'tools are'
          } deleted. Your sign-in in the agent's browser stays. Your agent can learn it again later.`}
          action="Remove"
          onConfirm={async () => {
            await agent.apps.removeLearned(removing.id)
            toast(`Removed ${removing.name}.`)
          }}
          onClose={() => setRemoving(null)}
        />
      ) : null}
    </section>
  )
}

// ---- learned apps -------------------------------------------------------------------------------

function toolCounts(app: LearnedAppInfo): string {
  const total = app.tools.length
  const changes = app.tools.filter((tool) => !tool.readOnly).length
  const word = total === 1 ? 'tool' : 'tools'
  if (changes === 0) return `${total} ${word}, all read-only`
  return `${total - changes} read, ${changes} ${changes === 1 ? 'changes' : 'change'} things`
}

function LearnedRow({ app, profiles, onRemove }: { app: LearnedAppInfo; profiles: AgentProfileInfo[]; onRemove: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const changes = app.tools.some((tool) => !tool.readOnly)
  const panel = `learned-${app.id}`
  const inProfiles = profiles.filter((p) => p.learned.includes(app.id))

  // One compact row, like a connected app: the site's icon, its name, where and how many tools. The rest opens.
  return (
    <div className={`agrp${open ? ' open' : ''}`}>
      <button type="button" className="agrp-row" aria-expanded={open} aria-controls={panel} onClick={() => setOpen((v) => !v)}>
        <AppLogo name={app.name} {...(app.icon === undefined ? {} : { logo: app.icon })} />
        <span className="rt">
          <b>{app.name}</b>
          <span>
            {app.host} · {toolCounts(app)}
          </span>
        </span>
        <span className="agrp-dots" aria-label={inProfiles.length === 0 ? 'In no profile' : `In ${inProfiles.map((p) => p.name).join(', ')}`}>
          {inProfiles.map((p) => (
            <span key={p.id} className="pf agrp-dot" style={tone(p.color)} title={p.name} />
          ))}
        </span>
        <span className="agrp-chev">
          <Icon name="chevd" size={18} />
        </span>
      </button>
      {open ? (
        <div className="agrp-body learned-body" id={panel}>
          {app.about !== '' ? <p className="learned-about">{app.about}</p> : null}
          <ul className="learned-tools">
            {app.tools.map((tool) => (
              <li key={tool.name}>
                <span className="lt-name">{tool.name.replace(/_/g, ' ')}</span>
                <span className="lt-desc">{tool.description}</span>
                <span className={tool.readOnly ? 'pill ok' : 'pill warn'}>{tool.readOnly ? 'Reads' : 'Changes'}</span>
              </li>
            ))}
          </ul>
          {changes ? (
            <div className="learned-trust">
              <span>
                <b>Ask before every change</b>
                <span>Off: only deleting, paying and anything that cannot be undone asks you</span>
              </span>
              <Switch
                on={app.askFirst === true}
                label={`Ask before every ${app.name} change`}
                onToggle={(next) => {
                  agent.apps.setAskFirst(app.id, next).catch((cause: unknown) => {
                    toast(errorText(cause, 'That could not be saved.'))
                  })
                }}
              />
            </div>
          ) : null}
          <div className="learned-foot">
            <div className="learned-prof">{learnedChips(app, profiles)}</div>
            <Button variant="text" size="sm" onClick={onRemove}>
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
