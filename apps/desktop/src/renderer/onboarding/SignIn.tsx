import { useRef, useState } from 'react'

import { agent } from '../bridge'
import { clearLocalOnly, rememberLocalOnly } from '../state/onboarding'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { OnboardingLayout } from './OnboardingLayout'

type Mode = 'in' | 'new'

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function SignIn(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)

  const [mode, setMode] = useState<Mode>('in')
  const [email, setEmail] = useState(settings?.syncEmail ?? '')
  const [password, setPassword] = useState('')
  const [serverUrl, setServerUrl] = useState(settings?.syncUrl ?? '')
  const [allowHttp, setAllowHttp] = useState(settings?.allowHttp ?? false)
  const [advanced, setAdvanced] = useState(false)
  const [emailError, setEmailError] = useState('')
  const [serverError, setServerError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const serverRef = useRef<HTMLInputElement>(null)

  const create = mode === 'new'
  const signedInAs = settings?.signedIn === true ? (settings.syncEmail ?? '') : ''

  const differentAccount = async (): Promise<void> => {
    try {
      await agent.account.signOut()
    } catch {
      // There may be nothing to sign out of.
    }
    clearLocalOnly()
    setPassword('')
    setEmail('')
    setError('')
  }

  const submit = async (): Promise<void> => {
    const clean = email.trim()
    const address = serverUrl.trim()
    if (!EMAIL_SHAPE.test(clean)) {
      setEmailError('That email address does not look right.')
      return
    }
    if (password.length < 6) {
      setError(create ? 'Use a password of at least 6 characters.' : 'That password is too short.')
      return
    }
    setEmailError('')
    setServerError('')
    setError('')
    setBusy(true)
    try {
      await save({ syncUrl: address, allowHttp })
      const result = await agent.account.signIn({
        serverUrl: address,
        email: clean,
        password,
        mode: create ? 'register' : 'login',
      })
      if (!result.ok) {
        if (address === '') {
          setServerError(result.error)
          setAdvanced(true)
          setError('Where does your sync server live? Add its address, or use this computer only.')
          window.setTimeout(() => serverRef.current?.focus(), 50)
        } else {
          setError(result.error)
          if (/server|address|http/i.test(result.error)) {
            setServerError(result.error)
            setAdvanced(true)
          }
        }
        setBusy(false)
        return
      }
      clearLocalOnly()
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
    rememberLocalOnly()
    navigate({ page: 'onboarding', step: 'ai' })
  }

  if (signedInAs !== '') {
    return (
      <OnboardingLayout step="signin">
        <div className="ob-col">
          <div>
            <div className="eyebrow">WELCOME BACK</div>
            <h1 className="h1" style={{ marginTop: 8 }}>
              You are signed in
            </h1>
            <p className="muted" style={{ marginTop: 8, fontSize: 15 }}>
              Signed in as {signedInAs}. Your agent can bring your memory, to-dos and chats over to this computer.
            </p>
          </div>

          <div className="card mid">
            <div className="rowc" style={{ padding: 0 }}>
              <div className="ri">
                <Icon name="person" size={22} />
              </div>
              <div className="rt">
                <b>{signedInAs}</b>
                <span>{settings?.syncUrl || 'Your sync server'}</span>
              </div>
              <span className="pill ok">Signed in</span>
            </div>
          </div>

          <Button size="lg" block onClick={() => navigate({ page: 'onboarding', step: 'sync' })}>
            Continue
            <Icon name="arrow" size={20} />
          </Button>
          <Button variant="text" onClick={() => void differentAccount()} style={{ alignSelf: 'center' }}>
            Use a different account
          </Button>
        </div>
      </OnboardingLayout>
    )
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

        <details className="adv" open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
          <summary>Advanced</summary>
          <Field
            label="Server address"
            type="url"
            inputRef={serverRef}
            value={serverUrl}
            onChange={(value) => {
              setServerUrl(value)
              setServerError('')
              setError('')
            }}
            autoComplete="url"
            placeholder="https://sync.example.com"
            error={serverError}
          />
          <div className="ob-check">
            <Switch
              on={allowHttp}
              onToggle={setAllowHttp}
              label="Allow unencrypted HTTP for this server"
            />
            <span>Allow unencrypted HTTP for this server</span>
          </div>
          <p className="ob-note">
            Leave this empty if you are not syncing yet. Nothing is hardcoded, so the app asks where your sync server
            lives. Use https unless this server is on a network you trust.
          </p>
        </details>
      </form>
    </OnboardingLayout>
  )
}
