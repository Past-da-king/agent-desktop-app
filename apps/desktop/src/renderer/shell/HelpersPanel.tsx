import type { ChatItem } from '@agent/core'
import { useMemo, useState } from 'react'

import { agent } from '../bridge'
import { helperView, isHelper, type HelperView } from '../lib/helpers'
import { metaText, parseMeta } from '../lib/meta'
import { useEntity } from '../state/useData'
import { Icon, type IconName } from '../ui/Icon'

/** How long a finished helper stays in the panel before it folds away. */
const KEEP_FINISHED_MS = 30 * 60 * 1000

function stateLabel(helper: HelperView): { label: string; tone: string; icon: IconName } {
  if (helper.state === 'working') return helper.queued ? { label: 'Queued', tone: 'mute', icon: 'clock' } : { label: 'Working', tone: 'pri', icon: 'globe' }
  if (helper.state === 'done') return { label: 'Done', tone: 'ok', icon: 'check' }
  if (helper.state === 'failed') return { label: 'Failed', tone: 'warn', icon: 'x' }
  return { label: 'Stopped', tone: 'mute', icon: 'stop' }
}

function Step({ item }: { item: ChatItem }): JSX.Element {
  const meta = parseMeta(item.meta)
  const status = metaText(meta, 'status') || 'done'
  const icon: IconName = status === 'error' ? 'x' : status === 'running' ? 'globe' : 'check'
  return (
    <li className={`hp-step ${status}`}>
      <i className={status === 'running' ? 'spin' : ''}>
        <Icon name={icon} size={14} />
      </i>
      <span>{metaText(meta, 'summary') || item.text}</span>
    </li>
  )
}

/** The helpers the main agent started, in the side panel: a live card each, and the full run on click. */
export function HelpersPanel(): JSX.Element | null {
  const items = useEntity('chat_item')
  const [openId, setOpenId] = useState<string | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)
  const now = Date.now()
  const helpers = useMemo(
    () =>
      items
        .filter((item) => isHelper(item))
        .map((item) => helperView(item, items))
        .filter((helper) => helper.state === 'working' || (helper.endedAt ?? 0) > now - KEEP_FINISHED_MS)
        .sort((a, b) => Number(b.state === 'working') - Number(a.state === 'working') || b.startedAt - a.startedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items],
  )
  if (helpers.length === 0) return null
  const open = helpers.find((helper) => helper.id === openId) ?? null

  const stop = (id: string): void => {
    setStopping(id)
    void agent.helpers.stop(id).finally(() => setStopping(null))
  }

  if (open !== null) {
    const s = stateLabel(open)
    const current = [...open.activity].reverse().find((step) => metaText(parseMeta(step.meta), 'status') === 'running')
    return (
      <section className="hp hp-detail" aria-label={`Helper ${open.label}`}>
        <div className="hp-head">
          <button type="button" className="hp-back" onClick={() => setOpenId(null)} aria-label="Back to all helpers">
            <Icon name="chev" size={18} />
          </button>
          <b>{open.label}</b>
          <span className={`pill ${s.tone}`}>{s.label}</span>
          {open.state === 'working' ? (
            <button type="button" className="btn text sm" disabled={stopping === open.id} onClick={() => stop(open.id)}>
              {stopping === open.id ? 'Stopping' : 'Stop'}
            </button>
          ) : null}
        </div>
        <div className="hp-brief">{open.brief}</div>
        {current !== undefined ? (
          <div className="hp-now">
            <span className="eyebrow">NOW</span>
            <span>{metaText(parseMeta(current.meta), 'summary') || current.text}</span>
          </div>
        ) : null}
        <div className="eyebrow mute hp-steps-h">EVERY STEP</div>
        {open.activity.length === 0 ? (
          <p className="small muted hp-empty">No steps yet.</p>
        ) : (
          <ol className="hp-steps">
            {open.activity.map((step) => (
              <Step key={step.id} item={step} />
            ))}
          </ol>
        )}
        {open.result !== '' && open.state !== 'working' ? (
          <div className="hp-result">
            <span className="eyebrow">RESULT</span>
            <p>{open.result}</p>
          </div>
        ) : null}
      </section>
    )
  }

  return (
    <section className="hp" aria-label="Helpers">
      <div className="hp-title">
        <span className="eyebrow">HELPERS</span>
        <span className="small muted">{helpers.filter((h) => h.state === 'working').length} working</span>
      </div>
      <ul className="hp-list">
        {helpers.map((helper) => {
          const s = stateLabel(helper)
          const last = helper.activity[helper.activity.length - 1]
          const line = helper.state === 'working' ? (last !== undefined ? metaText(parseMeta(last.meta), 'summary') || last.text : 'Starting') : helper.summary || s.label
          return (
            <li key={helper.id}>
              <button type="button" className="hp-card" onClick={() => setOpenId(helper.id)}>
                <span className={`hp-ic ${s.tone}`}>
                  <Icon name={s.icon} size={16} />
                </span>
                <span className="hp-t">
                  <b>{helper.label}</b>
                  <span>{line}</span>
                </span>
                <span className={`pill ${s.tone}`}>{s.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
