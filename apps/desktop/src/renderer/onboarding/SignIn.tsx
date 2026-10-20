import { useState } from 'react'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { Segmented } from '../ui/Segmented'
import { OnboardingLayout } from './OnboardingLayout'

type Mode = 'in' | 'new'

export function SignIn(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const [mode, setMode] = useState<Mode>('in')
  const [email, setEmail] = useState(settings?.syncEmail ?? '')
  const [password, setPassword] = useState('')
  const [serverUrl, setServerUrl] = useState(settings?.syncUrl ?? '')
  const [emailError, setEmailError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const create = mode === 'new'

  const submit = async (): Promise<void> => {
    const clean = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      setEmailError('That email address does not look right.')
      return
    }
    if (password.length < 6) {
      setError(create ? 'Use at least 6 characters.' : 'The password is at least 6 characters.')
      return
    }
    setEmailError('')
    setError('')
    setBusy(true)
    try {
      const result = await agent.account.signIn({
        serverUrl,
        email: clean,
        password,
        mode: create ? 'register' : 'login',
      })
      if (!result.ok) {
        setError(result.error)
        setBusy(false)
        return
      }
      navigate({ page: 'onboarding', step: 'sync' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in. Try again.')
      setBusy(false)
    }
  }

  const localOnly = async (): Promise<void> => {
    try {
      await agent.account.signOut()
    } catch {
      // Signing out of nothing is fine.
    }
    navigate({ page: 'onboarding', step: 'sync' })
  }

  return (
    <OnboardingLayout step="signin">
      <form
        className="ob-col"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div>
          <div className="eyebrow">{create ? 'NEW HERE' : 'WELCOME BACK'}</div>
          <h1 className="h1" style={{ marginTop: 8 }}>
            {create ? 'Make your account' : 'Sign in to your agent'}
          </h1>
          <p className="muted" style={{ marginTop: 8, fontSize: 15 }}>
            {create
              ? 'One account keeps your phone and computer in step.'
              : 'Use the account from your phone, and your agent comes with you.'}
          </p>
        </div>

        <Segmented
          ariaLabel="Sign in or create an account"
          value={mode}
          onChange={(value) => {
            setMode(value)
            setError('')
          }}
          options={[
            { value: 'in', label: 'Sign in' },
            { value: 'new', label: 'Create account' },
          ]}
        />

        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(value) => {
            setEmail(value)
            setEmailError('')
            setError('')
          }}
          autoComplete="email"
          placeholder="you@example.com"
          error={emailError}
          onEnter={() => {
            void submit()
          }}
        />
        <Field
          label="Password"
          type="password"
          revealable
          value={password}
          onChange={(value) => {
            setPassword(value)
            setError('')
          }}
          autoComplete={create ? 'new-password' : 'current-password'}
          placeholder={create ? 'At least 6 characters' : 'Your password'}
          error={error}
          onEnter={() => {
            void submit()
          }}
        />

        <Button type="submit" size="lg" block disabled={busy}>
          {busy ? 'One moment...' : create ? 'Create account' : 'Sign in'}
          <Icon name="arrow" size={20} />
        </Button>

        <div className="or">or</div>

        <div className="qr">
          <div className="qrbox" aria-hidden="true">
            <Icon name="phone" size={40} />
          </div>
          <div>
            <div className="h3">Sign in with your phone</div>
            <p className="muted small" style={{ margin: '6px 0 10px', lineHeight: 1.5 }}>
              Open Agent on your phone, tap your picture, then Add a computer, and scan the code. Nothing to type.
            </p>
            <Button variant="tonal" size="sm" comingSoon>
              I scanned it
            </Button>
            <div style={{ marginTop: 8 }}>
              <span className="pill mute">Coming soon</span>
            </div>
          </div>
        </div>

        <Button
          variant="text"
          onClick={() => {
            void localOnly()
          }}
          style={{ alignSelf: 'center' }}
        >
          Use this computer only, no account
        </Button>

        <details className="adv">
          <summary>Advanced</summary>
          <Field
            label="Server address"
            type="url"
            value={serverUrl}
            onChange={(value) => {
              setServerUrl(value)
              setError('')
            }}
            autoComplete="url"
            placeholder="https://sync.example.com"
          />
          <p className="ob-note">
            Leave this empty if you are not syncing yet. Nothing is hardcoded, so the app asks where your sync server
            lives.
          </p>
        </details>
      </form>
    </OnboardingLayout>
  )
}
