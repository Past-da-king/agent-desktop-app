/**
 * The wake-ups log inside Settings > Notifications and wake-ups (4 Nov 2026). Every wake that rang, who fired it,
 * why, where it went and what happened, plus whether each linked phone can ring. The rows themselves are settings
 * rows on the page; this is the record below them, which used to live in the wake-ups card.
 */
import type { WakeDeviceStatus, WakeupRow } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { agent } from '../../bridge'
import { useEntity } from '../../state/useData'
import { foldWakes, SEVERITY_LOOK, shownTitle } from '../../../shared/wakeups'

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function WakeLog(): JSX.Element {
  const rows = useEntity('wakeup')
  const [devices, setDevices] = useState<WakeDeviceStatus[]>([])
  const now = Date.now()

  useEffect(() => {
    let live = true
    const read = (): void => {
      void agent.wakeups
        .devices()
        .then((list) => live && setDevices(list))
        .catch(() => undefined)
    }
    read()
    return () => {
      live = false
    }
  }, [])

  const log = useMemo(() => foldWakes(rows as WakeupRow[], now).filter((view) => view.state !== 'pending').slice(0, 8), [rows, now])
  const phones = devices.filter((device) => device.kind === 'phone' || device.kind === 'tablet')

  return (
    <div className="wakelog">
      <div className="wakelog-h">
        <span className="eyebrow mute">Wake-ups log</span>
        {phones.length === 0 ? <span className="small muted">No phone linked</span> : null}
        {phones.map((phone) => (
          <span key={phone.id} className="small muted">
            {phone.name} {phone.reachable ? 'reachable now' : 'not connected'}
          </span>
        ))}
      </div>
      {log.length === 0 ? <div className="rowempty">Nothing has rung yet.</div> : null}
      {log.map((view) => {
        const look = SEVERITY_LOOK[view.severity]
        const said =
          view.state === 'acked'
            ? `Answered ${clock(view.ackedAt ?? 0)}`
            : view.state === 'snoozed'
              ? `Snoozed until ${clock(view.ringAt)}`
              : view.state === 'withdrawn'
                ? 'Withdrawn before it rang'
                : `Rang since ${clock(view.ringAt)}`
        return (
          <div className="wakelog-row" key={view.id}>
            <span className="wakelog-dot" style={{ background: look.bg }} />
            <span className="rt">
              <b>{shownTitle(view)}</b>
              <span className="d">{view.whatToDo}</span>
            </span>
            <span className="small muted">
              {said} from {view.firedBy || 'an agent'}
            </span>
          </div>
        )
      })}
    </div>
  )
}
