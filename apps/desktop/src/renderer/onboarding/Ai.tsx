import { PROVIDERS } from '@agent/core'
import type { Found, ProviderId, ProviderInfo } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { OnboardingLayout } from './OnboardingLayout'

const CONSOLE_URLS: Partial<Record<ProviderId, string>> = {
  anthropic: 'https://console.anthropic.com',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  deepseek: 'https://platform.deepseek.com/api_keys',
  opencode_go: 'https://opencode.ai/auth',
  opencode_zen: 'https://opencode.ai/auth',
  openrouter: 'https://openrouter.ai/keys',
}

export function Ai(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const [providers, setProviders] = useState<ProviderInfo[]>(PROVIDERS)
  const initialProvider = settings?.provider ?? 'anthropic'
  const initialInfo = PROVIDERS.find((item) => item.id === initialProvider)
  const [provider, setProvider] = useState<ProviderId>(initialProvider)
  const [model, setModel] = useState(settings?.model || initialInfo?.defaultModel || '')
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? '')
  const [allowHttp, setAllowHttp] = useState(settings?.allowHttp ?? false)
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const [ok, setOk] = useState(settings?.hasKey ?? false)
  const [busy, setBusy] = useState(false)
  // Two ways to power the agent: the person's own Claude plan through Claude Code, or an API key.
  const [way, setWay] = useState<'plan' | 'key'>(settings?.mode === 'api_key' ? 'key' : 'plan')
  const [claude, setClaude] = useState<Found | null | undefined>(undefined)
  const [others, setOthers] = useState<Found[]>([])
  const [planOk, setPlanOk] = useState(settings?.mode === 'subscription')
  const [planMessage, setPlanMessage] = useState('')

  useEffect(() => {
    let live = true
    void agent.environment
      .scan()
      .then((report) => {
        if (!live) return
        const found = report.aiTools.find((tool) => tool.id === 'claude')
        setClaude(found?.found === true ? found : null)
        setOthers(report.aiTools.filter((tool) => tool.id !== 'claude' && tool.found))
        if (found?.found !== true && settings?.mode !== 'subscription') setWay('key')
      })
      .catch(() => {
        if (live) setClaude(null)
      })
    return () => {
      live = false
    }
    // Scan once when the step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const usePlan = async (): Promise<void> => {
    if (planOk) {
      navigate({ page: 'onboarding', step: 'style' })
      return
    }
    setBusy(true)
    setPlanMessage('')
    try {
      await save({ mode: 'subscription', cli: 'claude' })
      const result = await agent.settings.checkCli()
      setPlanOk(result.ok)
      setPlanMessage(result.message)
      if (result.ok) navigate({ page: 'onboarding', step: 'style' })
    } catch (cause) {
      setPlanMessage(cause instanceof Error ? cause.message : 'Could not reach Claude Code.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let live = true
    void agent.settings
      .providers()
      .then((list) => {
        if (live && list.length > 0) setProviders(list)
      })
      .catch(() => {
        // The built-in catalogue is a safe fallback if the main process cannot answer.
      })
    return () => {
      live = false
    }
  }, [])

  const info = providers.find((item) => item.id === provider) ?? PROVIDERS.find((item) => item.id === provider)
  const label = info?.label ?? 'Provider'
  const consoleUrl = CONSOLE_URLS[provider]
  const custom = provider === 'custom'

  const choose = (value: ProviderId): void => {
    setProvider(value)
    setOk(false)
    setMessage('')
    const next = providers.find((item) => item.id === value) ?? PROVIDERS.find((item) => item.id === value)
    setModel(next?.defaultModel ?? '')
    void save({ provider: value, model: next?.defaultModel ?? '' })
  }

  const check = async (): Promise<boolean> => {
    const current = key.trim()
    if (current === '' && !settings?.hasKey) {
      setMessage('Paste your key first.')
      return false
    }
    setBusy(true)
    setMessage('')
    try {
      await save({
        provider,
        model: model.trim() || info?.defaultModel || '',
        baseUrl: custom ? baseUrl.trim() : '',
        allowHttp,
      })
      if (current !== '') {
        await agent.settings.setApiKey(current)
        setKey('')
      }
      const result = await agent.settings.checkKey()
      setOk(result.ok)
      setMessage(result.message)
      if (result.ok) await save({ mode: 'api_key', provider })
      return result.ok
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not check that key.')
      return false
    } finally {
      setBusy(false)
    }
  }

  const skip = async (): Promise<void> => {
    await save({ mode: ok ? 'api_key' : 'none', provider, model: model.trim() || info?.defaultModel || '' })
    navigate({ page: 'onboarding', step: 'style' })
  }

  const cont = async (): Promise<void> => {
    // One primary action: if the key has not been checked yet, check it first and only move on when it works.
    if (!ok && !(await check())) return
    await save({
      mode: 'api_key',
      provider,
      model: model.trim() || info?.defaultModel || '',
      baseUrl: custom ? baseUrl.trim() : '',
      allowHttp,
    })
    navigate({ page: 'onboarding', step: 'style' })
  }

  return (
    <OnboardingLayout step="ai" onBack={() => navigate({ page: 'onboarding', step: 'sync' })}>
      <div className="ob-col" style={{ gap: 12 }}>
        <div>
          <div className="eyebrow">YOUR AI</div>
          <h1 className="h1" style={{ marginTop: 8 }}>
            Who should do the thinking?
          </h1>
          <p className="muted" style={{ marginTop: 8, fontSize: 15 }}>
            Use the Claude plan you already pay for, or bring an API key. You are only ever billed by them.
          </p>
        </div>

        <Segmented
          ariaLabel="How your agent thinks"
          value={way}
          onChange={(value) => setWay(value)}
          options={[
            { value: 'plan', label: 'Your Claude plan', icon: <Icon name="bolt" size={18} /> },
            { value: 'key', label: 'An API key', icon: <Icon name="key" size={18} /> },
          ]}
        />

        {way === 'plan' ? (
          <div className="ob-plan">
            {claude === undefined ? (
              <div className="rowc">
                <div className="ri">
                  <Icon name="search" size={22} />
                </div>
                <div className="rt">
                  <b>Looking for Claude Code</b>
                  <span>Checking what is installed on this computer</span>
                </div>
              </div>
            ) : claude === null ? (
              <div className="rowc">
                <div className="ri">
                  <Icon name="bolt" size={22} />
                </div>
                <div className="rt">
                  <b>Claude Code is not on this computer</b>
                  <span>
                    Install it, sign in once with your Claude account, then come back. Or use an API key instead.
                  </span>
                </div>
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={() => {
                    void agent.shell.openExternal('https://claude.com/claude-code')
                  }}
                >
                  Get Claude Code
                </Button>
              </div>
            ) : (
              <div className="rowc">
                <div className="ri ok">
                  <Icon name="check" size={22} />
                </div>
                <div className="rt">
                  <b>Claude Code{claude.version !== undefined ? ` ${claude.version}` : ''}</b>
                  <span>Found on this computer. Your agent thinks on your Claude plan, with no API key.</span>
                </div>
                <span className="pill ok">Found</span>
              </div>
            )}
            {others.map((tool) => (
              <div className="rowc" key={tool.id} title="Coming soon">
                <div className="ri">
                  <Icon name="bolt" size={22} />
                </div>
                <div className="rt">
                  <b>{tool.label}</b>
                  <span>Found on this computer. Support is on the way.</span>
                </div>
                <span className="pill mute">Coming soon</span>
              </div>
            ))}
            {planMessage !== '' ? (
              <p className={planOk ? 'ob-note' : 'ob-note warn'} role="status">
                {planMessage}
              </p>
            ) : (
              <p className="ob-note">
                Everything still goes through the app: it asks before anything leaves this computer, and it only
                uses the folders you allow.
              </p>
            )}
          </div>
        ) : null}

        {way === 'key' ? (
          <>
        <div>
          <div className="eyebrow mute" style={{ marginBottom: 10 }}>
            OR BRING AN API KEY
          </div>
          <div className="prov" role="radiogroup" aria-label="Provider">
            {providers.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip${item.id === provider ? ' on' : ''}`}
                role="radio"
                aria-checked={item.id === provider}
                onClick={() => choose(item.id)}
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
            setMessage('')
            setOk(false)
          }}
          placeholder={settings?.hasKey ? 'A key is already saved on this computer' : 'Paste your key'}
          autoComplete="off"
          error={ok ? '' : message}
          ok={ok ? message : ''}
          onEnter={() => {
            void check()
          }}
        />

        <Field
          label="Model"
          value={model}
          onChange={(value) => {
            setModel(value)
            setOk(false)
            setMessage('')
          }}
          placeholder={info?.defaultModel ?? 'Model name'}
          onEnter={() => {
            void check()
          }}
        />

        <div className="ob-keyrow">
          <Button variant="tonal" size="sm" onClick={() => void check()} disabled={busy}>
            {busy ? 'Checking...' : 'Check key'}
          </Button>
          <span>One tiny request to {label}, so you know it works before you go on.</span>
        </div>

        {custom ? (
          <div className="card" style={{ padding: 16 }}>
            <Field
              label="Base URL"
              type="url"
              value={baseUrl}
              onChange={(value) => {
                setBaseUrl(value)
                setOk(false)
              }}
              placeholder="https://api.example.com/v1"
            />
            <div className="ob-check">
              <span>Allow unencrypted HTTP</span>
              <Switch
                label="Allow unencrypted HTTP"
                on={allowHttp}
                onToggle={(next) => {
                  setAllowHttp(next)
                  setOk(false)
                }}
              />
            </div>
          </div>
        ) : null}

        <ol className="steps">
          <li>
            <b>1</b>
            <span>
              Open {label}'s console and sign in.{' '}
              {consoleUrl ? (
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    void agent.shell.openExternal(consoleUrl)
                  }}
                >
                  Open {label}
                </button>
              ) : null}
            </span>
          </li>
          <li>
            <b>2</b>
            <span>Add a little credit. A few dollars lasts a long time.</span>
          </li>
          <li>
            <b>3</b>
            <span>Create a key, copy it, and paste it above.</span>
          </li>
        </ol>

          </>
        ) : null}

        <div className="ob-cta">
          <Button
            size="lg"
            block
            disabled={busy || (way === 'plan' && claude === null)}
            onClick={() => void (way === 'plan' ? usePlan() : cont())}
          >
            {busy ? (way === 'plan' ? 'Checking Claude Code...' : 'Checking your key...') : 'Continue'}
            <Icon name="arrow" size={20} />
          </Button>
          <Button variant="text" onClick={() => void skip()} style={{ alignSelf: 'center' }}>
            Skip, I will add it later
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  )
}
