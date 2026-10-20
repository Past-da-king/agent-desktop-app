import { PROVIDERS } from '@agent/core'
import type { ProviderId, ProviderInfo } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
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
            Your agent runs on an AI service you already pay for. You are only ever billed by them.
          </p>
        </div>

        <div>
          <div className="eyebrow mute" style={{ marginBottom: 8 }}>
            USE A SUBSCRIPTION YOU ALREADY HAVE
          </div>
          <div className="card mid" style={{ padding: 6 }}>
            <div className="rowc" title="Coming soon">
              <div className="ri">
                <Icon name="bolt" size={22} />
              </div>
              <div className="rt">
                <b>Claude subscription</b>
                <span>Sign in once in your browser</span>
              </div>
              <span className="pill mute">Coming soon</span>
            </div>
            <div className="rowc" title="Coming soon">
              <div className="ri">
                <Icon name="bolt" size={22} />
              </div>
              <div className="rt">
                <b>ChatGPT subscription</b>
                <span>Sign in once in your browser</span>
              </div>
              <span className="pill mute">Coming soon</span>
            </div>
          </div>
        </div>

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

        <div className="ob-cta">
          <Button size="lg" block disabled={busy} onClick={() => void cont()}>
            {busy ? 'Checking your key...' : 'Continue'}
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
