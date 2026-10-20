import { VOICES } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { Pill } from '../ui/bits'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'
import { speakText, stopSpeaking, useSpeaker } from './speaker'
import { VoiceIcon } from './VoiceIcon'
import './voice.css'

const SAMPLE = 'Hi. This is how I sound on a call and when I read your replies.'

/** Settings > Voice: the Gemini key, the voice, a real check, and "Speak replies". */
export function VoiceSettings(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const sampling = useSpeaker((state) => state.speaking === 'voice-sample' || state.loading === 'voice-sample')
  const hasKey = settings?.hasVoiceKey ?? false
  const voice = settings?.voiceName || 'Kore'

  const storeKey = async (): Promise<void> => {
    const value = draft.trim()
    if (value === '') return
    setBusy(true)
    try {
      await agent.voice.setKey(value)
      setDraft('')
      setStatus(await agent.voice.check())
    } catch {
      setStatus({ ok: false, message: 'Could not store the key.' })
    } finally {
      setBusy(false)
    }
  }

  const check = async (): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await agent.voice.check())
    } catch {
      setStatus({ ok: false, message: 'Could not reach Gemini.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      <SectionHeader eyebrow="VOICE" line="Talk to your agent, dictate, and hear replies" />
      <div className="card voice-set" style={{ padding: 10 }}>
        <div className="rowc">
          <div className={`ri${hasKey ? ' ok' : ''}`}>
            <Icon name="key" size={22} />
          </div>
          <div className="rt">
            <b>Gemini key</b>
            <span>
              {hasKey
                ? 'Stored by your operating system, never shown in this window.'
                : 'Voice runs on Google Gemini. A free key from Google AI Studio works.'}
            </span>
          </div>
          {hasKey ? (
            <Pill tone={status?.ok === false ? 'warn' : 'ok'}>{status?.ok === false ? 'Check it' : 'Stored'}</Pill>
          ) : (
            <Pill tone="mute">Not yet</Pill>
          )}
        </div>

        <div className="voice-key">
          <Field
            label={hasKey ? 'Replace the key' : 'Paste your Gemini key'}
            type="password"
            revealable
            revealLabel="key"
            autoComplete="off"
            value={draft}
            onChange={setDraft}
            placeholder="Starts with AIza"
            onEnter={() => void storeKey()}
          />
          <div className="voice-key-a">
            <Button size="sm" disabled={busy || draft.trim() === ''} onClick={() => void storeKey()}>
              Save key
            </Button>
            <Button variant="tonal" size="sm" disabled={busy || !hasKey} onClick={() => void check()}>
              {busy ? 'Checking...' : 'Check'}
            </Button>
            {hasKey ? (
              <Button
                variant="text"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void agent.voice.setKey('').then(() => setStatus(null))
                }}
              >
                Remove
              </Button>
            ) : null}
          </div>
          {status !== null ? (
            <p className={`voice-status${status.ok ? ' ok' : ' bad'}`} role="status">
              {status.message}
            </p>
          ) : null}
        </div>

        <div className="voice-pick-h">
          <span className="eyebrow mute">THE VOICE</span>
          <Button
            variant="tonal"
            size="sm"
            disabled={!hasKey}
            title={hasKey ? 'Hear this voice' : 'Add a Gemini key in Settings to talk'}
            onClick={() => {
              if (sampling) stopSpeaking()
              else void speakText('voice-sample', SAMPLE)
            }}
          >
            <VoiceIcon name="speaker" size={16} />
            {sampling ? 'Stop' : 'Hear it'}
          </Button>
        </div>
        <div className="voice-pick" role="radiogroup" aria-label="Voice">
          {VOICES.map((option) => {
            const active = option.id === voice
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={active}
                className={`voice-opt${active ? ' on' : ''}`}
                onClick={() => {
                  void save({ voiceName: option.id })
                }}
              >
                <b>{option.id}</b>
                <span>{option.feel}</span>
              </button>
            )
          })}
        </div>

        <div className="rowc">
          <div className="ri">
            <VoiceIcon name="speaker" size={22} />
          </div>
          <div className="rt">
            <b>Voice note with every reply</b>
            <span>{hasKey ? 'Your agent records a short voice note as well as its text, written to be heard' : 'Add a Gemini key in Settings first'}</span>
          </div>
          <Switch
            on={settings?.speakReplies ?? false}
            disabled={!hasKey}
            onToggle={(next) => {
              void save({ speakReplies: next })
            }}
            label="Voice note with every reply"
          />
        </div>
      </div>
    </section>
  )
}
