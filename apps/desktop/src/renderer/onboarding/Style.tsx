import type { MascotId } from '@agent/core'
import { useState } from 'react'

import { applyAccent, ACCENTS } from '../state/theme'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { MASCOT_ORDER, Mascot, MASCOTS } from '../ui/Mascot'
import { OnboardingLayout } from './OnboardingLayout'

export function Style(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const [name, setName] = useState(settings?.userName ?? '')
  const [agentName, setAgentName] = useState(settings?.agentName === 'Your agent' ? '' : (settings?.agentName ?? ''))
  const [accent, setAccent] = useState(settings?.accent ?? 'iris')
  const [mascot, setMascot] = useState<MascotId>(settings?.mascot ?? 'scout')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const finish = async (): Promise<void> => {
    if (name.trim() === '') {
      setError('Tell your agent what to call you.')
      return
    }
    setBusy(true)
    try {
      await save({
        userName: name.trim(),
        agentName: agentName.trim() || 'Your agent',
        accent,
        mascot,
        onboarded: true,
      })
      navigate({ page: 'home' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save your choices.')
      setBusy(false)
    }
  }

  return (
    <OnboardingLayout step="style">
      <div className="ob-col">
        <div>
          <div className="eyebrow">MAKE IT YOURS</div>
          <h1 className="h1" style={{ marginTop: 8 }}>
            Last thing, the fun part
          </h1>
        </div>

        <Field
          label="Your name"
          value={name}
          onChange={(value) => {
            setName(value)
            setError('')
          }}
          placeholder="Sam"
          error={error}
          onEnter={() => {
            void finish()
          }}
        />
        <Field
          label="Agent name"
          value={agentName}
          onChange={setAgentName}
          placeholder="Nova"
          onEnter={() => {
            void finish()
          }}
        />

        <div>
          <div className="eyebrow mute" style={{ marginBottom: 10 }}>
            YOUR COLOUR
          </div>
          <div className="swatches">
            {ACCENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`sw${accent === item.id ? ' on' : ''}`}
                aria-label={item.label}
                aria-pressed={accent === item.id}
                style={{ background: item.swatch }}
                onClick={() => {
                  setAccent(item.id)
                  applyAccent(item.id)
                }}
              >
                {accent === item.id ? <Icon name="check" size={20} /> : null}
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="eyebrow mute" style={{ marginBottom: 10 }}>
            YOUR SIDEKICK
          </div>
          <div className="mascots">
            {MASCOT_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                className={`mk${mascot === id ? ' on' : ''}`}
                aria-label={MASCOTS[id].label}
                aria-pressed={mascot === id}
                onClick={() => setMascot(id)}
              >
                <Mascot id={id} size={38} />
              </button>
            ))}
          </div>
        </div>

        <div className="preview" aria-label="Preview">
          <div className="u">Find me a quiet cafe near work</div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <Mascot id={mascot} size={34} busy />
            <div>
              <div className="small muted">Browsing, 2 helpers</div>
              <div style={{ marginTop: 4, lineHeight: 1.5 }}>
                On it. Three with good Wi-Fi, all under 10 minutes away.
              </div>
            </div>
          </div>
        </div>

        <Button size="lg" block onClick={() => void finish()} disabled={busy}>
          {busy ? 'One moment...' : 'Open Agent'}
          <Icon name="arrow" size={20} />
        </Button>
      </div>
    </OnboardingLayout>
  )
}
