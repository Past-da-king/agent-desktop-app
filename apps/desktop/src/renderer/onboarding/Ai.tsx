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

  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [provider, setProvider] = useState<ProviderId>(settings?.provider ?? 'anthropic')
  const [model, setModel] = useState(settings?.model ?? '')
  const [baseUrl, setBaseUrl] = useState(settings?.baseUrl ?? '')
  const [allowHttp, setAllowHttp] = useState(settings?.allowHttp ?? false)
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void agent.settings.providers().then((list) => {
      if (!live) return
      setProviders(list)
      setModel((current) => (current.trim() !== '' ? current : (list.find((item) => item.id === provider)?.defaultModel ?? '')))
    })
    return () => {
      live = false
    }
  }, [])

  const info = providers.find((item) => item.id === provider)
  const label = info?.label ?? 'your provider'
  const consoleUrl = CONSOLE_URLS[provider]
  const custom = provider === 'custom'

  const saveProvider = async (): Promise<string> => {
    const modelText = model.trim() || info?.defaultModel || ''
    await save({
      provider,
      model: modelText,
      baseUrl: custom ? baseUrl.trim() : '',
      allowHttp,
    })
    return modelText
  }

  const choose = (value: ProviderId): void => {
    setProvider(value)
    setOk(false)
    setMessage('')
    const next = providers.find((item) => item.id === value)
    setModel(next?.defaultModel ?? '')
  }

  const check = async (): Promise<void> => {
    if (key.trim() === '') {
      setOk(false)
      setMessage('Paste your key first.')
      return
    }
    if (custom && baseUrl.trim() === '') {
      setOk(false)
      setMessage('Add the address of this provider first.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      await saveProvider()
      await agent.settings.setApiKey(key.trim())
      setKey('')
      const result = await agent.settings.checkKey()
      setOk(result.ok)
      setMessage(result.message)
      if (result.ok) await save({ mode: 'api_key' })
    } catch (cause) {
      setOk(false)
      setMessage(cause instanceof Error ? cause.message : 'Could not check that key.')
    } finally {
      setBusy(false)
    }
  }

  const next = async (): Promise<void> => {
    if (!ok) return
    setBusy(true)
    try {
      await saveProvider()
      await save({ mode: 'api_key' })
      navigate({ page: 'onboarding', step: 'style' })
    } finally {
      setBusy(false)
    }
  }

  const skip = async (): Promise<void> => {
    await saveProvider()
    navigate({ page: 'onboarding', step: 'style' })
  }

  return (
    <OnboardingLayout step="ai">
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
            <div className="rowc" title="Coming soon" aria-disabled="true">
              <div className="ri">
                <Icon name="bolt" size={22} />
              </div>
              <div className="rt">
                <b>Claude subscription</b>
                <span>Sign in once in your browser</span>
              </div>
              <span className="pill mute">Coming soon</span>
            </div>
            <div className="rowc" title="Coming soon" aria-disabled="true">
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
          <div className="prov" role="group" aria-label="Provider">
            {providers.map((item) => {
              const active = item.id === provider
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`chip${active ? ' on' : ''}`}
                  aria-pressed={active}
                  onClick={() => choose(item.id)}
                >
                  {active ? <Icon name="check" size={16} /> : null}
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>

        <Field
          label="Model"
          value={model}
          onChange={(value) => {
            setModel(value)
            setOk(false)
            setMessage('')
          }}
          placeholder={info?.defaultModel || 'Model name'}
          autoComplete="off"
        />

        {custom ? (
          <>
            <Field
              label="Base URL"
              type="url"
              value={baseUrl}
              onChange={(value) => {
                setBaseUrl(value)
                setOk(false)
                setMessage('')
              }}
              placeholder="https://api.example.com/v1"
              autoComplete="off"
            />
            <div className="ob-check">
              <Switch
                on={allowHttp}
                onToggle={(value) => {
                  setAllowHttp(value)
                  setOk(false)
                  setMessage('')
                }}
                label="Allow unencrypted HTTP for this provider"
              />
              <span>Allow unencrypted HTTP for this provider</span>
            </div>
          </>
        ) : null}

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
          placeholder={info?.keyHint ?? 'Paste your key'}
          autoComplete="off"
          error={ok ? '' : message}
          ok={ok ? message : ''}
          onEnter={() => {
            void check()
          }}
        />

        <ol className="steps">
          <li>
            <b>1</b>
            <span>Open {label}'s console and sign in.</span>
          </li>
          <li>
            <b>2</b>
            <span>Add a little credit. A few dollars lasts a long time.</span>
          </li>
          <li>
            <b>3</b>
            <span>Create a key, copy it, and paste it above.</span>
          </li>
          {consoleUrl ? (
            <li style={{ marginTop: 2 }}>
              <button
                type="button"
                className="btn sm tonal"
                onClick={() => {
                  void agent.shell.openExternal(consoleUrl)
                }}
              >
                <Icon name="ext" size={16} />
                Open {label}
              </button>
            </li>
          ) : null}
        </ol>

        <Button size="lg" block variant={ok ? 'tonal' : 'fill'} onClick={() => void check()} disabled={busy}>
          Check key
        </Button>

        <Button size="lg" block onClick={() => void next()} disabled={!ok || busy}>
          Continue
          <Icon name="arrow" size={20} />
        </Button>

        <Button variant="text" onClick={() => void skip()} style={{ alignSelf: 'center' }}>
          Skip, I will add it later
        </Button>
      </div>
    </OnboardingLayout>
  )
}
