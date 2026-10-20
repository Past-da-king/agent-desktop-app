import type { ChatItem } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { agent } from '../bridge'
import { helperView, isHelper, type HelperView } from '../lib/helpers'
import { metaText, parseMeta } from '../lib/meta'
import { useEntity } from '../state/useData'
import { usePanel } from '../state/usePanel'
import { Icon, type IconName } from '../ui/Icon'

function stateLabel(helper: HelperView): { label: string; tone: string; icon: IconName } {
  if (helper.state === 'working') return helper.queued ? { label: 'Queued', tone: 'mute', icon: 'clock' } : { label: 'Working', tone: 'pri', icon: 'globe' }
  if (helper.state === 'done') return { label: 'Done', tone: 'ok', icon: 'check' }
  if (helper.state === 'failed') return { label: 'Failed', tone: 'warn', icon: 'x' }
  return { label: 'Stopped', tone: 'mute', icon: 'stop' }
}

function stepText(item: ChatItem): string {
  return metaText(parseMeta(item.meta), 'summary') || item.text
}

function useStop(): { stopping: string | null; stop: (id: string) => void } {
  const [stopping, setStopping] = useState<string | null>(null)
  return {
    stopping,
    stop: (id) => {
      setStopping(id)
      void agent.helpers.stop(id).finally(() => setStopping(null))
    },
  }
}

/**
 * The helpers working right now, under the agent's browser in the side panel. A helper is here only while it
 * runs and goes as soon as it stops. A click opens it full size (HelperStage).
 */
export function HelpersPanel(): JSX.Element | null {
  const items = useEntity('chat_item')
  const openHelper = usePanel((store) => store.openHelper)
  const helpers = useMemo(
    () =>
      items
        .filter((item) => isHelper(item))
        .map((item) => helperView(item, items))
        .filter((helper) => helper.state === 'working')
        .sort((a, b) => Number(a.queued) - Number(b.queued) || a.startedAt - b.startedAt),
    [items],
  )
  if (helpers.length === 0) return null

  return (
    <section className="hp" aria-label="Helpers working now">
      <div className="hp-title">
        <span className="eyebrow">HELPERS</span>
        <span className="small muted">{helpers.length} working</span>
      </div>
      <ul className="hp-list">
        {helpers.map((helper) => {
          const s = stateLabel(helper)
          const last = helper.activity[helper.activity.length - 1]
          return (
            <li key={helper.id}>
              <button type="button" className="hp-card" onClick={() => openHelper(helper.id)} aria-label={`Open ${helper.label} full size`}>
                <span className={`hp-ic ${s.tone}`}>
                  <Icon name={s.icon} size={16} />
                </span>
                <span className="hp-t">
                  <b>{helper.label}</b>
                  <span>{last !== undefined ? stepText(last) : 'Starting'}</span>
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

/**
 * One helper over the whole window: its brief, what it is doing now, every step and its result. The X (or Esc)
 * closes it and the side panel is back at the width it had.
 */
export function HelperStage(): JSX.Element | null {
  const id = usePanel((store) => store.helper)
  const close = usePanel((store) => store.closeHelper)
  const items = useEntity('chat_item')
  const { stopping, stop } = useStop()
  const row = id === null ? undefined : items.find((item) => isHelper(item) && helperView(item, items).id === id)
  const helper = row === undefined ? null : helperView(row, items)

  useEffect(() => {
    if (id === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [id, close])

  if (id === null) return null
  if (helper === null) {
    return (
      <div className="hp-stage" role="dialog" aria-modal="true" aria-label="Helper">
        <div className="hp-stage-bar">
          <b>This helper is gone</b>
          <button type="button" className="hp-x" onClick={close} aria-label="Close">
            <Icon name="x" size={20} />
          </button>
        </div>
      </div>
    )
  }

  const s = stateLabel(helper)
  const current = [...helper.activity].reverse().find((step) => metaText(parseMeta(step.meta), 'status') === 'running')
  return (
    <div className="hp-stage" role="dialog" aria-modal="true" aria-label={`Helper ${helper.label}`}>
      <div className="hp-stage-bar">
        <span className={`hp-ic ${s.tone}`}>
          <Icon name={s.icon} size={16} />
        </span>
        <b>{helper.label}</b>
        <span className={`pill ${s.tone}`}>{s.label}</span>
        <span className="hp-stage-gap" />
        {helper.state === 'working' ? (
          <button type="button" className="btn text sm" disabled={stopping === helper.id} onClick={() => stop(helper.id)}>
            {stopping === helper.id ? 'Stopping' : 'Stop'}
          </button>
        ) : null}
        <button type="button" className="hp-x" onClick={close} aria-label="Close and go back">
          <Icon name="x" size={20} />
        </button>
      </div>
      <div className="hp-stage-body">
        <div className="hp-stage-col">
          <section>
            <div className="eyebrow mute">THE JOB</div>
            <p className="hp-brief">{helper.brief}</p>
          </section>
          {current !== undefined ? (
            <div className="hp-now">
              <span className="eyebrow">NOW</span>
              <span>{stepText(current)}</span>
            </div>
          ) : null}
          <section>
            <div className="eyebrow mute">EVERY STEP, {helper.activity.length}</div>
            {helper.activity.length === 0 ? (
              <p className="small muted">No steps yet.</p>
            ) : (
              <ol className="hp-steps">
                {helper.activity.map((step) => {
                  const status = metaText(parseMeta(step.meta), 'status') || 'done'
                  const icon: IconName = status === 'error' ? 'x' : status === 'running' ? 'globe' : 'check'
                  return (
                    <li key={step.id} className={`hp-step ${status}`}>
                      <i>
                        <Icon name={icon} size={14} />
                      </i>
                      <span>{stepText(step)}</span>
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
          {helper.result !== '' && helper.state !== 'working' ? (
            <section className="hp-result">
              <div className="eyebrow mute">RESULT</div>
              <p>{helper.result}</p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
