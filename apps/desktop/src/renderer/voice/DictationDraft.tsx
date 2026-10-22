import type { DictationView } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { clock, useTicker } from '../dictation/clock'

/** True on the computer itself, where dictation runs through the main process (live words, limits, Retry). */
export function dictationHere(): boolean {
  return agent.platform !== 'web' && agent.remote === undefined
}

const MAX_SHOWN = 420
/** The quick chat box has one line for it. */
const MAX_SHOWN_COMPACT = 70

/** The end of `text`, at most `max` characters, starting on a word with an ellipsis when cut. */
export function lastWords(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const space = cut.indexOf(' ')
  return `…${space > 0 && space < 24 ? cut.slice(space + 1) : cut}`
}

/** The dictation going into this window, or null when there is none. */
export function useDictationDraft(): DictationView | null {
  const [view, setView] = useState<DictationView | null>(null)
  useEffect(() => {
    if (!dictationHere()) return
    return agent.dictation.onDraft((next) => setView(next.phase === 'hidden' ? null : next))
  }, [])
  return view
}

/**
 * The words of a dictation into this window while they are said, above the message box, the way the phone
 * shows them: settled words, then the guess still being heard in a lighter tone. While the words are worked out
 * it counts the seconds; when they could not be had it says why and offers Retry with the kept recording.
 */
export function DictationDraft({ compact = false }: { compact?: boolean } = {}): JSX.Element | null {
  const view = useDictationDraft()
  const active = view !== null && view.since !== undefined && ['starting', 'listening', 'finishing', 'cleaning'].includes(view.phase)
  const now = useTicker(active)
  if (view === null) return null
  const time = active && view.since !== undefined ? clock(now - view.since, view.phase) : ''
  // The newest words stay in view: a long dictation shows its last few lines.
  const guess = view.interim.trim()
  const said = lastWords(view.text.trim(), Math.max(0, (compact ? MAX_SHOWN_COMPACT : MAX_SHOWN) - guess.length))
  const listening = view.phase === 'listening' || view.phase === 'starting'
  const working = view.phase === 'finishing' || view.phase === 'cleaning'

  let body: JSX.Element
  if (listening || working) {
    const empty = said === '' && guess === ''
    body = (
      <span className="dd-words">
        {empty ? (
          <span className="dd-hint">
            {view.phase === 'starting' ? 'Getting the microphone ready' : listening ? 'Listening… speak and the words show here' : 'Transcribing'}
          </span>
        ) : (
          <>
            <span className="dd-said">{said}</span>
            {guess !== '' ? <span className="dd-guess">{said === '' ? guess : ` ${guess}`}</span> : null}
          </>
        )}
      </span>
    )
  } else {
    body = <span className="dd-message">{view.message}</span>
  }

  return (
    <div className={`dictation-draft is-${view.phase}${compact ? ' compact' : ''}`} role="status" aria-live="polite" data-testid="dictation-draft">
      {listening ? <span className="dd-dot" aria-hidden="true" /> : working ? <span className="dd-spin" aria-hidden="true" /> : null}
      {body}
      {time !== '' ? <span className={`dd-time${working ? ' working' : ''}`}>{time}</span> : null}
      {working ? (
        <button type="button" className="dd-btn" onMouseDown={(event) => event.preventDefault()} onClick={() => void agent.dictation.cancel()} title="Stop waiting (Esc)">
          Cancel
        </button>
      ) : null}
      {view.canRetry === true ? (
        <>
          <button type="button" className="dd-btn primary" onMouseDown={(event) => event.preventDefault()} onClick={() => void agent.dictation.retry()}>
            Retry
          </button>
          <button type="button" className="dd-btn" onMouseDown={(event) => event.preventDefault()} onClick={() => void agent.dictation.cancel()} title="Dismiss (Esc)">
            Dismiss
          </button>
        </>
      ) : null}
    </div>
  )
}
