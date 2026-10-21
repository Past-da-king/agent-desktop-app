import { PROVIDERS, accountsOf, type AiAccount, type AiAccountKind, type AiPicks, type ModelOption, type ProviderId, type ProviderInfo } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { CONSOLE_URLS, kindLine } from '../lib/ai'
import { useSettings } from '../state/useSettings'
import { AiPickRows } from '../ui/AiPickRows'
import { Button } from '../ui/Button'
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
