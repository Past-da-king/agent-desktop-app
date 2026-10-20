import type { CallLine, CallState } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Orb } from './Orb'
import { VisualCard } from './VisualCard'
import { VoiceIcon } from './VoiceIcon'
import { callLevel, useCall } from './useCall'
import './voice.css'

const STATE_LABEL: Record<CallState, string> = {
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Talking',
  waiting: 'Your turn',
  ended: 'Call ended',
  error: 'Could not connect',
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

function useElapsed(startedAt: number, live: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [live])
  return now - startedAt
}

function Captions({ lines, agentName }: { lines: CallLine[]; agentName: string }): JSX.Element {
  const shown = lines.slice(-4)
  return (
    <div className="call-caps" aria-live="polite">
      {shown.map((line, index) =>
        line.who === 'note' ? (
          <div key={line.id} className="call-note">
            <VoiceIcon name="wave" size={16} />
            {line.text}
          </div>
        ) : (
          <p key={line.id} className={`cap who-${line.who}${index === shown.length - 1 ? ' last' : ''}`}>
            <span className="cap-who">{line.who === 'you' ? 'You' : agentName}</span>
            {line.text}
          </p>
        ),
      )}
    </div>
  )
}

/** The live call: a full sheet over the chat. Escape or Hang up ends it. */
export function CallSheet(): JSX.Element | null {
  const call = useCall()
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const hangRef = useRef<HTMLButtonElement>(null)
  const live = call.open && call.state !== 'error' && call.state !== 'ended'
  const elapsed = useElapsed(call.startedAt, live)
  const agentName = settings?.agentName.trim() || 'Your agent'

  useEffect(() => {
    if (!call.open) return
    hangRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void useCall.getState().hangUp()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [call.open])

  if (!call.open) return null
  const noKey = call.state === 'error' && call.message === 'nokey'
  const hasVisuals = call.visuals.length > 0

  return (
    <section className={`call-sheet${hasVisuals ? ' has-visuals' : ''}`} role="dialog" aria-modal="true" aria-label={`Call with ${agentName}`}>
      <header className="call-top">
        <div className="call-id">
          <span className="eyebrow">LIVE CALL</span>
          <b>{agentName}</b>
        </div>
        {live ? <span className="call-clock">{clock(elapsed)}</span> : null}
      </header>

      <div className="call-main">
        <div className="call-stage">
          <Orb state={noKey ? 'ended' : call.state} level={callLevel} />
          <div className={`call-state is-${call.state}`} role="status">
            {noKey ? 'Voice is not set up yet' : call.muted && live ? 'Muted' : STATE_LABEL[call.state]}
          </div>
          {noKey ? (
            <div className="call-calm">
              <p>Add a Gemini key in Settings to talk.</p>
              <Button
                variant="tonal"
                size="sm"
                onClick={() => {
                  void useCall.getState().hangUp()
                  navigate({ page: 'settings' })
                }}
              >
                Open Settings
              </Button>
            </div>
          ) : call.state === 'error' ? (
            <div className="call-calm">
              <p>{call.message || 'The call could not connect.'}</p>
            </div>
          ) : (
            <Captions lines={call.lines} agentName={agentName} />
          )}
        </div>

        {hasVisuals ? (
          <aside className="call-visuals" aria-label="On screen">
            {call.visuals.map((visual) => (
              <VisualCard key={visual.id} visual={visual} />
            ))}
          </aside>
        ) : null}
      </div>

      <footer className="call-bar">
        <button
          type="button"
          className={`call-btn mute${call.muted ? ' on' : ''}`}
          aria-pressed={call.muted}
          aria-label={call.muted ? 'Unmute' : 'Mute'}
          title={call.muted ? 'Unmute' : 'Mute'}
          disabled={!live}
          onClick={() => useCall.getState().toggleMute()}
        >
          {call.muted ? <VoiceIcon name="micoff" size={24} /> : <Icon name="mic" size={24} />}
          <span>{call.muted ? 'Unmute' : 'Mute'}</span>
        </button>
        <button
          ref={hangRef}
          type="button"
          className="call-btn hang"
          aria-label={live ? 'Hang up' : 'Close'}
          title={live ? 'Hang up (Esc)' : 'Close (Esc)'}
          onClick={() => {
            void useCall.getState().hangUp()
          }}
        >
          <VoiceIcon name="hangup" size={26} />
          <span>{live ? 'Hang up' : 'Close'}</span>
        </button>
      </footer>
    </section>
  )
}
