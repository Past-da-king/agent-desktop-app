/**
 * The two Connections sections that reach outside this computer: connected apps (Composio, with the
 * person's own key) and learned apps (sites the agent mapped once in its own browser).
 * Everything goes through window.agent.apps; the key never comes back to the renderer.
 */
import type { AccountRules, AppChoice, AppRule, AppsStatus, ConnectedAccount, LearnedAppInfo } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { agent } from '../bridge'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'

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

function Avatar({ name }: { name: string }): JSX.Element {
  const letter = name.trim().charAt(0).toUpperCase() || '?'
  return (
    <div className={`ri app-av ${toneFor(name)}`} aria-hidden="true">
      {letter}
    </div>
  )
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

/** Live accounts, key state and learned apps, reloaded whenever the main process says they changed. */
function useApps(): { status: AppsStatus | null; learned: LearnedAppInfo[] | null; reload: () => void } {
  const [status, setStatus] = useState<AppsStatus | null>(null)
  const [learned, setLearned] = useState<LearnedAppInfo[] | null>(null)
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
        if (live) setLearned(next)
      })
      .catch(() => {
        if (live) setLearned([])
      })
    return () => {
      live = false
    }
  }, [tick])

  useEffect(() => agent.apps.onChanged(() => setTick((n) => n + 1)), [])

  return { status, learned, reload: () => setTick((n) => n + 1) }
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

  useEffect(() => {
    let live = true
    agent.apps
      .catalog()
      .then((list) => {
        if (live) setCatalog(list)
      })
      .catch(() => {
        if (live) setCatalog([])
      })
    return () => {
      live = false
    }
  }, [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = catalog ?? []
    if (q === '') return list
    return list.filter((item) => item.name.toLowerCase().includes(q) || item.line.toLowerCase().includes(q) || item.slug.includes(q))
  }, [catalog, query])

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
    <Dialog label="Connect an app" onClose={onClose} labelledBy="apps-connect-title">
      <div>
        <span className="eyebrow">CONNECT AN APP</span>
        <h2 className="h2" id="apps-connect-title" style={{ marginTop: 6 }}>
          Which app?
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          The sign-in opens in your own browser. Come back here when you are done; this page updates by itself.
        </p>
      </div>
      <Field label="Search" value={query} onChange={setQuery} placeholder="Gmail, Notion, Slack..." autoComplete="off" />
      <div className="app-pick" role="list">
        {catalog === null ? (
          <p className="small muted">Loading the apps...</p>
        ) : (
          shown.map((item) => (
            <button
              key={item.slug}
              type="button"
              role="listitem"
              className="app-pick-row"
              disabled={busy !== ''}
              onClick={() => void connect(item.slug)}
            >
              <Avatar name={item.name} />
              <span className="rt">
                <b>{item.name}</b>
                <span>{item.line}</span>
              </span>
              <span className="app-pick-go">{busy === item.slug ? 'Opening...' : 'Connect'}</span>
            </button>
          ))
        )}
        {catalog !== null && shown.length === 0 && typed !== '' ? (
          <button type="button" role="listitem" className="app-pick-row" disabled={busy !== ''} onClick={() => void connect(typed)}>
            <Avatar name={query} />
            <span className="rt">
              <b>Connect "{query.trim()}"</b>
              <span>Composio has more than 500 apps. Try it by name.</span>
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

function AccountRow({ account, onDisconnect }: { account: ConnectedAccount; onDisconnect: () => void }): JSX.Element {
  const pending = account.status === 'pending'
  const failed = account.status === 'failed'
  const sameName = account.label.trim() === '' || account.label === account.appName
  const line = pending
    ? 'The sign-in is open in your browser'
    : failed
      ? 'The sign-in did not work. Disconnect and connect it again.'
      : sameName
        ? 'Connected'
        : account.label

  const setRules = (rules: AccountRules): void => {
    agent.apps.setRules(account.id, rules).catch((cause: unknown) => {
      toast(errorText(cause, 'The rule could not be saved.'))
    })
  }

  return (
    <div className="app-acct">
      <div className="rowc">
        <Avatar name={account.appName} />
        <div className="rt">
          <b>{account.appName}</b>
          <span>{line}</span>
        </div>
        {pending ? <span className="pill warn">Waiting for sign-in</span> : null}
        {failed ? <span className="pill mute">Not connected</span> : null}
        <Button variant="text" size="sm" onClick={onDisconnect}>
          {pending ? 'Cancel' : 'Disconnect'}
        </Button>
      </div>
      {pending || failed ? null : (
        <div className="rules">
          <RuleSelect
            id={`read-${account.id}`}
            label="Reading"
            value={account.rules.read}
            onChange={(read) => setRules({ ...account.rules, read })}
          />
          <RuleSelect
            id={`change-${account.id}`}
            label="Changing"
            value={account.rules.change}
            onChange={(change) => setRules({ ...account.rules, change })}
          />
        </div>
      )}
    </div>
  )
}

export function ConnectedAppsSection(): JSX.Element {
  const { status, learned } = useApps()
  const [dialog, setDialog] = useState<'key' | 'replace' | 'connect' | 'removeKey' | null>(null)
  const [leaving, setLeaving] = useState<ConnectedAccount | null>(null)
  const [removing, setRemoving] = useState<LearnedAppInfo | null>(null)
  const hasKey = status?.hasKey === true
  const accounts = status?.accounts ?? []

  return (
    <>
      <section>
        <SectionHeader
          eyebrow="CONNECTED APPS"
          line="Gmail, Calendar, Slack and more, through Composio"
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
          <div className="list" style={{ padding: 6 }}>
            {status.message !== '' ? <p className="small apps-note apps-warn">{status.message}</p> : null}
            {accounts.length === 0 ? (
              <p className="small muted apps-teach">
                No apps connected yet. Connect one, or ask your agent: it can connect apps itself when a task needs one.
              </p>
            ) : (
              accounts.map((account) => (
                <AccountRow key={account.id} account={account} onDisconnect={() => setLeaving(account)} />
              ))
            )}
            <div className="rowc app-key">
              <div className="ri">
                <Icon name="key" size={20} />
              </div>
              <div className="rt">
                <b>Composio key</b>
                <span>{KEY_KINDS[status.keyKind]}, encrypted on this computer</span>
              </div>
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
          <p className="small muted" style={{ margin: '10px 6px 0', lineHeight: 1.5 }}>
            Reading and changing are set per account. Ask me shows you a card in Chat before anything runs.
          </p>
        ) : null}
      </section>

      <section>
        <SectionHeader eyebrow="LEARNED APPS" line="Sites your agent taught itself to use" />
        {learned === null ? (
          <div className="list" style={{ padding: 18 }}>
            <p className="small muted">Loading...</p>
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
                  Ask your agent to learn a site, for example: Learn news.ycombinator.com so you can read the front page. It maps
                  the site once in its own browser and saves tools that read it. Anything that changes something asks you first.
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="list" style={{ padding: 6 }}>
            {learned.map((app) => (
              <LearnedRow key={app.id} app={app} onRemove={() => setRemoving(app)} />
            ))}
          </div>
        )}
      </section>

      {dialog === 'key' || dialog === 'replace' ? (
        <KeyDialog replacing={dialog === 'replace'} onClose={() => setDialog(null)} />
      ) : null}
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
          } is signed out at Composio and your agent can no longer use it. You can connect it again any time.`}
          action="Disconnect"
          onConfirm={async () => {
            await agent.apps.disconnect(leaving.id)
            toast(`Disconnected ${leaving.appName}.`)
          }}
          onClose={() => setLeaving(null)}
        />
      ) : null}
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
    </>
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

function LearnedRow({ app, onRemove }: { app: LearnedAppInfo; onRemove: () => void }): JSX.Element {
  const [open, setOpen] = useState(false)
  const changes = app.tools.some((tool) => !tool.readOnly)
  const listId = `learned-tools-${app.id}`

  return (
    <div className="app-acct">
      <div className="rowc">
        <Avatar name={app.name} />
        <div className="rt">
          <b>{app.name}</b>
          <span className="rt-line">{app.host}</span>
          <span className="rt-line">{toolCounts(app)}</span>
        </div>
        <span className="app-key-actions">
          <Button variant="text" size="sm" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide tools' : 'Tools'}
          </Button>
          <Button variant="text" size="sm" onClick={onRemove}>
            Remove
          </Button>
        </span>
      </div>
      {app.about !== '' ? <p className="learned-about">{app.about}</p> : null}
      {open ? (
        <ul className="learned-tools" id={listId}>
          {app.tools.map((tool) => (
            <li key={tool.name}>
              <span className="lt-name">{tool.name.replace(/_/g, ' ')}</span>
              <span className="lt-desc">{tool.description}</span>
              <span className={tool.readOnly ? 'pill ok' : 'pill warn'}>{tool.readOnly ? 'Reads' : 'Changes'}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {changes ? (
        <div className="learned-trust">
          <span>
            <b>Let changes run without asking</b>
            <span>Off: you approve each change in Chat first</span>
          </span>
          <Switch
            on={app.trusted}
            label={`Let ${app.name} changes run without asking`}
            onToggle={(next) => {
              agent.apps.setTrusted(app.id, next).catch((cause: unknown) => {
                toast(errorText(cause, 'That could not be saved.'))
              })
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
