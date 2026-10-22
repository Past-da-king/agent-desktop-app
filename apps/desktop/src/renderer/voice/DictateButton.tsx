import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { useUi } from '../state/useUi'
import { Icon } from '../ui/Icon'
import { clock, useTicker } from '../dictation/clock'
import { MicError, startCapture, type Capture } from './audio'
import { dictationHere, useDictationDraft } from './DictationDraft'
import { concatBytes } from './pcm'
import { useCall } from './useCall'
import './voice.css'

type Phase = 'idle' | 'recording' | 'working' | 'failed'

/** The longest the one-call transcription may take before it gives up (away from the computer). */
const REMOTE_LIMIT_MS = 90_000

/**
 * The composer's microphone. Click to record, click again (or Enter) to stop; the words go into the composer and
 * are never sent on their own. Escape cancels.
 *
 * On the computer itself it runs the same dictation as the shortcut: the words stream in while they are said
 * (above the box), the finishing step counts its seconds and has a hard limit, and a failure keeps the recording
 * for Retry. Away from it (a linked browser) it records here and transcribes in one call, bounded the same way.
 */
export function DictateButton(props: {
  hasKey: boolean
  onText: (text: string) => void
  onProblem: (message: string, action?: { label: string; run: () => void }) => void
  /** Puts the cursor back in the message box, so the words land there. */
  focusBox?: () => void
}): JSX.Element {
  return dictationHere() ? <LiveDictateButton {...props} /> : <RecordDictateButton {...props} />
}

function LiveDictateButton({
  hasKey,
  onProblem,
  focusBox,
}: {
  hasKey: boolean
  onProblem: (message: string, action?: { label: string; run: () => void }) => void
  focusBox?: () => void
}): JSX.Element {
  const draft = useDictationDraft()
  const inCall = useCall((state) => state.open)
  const navigate = useUi((state) => state.navigate)
  const listening = draft !== null && (draft.phase === 'listening' || draft.phase === 'starting')
  const working = draft !== null && (draft.phase === 'finishing' || draft.phase === 'cleaning')
  const now = useTicker(working)

  useEffect(() => {
    if (!listening) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        void agent.dictation.toggle('plain')
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [listening])

  const keepFocus = (event: { preventDefault: () => void }): void => event.preventDefault()

  if (listening) {
    return (
      <span className="dictate on">
        <span className="dictate-bars live" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </span>
        <button type="button" className="dictate-x" aria-label="Cancel dictation (Esc)" title="Cancel (Esc)" onMouseDown={keepFocus} onClick={() => void agent.dictation.cancel()}>
          <Icon name="x" size={18} />
        </button>
        <button
          type="button"
          className="dictate-done"
          aria-label="Stop and type (Enter)"
          title="Done (Enter)"
          onMouseDown={keepFocus}
          onClick={() => void agent.dictation.toggle('plain')}
        >
          <Icon name="check" size={18} />
        </button>
      </span>
    )
  }

  if (working && draft !== null) {
    const seconds = draft.since === undefined ? '' : clock(now - draft.since, draft.phase)
    return (
      <span className="dictate on working" role="status" aria-label={`Transcribing ${seconds}`}>
        <span className="dictate-spin" aria-hidden="true" />
        <span className="dictate-time">{seconds}</span>
        <button type="button" className="dictate-x" aria-label="Stop waiting (Esc)" title="Stop waiting (Esc)" onMouseDown={keepFocus} onClick={() => void agent.dictation.cancel()}>
          <Icon name="x" size={18} />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="ib dictate-mic"
      aria-label="Dictate"
      title={inCall ? 'On a call' : hasKey ? 'Dictate' : 'Add a Gemini key in Settings to talk'}
      disabled={inCall}
      onMouseDown={keepFocus}
      onClick={() => {
        if (!hasKey) {
          onProblem('Add a Gemini key in Settings to talk.', { label: 'Open Settings', run: () => navigate({ page: 'settings' }) })
          return
        }
        focusBox?.()
        agent.dictation.toggle('plain').catch(() => onProblem('Could not start dictation. Try again.'))
      }}
    >
      <Icon name="mic" size={22} />
    </button>
  )
}

function RecordDictateButton({
  hasKey,
  onText,
  onProblem,
}: {
  hasKey: boolean
  onText: (text: string) => void
  onProblem: (message: string, action?: { label: string; run: () => void }) => void
}): JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [since, setSince] = useState(0)
  const capture = useRef<Capture | null>(null)
  const chunks = useRef<Uint8Array[]>([])
  const kept = useRef<Uint8Array | null>(null)
  const attempt = useRef(0)
  const bars = useRef<HTMLSpanElement>(null)
  const inCall = useCall((state) => state.open)
  const navigate = useUi((state) => state.navigate)
  const now = useTicker(phase === 'working')

  const cancel = (): void => {
    capture.current?.stop()
    capture.current = null
    chunks.current = []
    if (phase === 'working') attempt.current += 1
    setPhase(kept.current !== null && phase === 'working' ? 'failed' : 'idle')
  }

  const transcribe = async (pcm: Uint8Array): Promise<void> => {
    attempt.current += 1
    const mine = attempt.current
    kept.current = pcm
    setSince(Date.now())
    setPhase('working')
    let timer: ReturnType<typeof setTimeout> | undefined
    const limit = new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: `The words did not come back within ${REMOTE_LIMIT_MS / 1000} seconds.` }), REMOTE_LIMIT_MS)
    })
    let result: { ok: true; text: string } | { ok: false; error: string }
    try {
      result = await Promise.race([agent.voice.transcribe(pcm), limit])
    } catch {
      result = { ok: false, error: 'Could not transcribe that.' }
    } finally {
      clearTimeout(timer)
    }
    if (mine !== attempt.current) return
    if (result.ok && result.text.trim() !== '') {
      kept.current = null
      setPhase('idle')
      onText(result.text.trim())
      return
    }
    if (result.ok) {
      kept.current = null
      setPhase('idle')
      onProblem('Nothing was heard. Try again a little closer to the microphone.')
      return
    }
    setPhase('failed')
    onProblem(`${result.error} The recording was kept.`, { label: 'Retry', run: () => void retry() })
  }

  const retry = async (): Promise<void> => {
    const pcm = kept.current
    if (pcm !== null) await transcribe(pcm)
  }

  const finish = async (): Promise<void> => {
    const active = capture.current
    if (active === null) return
    active.stop()
    capture.current = null
    const pcm = concatBytes(chunks.current)
    chunks.current = []
    await transcribe(pcm)
  }

  const begin = async (): Promise<void> => {
    if (!hasKey) {
      onProblem('Add a Gemini key in Settings to talk.', { label: 'Open Settings', run: () => navigate({ page: 'settings' }) })
      return
    }
    chunks.current = []
    kept.current = null
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
    if (phase !== 'recording' && phase !== 'working') return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancel()
      } else if (event.key === 'Enter' && !event.shiftKey && phase === 'recording') {
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
    if (!reduced && phase === 'recording') frame = requestAnimationFrame(tick)
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

  if (phase === 'working') {
    const seconds = clock(now - since, 'finishing')
    return (
      <span className="dictate on working" role="status" aria-label={`Transcribing ${seconds}`}>
        <span className="dictate-spin" aria-hidden="true" />
        <span className="dictate-time">{seconds}</span>
        <button type="button" className="dictate-x" aria-label="Stop waiting (Esc)" title="Stop waiting (Esc)" onClick={cancel}>
          <Icon name="x" size={18} />
        </button>
      </span>
    )
  }

  if (phase === 'failed') {
    return (
      <span className="dictate on">
        <button type="button" className="dictate-retry" onClick={() => void retry()} title="Transcribe the kept recording again">
          Retry
        </button>
        <button
          type="button"
          className="dictate-x"
          aria-label="Discard the recording"
          title="Discard"
          onClick={() => {
            kept.current = null
            setPhase('idle')
          }}
        >
          <Icon name="x" size={18} />
        </button>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="ib dictate-mic"
      aria-label="Dictate"
      title={inCall ? 'On a call' : hasKey ? 'Dictate' : 'Add a Gemini key in Settings to talk'}
      disabled={inCall}
      onClick={() => void begin()}
    >
      <Icon name="mic" size={22} />
    </button>
  )
}
