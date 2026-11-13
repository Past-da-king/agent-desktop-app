import type { ChatItem } from '@agent/core'
import { useState } from 'react'

import { handoffsOfCall } from '../lib/live'
import { parseMeta } from '../lib/meta'
import { VoiceIcon } from './VoiceIcon'

interface SavedLine {
  who: string
  text: string
}

function linesOf(meta: Record<string, unknown>): SavedLine[] {
  const raw = meta['lines']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as Record<string, unknown>
    return typeof row['text'] === 'string' && typeof row['who'] === 'string' ? [{ who: row['who'], text: row['text'] }] : []
  })
}

/** "Call, 3 min" or "Call, 40 s". */
export function callLength(durationMs: number): string {
  const minutes = Math.round(durationMs / 60_000)
  return minutes < 1 ? `${Math.max(1, Math.round(durationMs / 1000))} s` : `${minutes} min`
}

/** A finished call in the chat: one compact row that opens into the transcript. */
export function CallRow({ item, agentName }: { item: ChatItem; agentName: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const meta = parseMeta(item.meta)
  const duration = typeof meta['durationMs'] === 'number' ? meta['durationMs'] : 0
  const lines = linesOf(meta)
  const spoken = lines.filter((line) => line.who !== 'note').length
  // A Live voice session is a call that can see; its hand-offs to the agent fold inside, never a bubble of his.
  const live = meta['source'] === 'live'
  const pending = meta['pending'] === true
  const handoffs = handoffsOfCall(meta)
  const parts = [
    ...(handoffs.length > 0 ? [`${handoffs.length} ${handoffs.length === 1 ? 'job' : 'jobs'} handed to the agent`] : []),
    ...(spoken > 0 ? [`${spoken} ${spoken === 1 ? 'line' : 'lines'} of transcript`] : []),
  ]
  const summary = parts.length > 0 ? parts.join(', ') : 'Nothing was said'
  const title = `${live ? 'Live voice' : 'Call'}${pending ? '' : `, ${callLength(duration)}`}`
  const at = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`call-row${open ? ' open' : ''}`}>
      <button type="button" className="call-row-h" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="call-row-i">
          <VoiceIcon name="handset" size={18} />
        </span>
        <span className="call-row-t">
          <b>{title}</b>
          <span>
            {at} · {summary}
          </span>
        </span>
        <span className="call-row-c">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open ? (
        <div className="call-row-b">
          {handoffs.map((entry, index) => (
            <div key={`h${index}`} className="call-hand">
              <b>Handed to the agent</b>
              <p>{entry.request}</p>
              {entry.spoken !== '' ? <blockquote>{entry.spoken}</blockquote> : null}
            </div>
          ))}
          {lines.length === 0 && handoffs.length === 0 ? <p className="muted">No transcript was kept.</p> : null}
          {lines.map((line, index) =>
            line.who === 'note' ? (
              <div key={index} className="call-note">
                <VoiceIcon name="wave" size={16} />
                {line.text}
              </div>
            ) : (
              <p key={index} className={`tl who-${line.who}`}>
                <b>{line.who === 'you' ? 'You' : agentName}</b>
                {line.text}
              </p>
            ),
          )}
        </div>
      ) : null}
    </div>
  )
}
