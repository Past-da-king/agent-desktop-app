import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { useUi } from '../state/useUi'
import { Icon } from '../ui/Icon'
import { MicError, startCapture, type Capture } from './audio'
import { concatBytes } from './pcm'
import { useCall } from './useCall'
import './voice.css'

type Phase = 'idle' | 'recording' | 'working'

/**
 * The composer's microphone. Click to record, click again (or Enter) to stop and transcribe; the
 * words go into the composer and are never sent on their own. Escape cancels.
 */
export function DictateButton({
  hasKey,
  onText,
  onProblem,
}: {
  hasKey: boolean
  onText: (text: string) => void
  onProblem: (message: string, action?: { label: string; run: () => void }) => void
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const capture = useRef<Capture | null>(null)
  const chunks = useRef<Uint8Array[]>([])
  const bars = useRef<HTMLSpanElement>(null)
  const inCall = useCall((state) => state.open)
  const navigate = useUi((state) => state.navigate)

  const cancel = (): void => {
    capture.current?.stop()
    capture.current = null
    chunks.current = []
    setPhase('idle')
  }

  const finish = async (): Promise<void> => {
    const active = capture.current
    if (active === null) return
    active.stop()
    capture.current = null
    const pcm = concatBytes(chunks.current)
    chunks.current = []
    setPhase('working')
    try {
      const result = await agent.voice.transcribe(pcm)
      if (!result.ok) onProblem(result.error)
      else if (result.text.trim() === '') onProblem('Nothing was heard. Try again a little closer to the microphone.')
      else onText(result.text.trim())
    } catch {
      onProblem('Could not transcribe that. Try again.')
    } finally {
      setPhase('idle')
    }
  }

  const begin = async (): Promise<void> => {
    if (!hasKey) {
      onProblem('Add a Gemini key in Settings to talk.', { label: 'Open Settings', run: () => navigate({ page: 'settings' }) })
      return
    }
    chunks.current = []
    try {
      capture.current = await startCapture((pcm) => chunks.current.push(pcm))
      setPhase('recording')
    } catch (error) {
      if (agent.platform === 'web' && agent.remote === undefined) {
        // The preview has no real microphone: show the recording state and let the mock transcribe.
        capture.current = { level: () => 0.3 + 0.3 * Math.abs(Math.sin(performance.now() / 120)), setMuted: () => undefined, stop: () => undefined }
        setPhase('recording')
        return
      }
      onProblem(error instanceof MicError ? error.message : 'Could not use the microphone.')
    }
  }

  useEffect(() => {
    if (phase !== 'recording') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancel()
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        void finish()
      }
    }
    window.addEventListener('keydown', onKey, true)
    let frame = 0
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    const tick = (): void => {
      const loud = capture.current?.level() ?? 0
      bars.current?.style.setProperty('--lvl', loud.toFixed(3))
      frame = requestAnimationFrame(tick)
    }
    if (!reduced) frame = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      cancelAnimationFrame(frame)
    }
  })

  useEffect(() => () => capture.current?.stop(), [])

  if (phase === 'recording') {
    return (
      <span className="dictate on">
        <span className="dictate-bars" ref={bars} aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <button type="button" className="dictate-x" aria-label="Cancel dictation (Esc)" title="Cancel (Esc)" onClick={cancel}>
          <Icon name="x" size={18} />
        </button>
        <button type="button" className="dictate-done" aria-label="Stop and transcribe (Enter)" title="Done (Enter)" onClick={() => void finish()}>
          <Icon name="check" size={18} />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className={`ib dictate-mic${phase === 'working' ? ' working' : ''}`}
      aria-label={phase === 'working' ? 'Transcribing' : 'Dictate'}
      title={inCall ? 'On a call' : phase === 'working' ? 'Transcribing' : hasKey ? 'Dictate' : 'Add a Gemini key in Settings to talk'}
      disabled={phase === 'working' || inCall}
      onClick={() => void begin()}
    >
      <Icon name="mic" size={22} />
    </button>
  )
}
