import type { DictationCommand, DictationView } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { Icon } from '../ui/Icon'
import { MicError, startCapture, type Capture } from '../voice/audio'
import './dictation.css'

const HIDDEN: DictationView = { phase: 'hidden', clean: false, text: '', interim: '', message: '', switchKeys: '' }
const TAIL = 140

/** The end of what was said, so the newest words are the ones in view. */
export function tail(text: string, max = TAIL): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(clean.length - max)
  const space = cut.indexOf(' ')
  return space > 0 && space < 16 ? cut.slice(space + 1) : cut
}

/**
 * The dictation pill (`#/dictation`), in a small window that never takes focus. It holds the microphone while
 * the main process says so, sends the audio there, and shows the words as they arrive, with a wave that moves
 * with the voice and a badge when the words will be cleaned up.
 */
export function DictationPill(): JSX.Element {
  const [view, setView] = useState<DictationView>(HIDDEN)
  const capture = useRef<Capture | null>(null)
  const session = useRef(0)
  const wave = useRef<HTMLSpanElement>(null)
  const preview = agent.platform === 'web'

  useEffect(() => {
    document.documentElement.classList.add('pill-window')
    const stopCapture = (): void => {
      capture.current?.stop()
      capture.current = null
    }
    const onCommand = (command: DictationCommand): void => {
      if (command.type === 'stop') {
        if (command.session === session.current) {
          session.current = 0
          stopCapture()
        }
        return
      }
      stopCapture()
      const id = command.session
      session.current = id
      startCapture((pcm) => {
        if (session.current === id) agent.dictation.audio(id, pcm)
      })
        .then((started) => {
          if (session.current !== id) {
            started.stop()
            return
          }
          capture.current = started
          void agent.dictation.micState(id, true, '')
        })
        .catch((error: unknown) => {
          if (session.current !== id) return
          session.current = 0
          void agent.dictation.micState(id, false, error instanceof MicError ? error.message : 'Could not use the microphone.')
        })
    }
    const offCommand = agent.dictation.onCommand(onCommand)
    const offView = agent.dictation.onView(setView)
    void agent.dictation.ready()
    return () => {
      offCommand()
      offView()
      stopCapture()
    }
  }, [])

  const listening = view.phase === 'listening' || view.phase === 'starting'

  useEffect(() => {
    if (!listening) return
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
    let frame = 0
    const tick = (): void => {
      const loud = preview ? 0.35 + 0.3 * Math.abs(Math.sin(performance.now() / 160)) : capture.current?.level() ?? 0
      wave.current?.style.setProperty('--lvl', loud.toFixed(3))
      frame = requestAnimationFrame(tick)
    }
    if (reduced) wave.current?.style.setProperty('--lvl', '0.35')
    else frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [listening, preview])

  if (view.phase === 'hidden') return <div className="dpill-stage" />

  const words = tail(`${view.text} ${view.interim}`)
  const settledLength = Math.max(0, words.length - view.interim.trim().length)
  const said = view.interim.trim() === '' ? words : words.slice(0, settledLength)
  const guess = view.interim.trim() === '' ? '' : words.slice(settledLength)

  let lead: JSX.Element
  if (listening) {
    lead = (
      <span className="dpill-wave" ref={wave} aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    )
  } else if (view.phase === 'done') {
    lead = (
      <span className="dpill-icon ok" aria-hidden="true">
        <Icon name="check" size={18} />
      </span>
    )
  } else if (view.phase === 'error' || view.phase === 'notice') {
    lead = (
      <span className={`dpill-icon ${view.phase}`} aria-hidden="true">
        <Icon name={view.phase === 'error' ? 'x' : 'key'} size={16} />
      </span>
    )
  } else {
    lead = <span className="dpill-spin" aria-hidden="true" />
  }

  let line: JSX.Element
  if (view.phase === 'starting' && words === '') {
    line = <span className="dpill-hint">Getting the microphone ready</span>
  } else if (listening && words === '') {
    line = (
      <span className="dpill-hint">
        Listening<span className="dpill-sep"> · </span>
        {view.message}
        {view.switchKeys !== '' && !view.clean ? (
          <>
            <span className="dpill-sep"> · </span>
            {view.switchKeys} to clean up
          </>
        ) : null}
      </span>
    )
  } else if (listening || view.phase === 'finishing' || view.phase === 'cleaning') {
    line = (
      <span className={`dpill-words${words.length < 44 ? ' short' : ''}`}>
        {view.phase === 'cleaning' ? <span className="dpill-hint">Cleaning up </span> : null}
        {view.phase === 'finishing' && words === '' ? <span className="dpill-hint">Finishing</span> : null}
        <span className="said">{said}</span>
        {guess !== '' ? <span className="guess">{guess}</span> : null}
      </span>
    )
  } else {
    line = <span className="dpill-message">{view.message}</span>
  }

  return (
    <div className={`dpill-stage${preview ? ' dpill-preview' : ''}`}>
      <div
        className={`dpill is-${view.phase}`}
        role="status"
        aria-live="polite"
        title={listening ? 'Click to stop and type' : undefined}
        onClick={() => {
          if (listening) void agent.dictation.stop()
        }}
      >
        {lead}
        {line}
        {view.clean ? <span className="dpill-badge">Clean up</span> : null}
      </div>
    </div>
  )
}
