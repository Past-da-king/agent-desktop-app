import { PROVIDERS, accountsOf, failoverRule, type AiAccount, type AiAccountKind, type AiAccountStatus, type AiFailoverRole, type AiPicks, type ModelOption, type ProviderId, type ProviderInfo } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { CONSOLE_URLS, kindLine } from '../lib/ai'
import { useSettings } from '../state/useSettings'
import { AiPickRows } from '../ui/AiPickRows'
import { Button } from '../ui/Button'
import { CopyButton } from '../ui/CopyButton'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { ModelList } from '../ui/ModelList'
import { Pill } from '../ui/bits'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'

/**
 * YOUR AI in Settings: every account the person set up (plans and keys), which one the main thread's agent and
 * helpers think with, and a small dialog to add one. Each project can pick its own in its dialog.
 */
export function AiAccounts(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AiAccount | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [status, setStatus] = useState<Record<string, { ok: boolean; message: string }>>({})
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  if (settings === null) return <div className="card" style={{ padding: 16 }} />
  const accounts = accountsOf(settings)

  const check = async (account: AiAccount): Promise<void> => {
    setBusy(account.id)
    try {
      const result = await agent.settings.accounts.check(account.id)
      setStatus((now) => ({ ...now, [account.id]: result }))
    } catch (cause) {
      setStatus((now) => ({ ...now, [account.id]: { ok: false, message: cause instanceof Error ? cause.message : 'Could not check it.' } }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <div className="card ai-accounts" style={{ padding: 10 }}>
        {accounts.length === 0 ? (
          <div className="rowc">
            <div className="ri">
              <Icon name="bolt" size={22} />
            </div>
            <div className="rt">
              <b>No AI account yet</b>
              <span>Add your Claude or ChatGPT plan, or a provider with an API key.</span>
            </div>
          </div>
        ) : (
          accounts.map((account) => {
            const said = status[account.id]
            return (
              <div className="rowc ai-row" key={account.id}>
                <div className={`ri${said?.ok === true ? ' ok' : ''}`}>
                  <Icon name={account.kind === 'api' ? 'key' : 'bolt'} size={22} />
                </div>
                <div className="rt">
                  <b>{account.label}</b>
                  <span>
                    {kindLine(account)}
                    {account.model.trim() === '' ? '' : ` · ${account.model.trim()}`}
                    {said === undefined ? '' : ` · ${said.message}`}
                  </span>
                </div>
                {account.kind === 'api' ? <Pill tone={account.hasKey ? 'ok' : 'mute'}>{account.hasKey ? 'Key saved' : 'No key'}</Pill> : null}
                <div className="ai-row-acts">
                  <Button variant="tonal" size="sm" disabled={busy === account.id} onClick={() => void check(account)}>
                    {busy === account.id ? 'Checking...' : 'Check'}
                  </Button>
                  <Button variant="text" size="sm" onClick={() => setEditing(account)}>
                    Change
                  </Button>
                  {confirmRemove === account.id ? (
                    <>
                      <Button
                        variant="text"
                        size="sm"
                        className="danger"
                        onClick={() => {
                          setConfirmRemove(null)
                          void agent.settings.accounts.remove(account.id).then(() => save({}))
                        }}
                      >
                        Remove it
                      </Button>
                      <Button variant="text" size="sm" onClick={() => setConfirmRemove(null)}>
                        Keep
                      </Button>
                    </>
                  ) : (
                    <Button variant="text" size="sm" onClick={() => setConfirmRemove(account.id)}>
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            )
          })
        )}
        <div className="rowc">
          <div className="ri">
            <Icon name="plus" size={22} />
          </div>
          <div className="rt">
            <b>Add an account</b>
            <span>Another plan or another key. Each project can think with a different one.</span>
          </div>
          <Button variant="tonal" size="sm" onClick={() => setAdding(true)}>
            Add
          </Button>
        </div>
      </div>

      {accounts.length > 0 ? (
        <div className="card" style={{ padding: 14, marginTop: 10 }}>
          <div className="ai-default-h">
            <b>Main thread</b>
            <span className="small muted">What your agent and its helpers think with, unless a project says otherwise.</span>
          </div>
          <AiPickRows settings={settings} picks={settings.ai} onChange={(ai: AiPicks) => void save({ ai })} />
        </div>
      ) : null}

      {adding ? <AccountDialog onClose={() => setAdding(false)} /> : null}
      {editing !== null ? <AccountDialog account={editing} onClose={() => setEditing(null)} /> : null}
    </>
  )
}

/**
 * Add or change one account. A plan needs a sign-in on this computer; a key needs the provider, the key and a model
 * picked from the provider's own list. One primary action: Save once it works.
 */
export function AccountDialog({ account, onClose }: { account?: AiAccount; onClose: () => void }): JSX.Element {
  const save = useSettings((state) => state.save)
  const [kind, setKind] = useState<AiAccountKind>(account?.kind ?? 'api')
  const [label, setLabel] = useState(account?.label ?? '')
  const [provider, setProvider] = useState<ProviderId>(account?.provider ?? 'anthropic')
  const [providers, setProviders] = useState<ProviderInfo[]>(PROVIDERS)
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(account?.baseUrl ?? '')
  const [allowHttp, setAllowHttp] = useState(account?.allowHttp ?? false)
  const [model, setModel] = useState(account?.model ?? '')
  const [models, setModels] = useState<ModelOption[]>([])
  const [message, setMessage] = useState('')
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<AiAccount | null>(account ?? null)

  useEffect(() => {
    let live = true
    void agent.settings
      .providers()
      .then((list) => {
        if (live && list.length > 0) setProviders(list)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const info = providers.find((item) => item.id === provider)
  const custom = provider === 'custom'
  const planName = kind === 'codex' ? 'ChatGPT' : 'Claude'
  const defaultLabel = kind === 'api' ? (info?.label ?? 'API key') : `${planName} plan`

  /** The row as it stands in Settings, made or updated so keys and checks have something to attach to. */
  const ensure = async (): Promise<AiAccount> => {
    const draft = { label: label.trim() || defaultLabel, kind, provider, baseUrl: custom ? baseUrl.trim() : '', model: model.trim(), allowHttp: custom && allowHttp }
    const row = made === null ? await agent.settings.accounts.add(draft) : await agent.settings.accounts.update(made.id, draft)
    setMade(row)
    return row
  }

  const checkKey = async (): Promise<void> => {
    if (key.trim() === '' && !(made?.hasKey ?? false)) {
      setMessage('Paste your key first.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      const row = await ensure()
      if (key.trim() !== '') {
        await agent.settings.accounts.setKey(row.id, key.trim())
        setKey('')
      }
      const listed = await agent.settings.accounts.listModels(row.id)
      if (listed.ok && listed.models.length > 0) {
        setModels(listed.models)
        if (model.trim() === '' || !listed.models.some((m) => m.id === model.trim())) {
          setMessage(`${listed.models.length} models to choose from. Pick one below.`)
          setOk(false)
          return
        }
      } else if (/not accepted|reach/.test(listed.message)) {
        setMessage(listed.message)
        setOk(false)
        return
      } else if (model.trim() === '') {
        setMessage('This provider does not list its models. Type the model name, then check again.')
        setOk(false)
        return
      }
      const result = await agent.settings.accounts.check(row.id)
      setOk(result.ok)
      setMessage(result.message)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not check that key.')
    } finally {
      setBusy(false)
    }
  }

  const pickModel = async (id: string): Promise<void> => {
    setModel(id)
    setBusy(true)
    setMessage(`Checking your key with ${id}`)
    try {
      const row = await agent.settings.accounts.update((await ensure()).id, { model: id })
      setMade(row)
      const result = await agent.settings.accounts.check(row.id)
      setOk(result.ok)
      setMessage(result.ok ? `Your key works with ${id}.` : result.message)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not check that key.')
    } finally {
      setBusy(false)
    }
  }

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setMessage(`Finish signing in to ${planName} in your browser, then come back here.`)
    try {
      const row = await ensure()
      const result = await agent.settings.accounts.signIn(row.id)
      setOk(result.ok)
      setMessage(result.message)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'The sign-in did not finish.')
    } finally {
      setBusy(false)
    }
  }

  const checkPlan = async (): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const row = await ensure()
      const result = await agent.settings.accounts.check(row.id)
      setOk(result.ok)
      setMessage(result.message)
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not reach your plan.')
    } finally {
      setBusy(false)
    }
  }

  const done = async (): Promise<void> => {
    setBusy(true)
    try {
      await ensure()
      await save({})
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog label={account === undefined ? 'Add an AI account' : `Change ${account.label}`} onClose={onClose} className="ai-dialog">
      <span className="eyebrow">{account === undefined ? 'ADD AN ACCOUNT' : 'CHANGE ACCOUNT'}</span>
      <h2 className="h2" style={{ marginTop: 6 }}>
        {account === undefined ? 'Who should do the thinking?' : account.label}
      </h2>

      {account === undefined ? (
        <Segmented
          ariaLabel="Kind of account"
          value={kind}
          onChange={(value) => {
            setKind(value)
            setOk(false)
            setMessage('')
          }}
          options={[
            { value: 'claude', label: 'Claude plan', icon: <Icon name="bolt" size={18} /> },
            { value: 'codex', label: 'ChatGPT plan', icon: <Icon name="bolt" size={18} /> },
            { value: 'api', label: 'API key', icon: <Icon name="key" size={18} /> },
          ]}
        />
      ) : null}

      <Field label="Name" value={label} onChange={setLabel} placeholder={defaultLabel} />

      {kind === 'api' ? (
        <>
          <div className="field">
            <label>Service</label>
            <div className="prov" role="radiogroup" aria-label="Provider">
              {providers.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`chip${item.id === provider ? ' on' : ''}`}
                  role="radio"
                  aria-checked={item.id === provider}
                  onClick={() => {
                    setProvider(item.id)
                    setModels([])
                    setModel('')
                    setOk(false)
                    setMessage('')
                  }}
                >
                  {item.id === provider ? <Icon name="check" size={16} /> : null}
                  {item.id === 'custom' ? 'Other' : item.label}
                </button>
              ))}
            </div>
          </div>
          <Field
            label="API key"
            type="password"
            revealable
            revealLabel="key"
            value={key}
            onChange={(value) => {
              setKey(value)
              setOk(false)
              setMessage('')
            }}
            placeholder={made?.hasKey ? 'A key is already saved for this account' : 'Paste your key'}
            autoComplete="off"
            error={ok ? '' : message}
            ok={ok ? message : ''}
            onEnter={() => void checkKey()}
          />
          {custom ? (
            <>
              <Field label="Server address" type="url" value={baseUrl} onChange={setBaseUrl} placeholder="https://api.example.com/v1" />
              <div className="ob-check">
                <span>Allow unencrypted HTTP</span>
                <Switch label="Allow unencrypted HTTP" on={allowHttp} onToggle={setAllowHttp} />
              </div>
            </>
          ) : null}
          {models.length > 0 ? (
            <div className="ob-models">
              <span className="eyebrow mute">MODEL</span>
              <ModelList models={models} value={model} onPick={(id) => void pickModel(id)} />
            </div>
          ) : (
            <Field label="Model" value={model} onChange={setModel} placeholder="Check your key to see your models" onEnter={() => void checkKey()} />
          )}
          <div className="ob-keyrow">
            <Button variant="tonal" size="sm" onClick={() => void checkKey()} disabled={busy}>
              {busy ? 'Checking...' : 'Check key'}
            </Button>
            <span>
              One tiny request to {info?.label ?? 'the provider'}.{' '}
              {CONSOLE_URLS[provider] !== undefined ? (
                <button type="button" className="linkish" onClick={() => void agent.shell.openExternal(CONSOLE_URLS[provider] ?? '')}>
                  Get a key
                </button>
              ) : null}
            </span>
          </div>
        </>
      ) : (
        <div className="card ai-plan" style={{ padding: 14 }}>
          <p className="small" style={{ margin: 0 }}>
            Runs on the {planName} plan you already pay for, signed in once on this computer. No key and no extra bill.
          </p>
          <div className="ob-keyrow">
            <Button variant="tonal" size="sm" disabled={busy} onClick={() => void checkPlan()}>
              {busy ? 'Checking...' : 'Check'}
            </Button>
            <Button variant="text" size="sm" disabled={busy} onClick={() => void signIn()}>
              Sign in to {planName}
            </Button>
          </div>
          {message !== '' ? (
            <p className={ok ? 'ob-note' : 'ob-note warn'} role="status" style={{ margin: 0 }}>
              {message}
            </p>
          ) : null}
        </div>
      )}

      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={() => void done()}>
          {account === undefined ? 'Add' : 'Save'}
        </Button>
      </div>
    </Dialog>
  )
}

function resetsIn(at: number | null): string {
  if (at === null) return ''
  const minutes = Math.round((at - Date.now()) / 60_000)
  if (minutes <= 0) return 'resetting now'
  if (minutes < 90) return `resets in ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `resets in ${hours} h` : `resets in ${Math.round(hours / 24)} days`
}

/** Who a plan account is signed in as, its plan, and how much of each limit is used (labels from the plan itself). */
export function PlanStatus({
  status,
  onPaste,
  onCancel,
}: {
  status: AiAccountStatus | undefined
  onPaste?: (code: string) => void
  onCancel?: () => void
}): JSX.Element | null {
  if (status === undefined) return null
  return (
    <div className="ai-plan-status">
      {status.signIn === undefined ? null : <SignInBox kind={status.kind} signIn={status.signIn} onPaste={onPaste} onCancel={onCancel} />}
      <div className="ai-who">
        {status.signedIn ? (
          <>
            <span className="ai-email">{status.email === '' ? 'Signed in' : status.email}</span>
            {status.plan === '' ? null : <Pill tone="ok">{status.plan}</Pill>}
            {status.limited ? <Pill tone="mute">At its limit</Pill> : null}
          </>
        ) : (
          <span className="ai-email muted">Not signed in. Use Change, then Sign in.</span>
        )}
        {status.sharedLogin ? <span className="small muted">this computer&apos;s own login</span> : null}
      </div>
      {status.usage.length === 0 ? (
        status.signedIn ? <span className="small muted">Usage shows after the first message on this account.</span> : null
      ) : (
        <div className="ai-bars">
          {status.usage.map((window) => (
            <div className="ai-bar" key={window.label}>
              <div className="ai-bar-h">
                <span>{window.label}</span>
                <span>
                  {Math.round(window.usedPercent)}% used{resetsIn(window.resetsAt) === '' ? '' : ` · ${resetsIn(window.resetsAt)}`}
                </span>
              </div>
              <div className="ai-bar-track" role="progressbar" aria-label={`${window.label} used`} aria-valuenow={Math.round(window.usedPercent)} aria-valuemin={0} aria-valuemax={100}>
                <div className={`ai-bar-fill${window.usedPercent >= 90 ? ' hot' : ''}`} style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

const ROLE_LINES: Array<{ role: AiFailoverRole; title: string; line: string }> = [
  { role: 'main', title: 'Main agent and routines', line: 'Your agent, its chats and routines.' },
  { role: 'helpers', title: 'Helpers', line: 'Helpers, project helpers and desks.' },
]

/**
 * When an account hits its plan's limit: try another signed-in account of the same plan, per role, in this order.
 * Off until switched on.
 */
export function FailoverCard({ settings, accounts, onChange }: { settings: Parameters<typeof failoverRule>[0]; accounts: AiAccount[]; onChange: (ai: AiPicks) => void }): JSX.Element {
  const kinds = (['claude', 'codex'] as const).filter((kind) => accounts.filter((account) => account.kind === kind).length > 1)
  const set = (role: AiFailoverRole, on: boolean, order: string[]): void =>
    onChange({ ...settings.ai, failover: { ...(settings.ai.failover ?? {}), [role]: { on, order } } })
  return (
    <div className="pickwrap ai-failover">
      <div className="ai-default-h">
        <b>When an account hits its limit</b>
        <span className="small muted">Carry on with another signed-in account of the same plan, in this order. It is logged which account ran.</span>
      </div>
      {ROLE_LINES.map(({ role, title, line }) => {
        const rule = failoverRule(settings, role)
        // The order of each plan's accounts: the set order first, then the rest in list order. Never across plans.
        const groups = kinds.map((kind) => {
          const ids = accounts.filter((account) => account.kind === kind).map((account) => account.id)
          return { kind, order: [...rule.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !rule.order.includes(id))] }
        })
        const write = (next: typeof groups): void => set(role, rule.on, next.flatMap((group) => group.order))
        const move = (kind: string, index: number, by: number): void => {
          write(
            groups.map((group) => {
              if (group.kind !== kind) return group
              const order = [...group.order]
              const a = order[index]
              const b = order[index + by]
              if (a === undefined || b === undefined) return group
              order[index] = b
              order[index + by] = a
              return { ...group, order }
            }),
          )
        }
        return (
          <div className="ai-fo-role" key={role}>
            <div className="rowc">
              <div className="rt">
                <b>{title}</b>
                <span>{line}</span>
              </div>
              <Switch on={rule.on} label={`Fail over for ${title}`} onToggle={(on) => set(role, on, groups.flatMap((group) => group.order))} />
            </div>
            {rule.on
              ? groups.map((group) => (
                  <div key={group.kind}>
                    <div className="ai-fo-kind">{group.kind === 'claude' ? 'Claude plans' : 'ChatGPT plans'}</div>
                    <ol className="ai-fo-order">
                      {group.order.map((id, index) => {
                        const account = accounts.find((each) => each.id === id)
                        if (account === undefined) return null
                        return (
                          <li key={id}>
                            <span className="ai-fo-n">{index + 1}</span>
                            <span className="ai-fo-name">{account.label}</span>
                            <Button variant="text" size="sm" disabled={index === 0} onClick={() => move(group.kind, index, -1)} aria-label={`Move ${account.label} up`}>
                              Up
                            </Button>
                            <Button variant="text" size="sm" disabled={index === group.order.length - 1} onClick={() => move(group.kind, index, 1)} aria-label={`Move ${account.label} down`}>
                              Down
                            </Button>
                          </li>
                        )
                      })}
                    </ol>
                  </div>
                ))
              : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * A sign-in that is running for this account: the address to open and the code to enter. Codex shows a one-time code;
 * Claude's page shows a code that is pasted back here. The address also opens in the app's own private window.
 */
function SignInBox({
  kind,
  signIn,
  onPaste,
  onCancel,
}: {
  kind: AiAccountKind
  signIn: NonNullable<AiAccountStatus['signIn']>
  onPaste?: (code: string) => void
  onCancel?: () => void
}): JSX.Element {
  const [pasted, setPasted] = useState('')
  return (
    <div className="ai-signin" role="group" aria-label="Sign in">
      <b>{kind === 'codex' ? 'Sign in to ChatGPT' : 'Sign in to Claude'}</b>
      <span className="small muted">
        {kind === 'codex'
          ? 'Open the address in any browser signed in to the right account, and enter this code.'
          : 'Open the address, sign in to the right account, then paste the code the page shows.'}
      </span>
      <div className="ai-signin-url">
        <code>{signIn.url}</code>
        <CopyButton text={signIn.url} label="Copy address" />
      </div>
      {kind === 'codex' && signIn.code !== '' ? (
        <div className="ai-signin-code">
          <span aria-label="One-time code">{signIn.code}</span>
          <CopyButton text={signIn.code} label="Copy code" />
        </div>
      ) : null}
      {signIn.needsPaste ? (
        <div className="ai-signin-paste">
          <Field label="Code from the page" value={pasted} onChange={setPasted} onEnter={() => pasted.trim() !== '' && onPaste?.(pasted)} />
          <Button variant="tonal" size="sm" disabled={pasted.trim() === ''} onClick={() => onPaste?.(pasted)}>
            Submit code
          </Button>
        </div>
      ) : null}
      <div>
        <Button variant="text" size="sm" onClick={onCancel}>
          Cancel sign-in
        </Button>
      </div>
    </div>
  )
}
