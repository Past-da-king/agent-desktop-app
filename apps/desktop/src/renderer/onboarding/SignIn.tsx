import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import {
  clearLocalOnly,
  markLocalOnly,
  readSignInDraft,
  writeSignInDraft,
  type SignInDraft,
} from '../state/onboarding'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { OnboardingLayout } from './OnboardingLayout'

type Mode = SignInDraft['mode']

export function SignIn(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const draft = readSignInDraft()
  const [mode, setMode] = useState<Mode>(draft?.mode ?? 'in')
  const [email, setEmail] = useState(draft?.email ?? settings?.syncEmail ?? '')
  const [password, setPassword] = useState('')
  const [serverUrl, setServerUrl] = useState(draft?.serverUrl ?? settings?.syncUrl ?? '')
  const [allowHttp, setAllowHttp] = useState(settings?.allowHttp ?? false)
  const [advanced, setAdvanced] = useState((draft?.serverUrl ?? settings?.syncUrl ?? '') !== '')
  const [emailError, setEmailError] = useState('')
  const [serverError, setServerError] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [useOther, setUseOther] = useState(false)
  const serverRef = useRef<HTMLInputElement>(null)

  const create = mode === 'new'
  const signedIn = (settings?.signedIn ?? false) && !useOther
  const signedInEmail = settings?.syncEmail ?? ''

  useEffect(() => {
    writeSignInDraft({ mode, email, serverUrl })
  }, [mode, email, serverUrl])

  const chooseMode = (value: Mode): void => {
    setMode(value)
    setEmailError('')
    setError('')
  }

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
    const address = serverUrl.trim()
    // The browser mock has no server to reach and accepts an empty address, so the preview
    // flow can be walked without one. The real app always asks for the address first.
    if (address === '' && agent.platform !== 'web') {
      setAdvanced(true)
      setServerError('Add the address of your sync server, or use this computer only.')
      setError('')
      window.setTimeout(() => serverRef.current?.focus(), 0)
      return
    }
    setEmailError('')
    setServerError('')
    setError('')
    setBusy(true)
    try {
      await save({ allowHttp })
      const result = await agent.account.signIn({
        serverUrl: address,
        email: clean,
        password,
        mode: create ? 'register' : 'login',
      })
      if (!result.ok) {
        setError(result.error)
        setBusy(false)
        return
      }
      clearLocalOnly()
      setPassword('')
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
    try {
      await save({ signedIn: false, syncEmail: null })
    } catch (cause) {
      setError(cause instanceof Error && cause.message !== '' ? cause.message : 'That could not be saved. Try again.')
      return
    }
    markLocalOnly()
    navigate({ page: 'onboarding', step: 'ai' })
  }

  const switchAccount = async (): Promise<void> => {
    setBusy(true)
    try {
      await agent.account.signOut()
      await save({ signedIn: false, syncEmail: null })
      setEmail('')
      setPassword('')
      setServerUrl(settings?.syncUrl ?? '')
      setUseOther(true)
    } catch (cause) {
      // Without this the button looked dead when signing out failed.
      toast(cause instanceof Error && cause.message !== '' ? cause.message : 'Could not sign out. Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (signedIn) {
    return (
      <OnboardingLayout step="signin">
        <div className="ob-col">
          <div>
            <div className="eyebrow">WELCOME BACK</div>
            <h1 className="h1" style={{ marginTop: 8 }}>
              Signed in as {signedInEmail || 'your account'}
            </h1>
            <p className="muted" style={{ marginTop: 8, fontSize: 15 }}>
              This computer is ready to pick up where your phone left off.
            </p>
          </div>

          <div className="card">
            <div className="syncrow done">
              <div className="st">
                <Icon name="check" size={18} />
              </div>
              <div className="t">
                <div className="h3">{signedInEmail || 'Your account'}</div>
                <div className="small muted">Ready to sync</div>
              </div>
            </div>
          </div>

          <Button
            size="lg"
            block
            disabled={busy}
            onClick={() => navigate({ page: 'onboarding', step: 'sync' })}
          >
            Continue
            <Icon name="arrow" size={20} />
          </Button>
          <Button variant="text" disabled={busy} onClick={() => void switchAccount()} style={{ alignSelf: 'center' }}>
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
          onChange={chooseMode}
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

        <div className="qr soon" aria-disabled="true">
          <div className="qrbox" aria-hidden="true">
            <Icon name="phone" size={30} />
          </div>
          <div className="qr-t">
            <div className="qr-head">
              <div className="h3">Sign in with your phone</div>
              <span className="pill mute">Coming soon</span>
            </div>
            <p className="muted small">Scan a code from the Agent app on your phone. Nothing to type.</p>
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

        <details
          className="adv"
          open={advanced}
          onToggle={(event) => setAdvanced(event.currentTarget.open)}
        >
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
            <span>Allow unencrypted HTTP</span>
            <Switch
              label="Allow unencrypted HTTP"
              on={allowHttp}
              onToggle={(next) => {
                setAllowHttp(next)
                void save({ allowHttp: next })
              }}
            />
          </div>
          <p className="ob-note">
            Leave this empty if you are not syncing yet. Nothing is hardcoded, so the app asks where your sync server
            lives. Only turn on plain HTTP for a server on your own network.
          </p>
        </details>
      </form>
    </OnboardingLayout>
  )
}
