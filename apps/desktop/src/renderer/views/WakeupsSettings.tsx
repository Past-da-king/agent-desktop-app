/**
 * Settings > Wake-ups (docs/plans/wake-ups.md): whether this computer rings, snooze length, quiet hours, loudness, a
 * test button per severity, what is ringing now (answering here is his own hands, like the ringing screen), each
 * linked phone's permission checklist as the phone reported it, and the Wake-ups log: every wake, who fired it, why,
 * and what happened. Agents may set only Ring on this computer and the pause (settings_set; the rest is read-only to
 * them), and neither can silence a wake that is already ringing.
 */
import type { WakeDeviceStatus, WakeupRow } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { agent } from '../bridge'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'
import { dayClockLabel, foldWakes, hereNotes, pausedUntil, SEVERITY_LOOK, shownTitle, type WakeSeverity, type WakeView } from '../../shared/wakeups'

const QUIET_PRESETS = ['', '22:00-07:00', '23:00-06:00', '21:00-06:00', '00:00-07:00']
const SNOOZES = [1, 2, 5, 10, 15, 30]
const IDLE_MINUTES = [1, 2, 5, 10, 15, 30, 60]

/** What a datetime-local field holds, for a time. */
function fieldValue(at: number): string {
  const d = new Date(at)
  const two = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`
}

/** The pause offered first: tomorrow at 08:00. */
function tomorrowMorning(now: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0, 0, 0).getTime()
}

export function WakeupsSettings(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const rows = useEntity('wakeup')
  const [now, setNow] = useState(Date.now())
  const [where, setWhere] = useState<'here' | 'all'>('here')
  const [devices, setDevices] = useState<WakeDeviceStatus[]>([])
  const [selfId, setSelfId] = useState('')
  const [pauseField, setPauseField] = useState(() => fieldValue(tomorrowMorning(Date.now())))

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let live = true
    const read = (): void => {
      void agent.wakeups
        .devices()
        .then((list) => live && setDevices(list))
        .catch(() => undefined)
    }
    read()
    void agent.wakeups
      .selfId()
      .then((id) => live && setSelfId(id))
      .catch(() => undefined)
    const timer = setInterval(read, 15_000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [])

  const views = useMemo(() => foldWakes(rows as WakeupRow[], now), [rows, now])
  const ringing = views.filter((v) => v.state === 'ringing' || v.state === 'snoozed')
  const booked = views.filter((v) => v.state === 'pending').sort((a, b) => a.ringAt - b.ringAt)
  const log = views.filter((v) => v.state !== 'pending').slice(0, 30)

  const test = (severity: WakeSeverity): void => {
    void agent.wakeups
      .test(severity, where)
      .then(() => toast(`${SEVERITY_LOOK[severity].label} test ringing ${where === 'here' ? 'on this computer' : 'on every device'}.`))
      .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'The test did not ring.'))
  }
  const quiet = settings?.wakeupQuietHours ?? ''
  const ringHere = settings?.wakeupsRingHere ?? true
  const paused = pausedUntil(settings?.wakeupsPauseHereUntil ?? '', now)
  const pauseAt = Date.parse(pauseField)
  const pauseValid = Number.isFinite(pauseAt) && pauseAt > now
  const idleRule = settings?.wakeupsPhoneOnlyWhenIdle ?? true
  const idleMinutes = settings?.wakeupsIdleMinutes ?? 5

  return (
    <section className="wake">
      <SectionHeader eyebrow="WAKE-UPS" line="When something needs you now, your devices ring until you answer" />
      <div className="card wake-card">
        <p className="small muted wake-lead">
          Any agent, routine or desk can ring you: your phone through Do Not Disturb and this computer full screen, in the
          severity colour, saying exactly what to do. It never stops by itself. I&apos;m on it or Snooze on one device stops
          all of them. Only you can answer it.
        </p>

        <div className="rowc">
          <div className="ri">
            <Icon name="bell" size={22} />
          </div>
          <div className="rt">
            <b>Ring on this computer</b>
            <span>A loud alarm and a full-screen screen on every display</span>
          </div>
          <Switch on={ringHere} onToggle={(next) => void save({ wakeupsRingHere: next })} label="Ring on this computer" />
        </div>

        <div className={`rowc wake-pause${ringHere ? '' : ' off'}`}>
          <div className="ri">
            <Icon name="clock" size={22} />
          </div>
          <div className="rt">
            <b>{paused === null ? 'Pause ringing on this computer' : `Paused until ${dayClockLabel(paused)}`}</b>
            <span>
              {paused === null
                ? 'Until a date and time. Your phone keeps ringing.'
                : 'Your phone keeps ringing. Resumes by itself. If your phone does not confirm within 30 s, this computer rings anyway.'}
            </span>
          </div>
          {paused === null ? (
            <div className="wake-pause-set">
              <input
                className="input"
                type="datetime-local"
                aria-label="Pause ringing until"
                disabled={!ringHere}
                value={pauseField}
                min={fieldValue(now)}
                onChange={(event) => setPauseField(event.target.value)}
              />
              <Button size="sm" variant="tonal" disabled={!ringHere || !pauseValid} onClick={() => void save({ wakeupsPauseHereUntil: pauseField })}>
                Pause
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => void save({ wakeupsPauseHereUntil: '' })}>
              Resume
            </Button>
          )}
        </div>

        <div className={`rowc${ringHere ? '' : ' off'}`}>
          <div className="ri">
            <Icon name="moon" size={22} />
          </div>
          <div className="rt">
            <b>Only the phone when this computer is idle or locked</b>
            <span>If no phone confirms within 30 s, this computer rings anyway. It joins when you come back.</span>
          </div>
          <div className="wake-idle-set">
            <select className="rule-sel" aria-label="Idle after" disabled={!idleRule} value={IDLE_MINUTES.includes(idleMinutes) ? idleMinutes : 5} onChange={(event) => void save({ wakeupsIdleMinutes: Number(event.target.value) })}>
              {IDLE_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
            <Switch on={idleRule} onToggle={(next) => void save({ wakeupsPhoneOnlyWhenIdle: next })} label="Only the phone when this computer is idle or locked" />
          </div>
        </div>

        <div className="rowc">
          <div className="ri">
            <Icon name="clock" size={22} />
          </div>
          <div className="rt">
            <b>Snooze</b>
            <span>Rings again after this long, same severity</span>
          </div>
          <select className="rule-sel" aria-label="Snooze length" value={settings?.wakeupSnoozeMinutes ?? 5} onChange={(event) => void save({ wakeupSnoozeMinutes: Number(event.target.value) })}>
            {SNOOZES.map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </div>

        <div className="rowc">
          <div className="ri">
            <Icon name="moon" size={22} />
          </div>
          <div className="rt">
            <b>Quiet hours</b>
            <span>Only a heads-up is silent then. Urgent and critical always ring.</span>
          </div>
          <select className="rule-sel" aria-label="Quiet hours" value={quiet} onChange={(event) => void save({ wakeupQuietHours: event.target.value })}>
            {(QUIET_PRESETS.includes(quiet) ? QUIET_PRESETS : [...QUIET_PRESETS, quiet]).map((q) => (
              <option key={q} value={q}>
                {q === '' ? 'None' : q.replace('-', ' to ')}
              </option>
            ))}
          </select>
        </div>

        <div className="rowc">
          <div className="ri">
            <Icon name="sound" size={22} />
          </div>
          <div className="rt">
            <b>Alarm volume</b>
            <span>On this computer. The phone uses its alarm volume, raised while it rings.</span>
          </div>
          <input
            className="wake-vol"
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            aria-label="Alarm volume"
            value={settings?.wakeupVolume ?? 1}
            onChange={(event) => void save({ wakeupVolume: Number(event.target.value) })}
          />
        </div>

        <div className="wake-test">
          <div className="rt">
            <b>Test a wake-up</b>
            <span>Rings for real. Answer it to stop it.</span>
          </div>
          <div className="wake-where" role="radiogroup" aria-label="Where the test rings">
            {(['here', 'all'] as const).map((w) => (
              <button key={w} type="button" role="radio" aria-checked={where === w} className={`wake-chip${where === w ? ' on' : ''}`} onClick={() => setWhere(w)}>
                {w === 'here' ? 'This computer' : 'Every device'}
              </button>
            ))}
          </div>
          <div className="wake-tests">
            {(['critical', 'urgent', 'heads_up'] as const).map((severity) => (
              <Button key={severity} variant="tonal" size="sm" onClick={() => test(severity)}>
                <span className="wake-dot" style={{ background: SEVERITY_LOOK[severity].bg }} />
                {SEVERITY_LOOK[severity].label}
              </Button>
            ))}
          </div>
        </div>

        {ringing.length > 0 ? (
          <div className="wake-block">
            <b className="wake-h">Ringing now</b>
            {ringing.map((v) => (
              <WakeRow key={v.id} view={v} now={now} selfId={selfId}>
                <div className="wake-acts">
                  <Button size="sm" onClick={() => void agent.wakeups.ack(v.id).then(() => toast('Answered on every device.'))}>
                    I&apos;m on it
                  </Button>
                  {v.state === 'ringing' ? (
                    <Button size="sm" variant="line" onClick={() => void agent.wakeups.snooze(v.id)}>
                      Snooze
                    </Button>
                  ) : null}
                </div>
              </WakeRow>
            ))}
          </div>
        ) : null}

        {booked.length > 0 ? (
          <div className="wake-block">
            <b className="wake-h">Booked</b>
            {booked.slice(0, 10).map((v) => (
              <WakeRow key={v.id} view={v} now={now} selfId={selfId} />
            ))}
          </div>
        ) : null}

        <div className="wake-block">
          <b className="wake-h">Your phones</b>
          {devices.filter((d) => d.kind === 'phone' || d.kind === 'tablet').length === 0 ? (
            <p className="small muted wake-none">No phone linked. Link one in Devices, then open Wake-ups in the phone app once.</p>
          ) : null}
          {devices
            .filter((d) => d.kind === 'phone' || d.kind === 'tablet')
            .map((d) => (
              <div key={d.id} className="wake-dev">
                <div className="wake-dev-top">
                  <b>{d.name}</b>
                  <span className={`wake-pill${d.reachable ? ' ok' : ''}`}>{d.reachable ? 'Reachable now' : 'Not connected'}</span>
                  {d.appVersion !== '' ? <span className="small muted">app {d.appVersion}</span> : null}
                </div>
                {d.checks.length === 0 ? (
                  <p className="small muted wake-none">It has not reported yet. Open the Agent app on it once (version with Wake-ups).</p>
                ) : (
                  <ul className="wake-checks">
                    {d.checks.map((c) => (
                      <li key={c.key} className={c.ok ? 'ok' : 'bad'}>
                        <span aria-hidden="true">{c.ok ? '✓' : '!'}</span>
                        <span>
                          {c.label}
                          {!c.ok && c.help !== '' ? <span className="small muted"> {c.help}</span> : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
        </div>

        <div className="wake-block">
          <b className="wake-h">Wake-ups log</b>
          {log.length === 0 ? <p className="small muted wake-none">Nothing has rung yet.</p> : null}
          {log.map((v) => (
            <WakeRow key={v.id} view={v} now={now} selfId={selfId} />
          ))}
        </div>
      </div>
    </section>
  )
}

function WakeRow({ view, now, selfId, children }: { view: WakeView; now: number; selfId: string; children?: JSX.Element }): JSX.Element {
  const look = SEVERITY_LOOK[view.severity]
  const state =
    view.state === 'acked'
      ? `Answered ${clock(view.ackedAt ?? 0)}${view.ackedBy === '' ? '' : ` on ${view.ackedBy}`}`
      : view.state === 'pending'
        ? `Rings ${dayClock(view.ringAt, now)}`
        : view.state === 'snoozed'
          ? `Snoozed until ${clock(view.ringAt)}`
          : view.state === 'withdrawn'
            ? 'Withdrawn before it rang'
            : `Ringing since ${clock(view.ringAt)}`
  const where = view.targets.length === 0 ? 'every device' : view.targets.includes(selfId) ? 'this computer' : 'your other device'
  const notes = hereNotes(view, selfId)
  return (
    <div className="wake-row">
      <span className="wake-bar" style={{ background: look.bg }} />
      <div className="wake-body">
        <div className="wake-title">
          <span className="wake-sev" style={{ color: look.bg }}>
            {look.label}
          </span>{' '}
          {shownTitle(view)}
        </div>
        <div className="wake-what">{view.whatToDo}</div>
        <div className="small muted">
          {state} · from {view.firedBy || 'an agent'}
          {view.source.kind !== '' ? ` (${view.source.kind})` : ''} · sent to {where}
          {view.repeats > 0 ? ` · merged ${view.repeats} repeat${view.repeats === 1 ? '' : 's'}` : ''}
          {view.snoozes > 0 ? ` · snoozed ${view.snoozes}x` : ''}
        </div>
        {notes !== '' ? <div className="small muted wake-note">{notes}</div> : null}
        {children}
      </div>
    </div>
  )
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function dayClock(at: number, now: number): string {
  const d = new Date(at)
  const same = new Date(now).toDateString() === d.toDateString()
  return same ? clock(at) : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${clock(at)}`
}
