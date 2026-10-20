import { PROVIDERS } from '@agent/core'
import type { ProviderId } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { OnboardingLayout } from './OnboardingLayout'

const SHOWN_PROVIDERS = PROVIDERS.filter((item) =>
  ['anthropic', 'openai', 'gemini', 'deepseek', 'openrouter', 'custom'].includes(item.id),
)

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
  const [provider, setProvider] = useState<ProviderId>(settings?.provider ?? 'anthropic')
  const [key, setKey] = useState('')
  const [message, setMessage] = useState('')
  const [ok, setOk] = useState(settings?.hasKey ?? false)
  const [busy, setBusy] = useState(false)

  const info = PROVIDERS.find((item) => item.id === provider)
  const label = info?.label ?? 'Provider'
  const consoleUrl = CONSOLE_URLS[provider]

  const choose = (value: ProviderId): void => {
    setProvider(value)
    setOk(false)
    setMessage('')
    const next = PROVIDERS.find((item) => item.id === value)
    void save({ provider: value, model: next?.defaultModel ?? '' })
  }

  const check = async (): Promise<void> => {
    if (ok) {
      navigate({ page: 'onboarding', step: 'style' })
      return
    }
    if (key.trim() === '') {
      setMessage('Paste your key first.')
      return
    }
    setBusy(true)
    setMessage('')
    try {
      await agent.settings.setApiKey(key.trim())
      const result = await agent.settings.checkKey()
      setOk(result.ok)
      setMessage(result.message)
      if (result.ok) await save({ mode: 'api_key', provider })
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not check that key.')
    } finally {
      setBusy(false)
    }
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
            {SHOWN_PROVIDERS.map((item) => (
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
          label={`${label} API key`}
          type="password"
          revealable
          revealLabel="key"
          value={key}
          onChange={(value) => {
            setKey(value)
            setMessage('')
            setOk(false)
          }}
          placeholder="Paste your key"
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

        <Button size="lg" block onClick={() => void check()} disabled={busy}>
          {busy ? 'Checking...' : ok ? 'Continue' : 'Check key'}
          {ok ? <Icon name="arrow" size={20} /> : null}
        </Button>
        <Button variant="text" onClick={() => navigate({ page: 'onboarding', step: 'style' })} style={{ alignSelf: 'center' }}>
          Skip for now
        </Button>
      </div>
    </OnboardingLayout>
  )
}
