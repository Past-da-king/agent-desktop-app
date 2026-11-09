/**
 * The Workers section of the Routines page: every background worker, whether it is running, when it last said
 * something, what it emitted and where that went, its log, and its keys. Everything the app knows is on screen.
 */
import type { WorkerEvent, WorkerInfo, WorkerLogLine, WorkerState } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { clock } from '../lib/format'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useWorkers } from '../state/useWorkers'
import { aboutWorker } from '../state/workersStore'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'

const STATE_LABEL: Record<WorkerState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  waiting: 'Waiting for its next run',
  backoff: 'Restarting',
  failing: 'Failing, not retrying',
}

export function ago(stamp: number | null, now = Date.now()): string {
  if (stamp === null) return 'never'
  const seconds = Math.max(0, Math.round((now - stamp) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

function clockOf(stamp: number): string {
  const date = new Date(stamp)
  const today = new Date()
  // The same 24-hour clock the routines above use; this used to print "05:41 PM" beside "Every day at 23:30".
  const time = clock(stamp)
  return date.toDateString() === today.toDateString() ? time : `${date.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`
}

function summary(worker: WorkerInfo): string {
  if (worker.state === 'running' || worker.state === 'starting') return `Up since ${clockOf(worker.upSince ?? Date.now())}`
  if (worker.state === 'waiting' && worker.nextRunAt !== null) return `Next run ${clockOf(worker.nextRunAt)}`
  if (worker.state === 'backoff' && worker.nextRunAt !== null) return `Trying again ${clockOf(worker.nextRunAt)}`
  if (worker.downSince !== null) return `Down since ${clockOf(worker.downSince)}`
  return worker.enabled ? 'Not started' : 'Switched off'
}

function payloadLine(event: WorkerEvent): string {
  try {
    const parsed: unknown = JSON.parse(event.payload)
    if (typeof parsed === 'object' && parsed !== null) {
      const o = parsed as Record<string, unknown>
      const from = typeof o['from'] === 'string' ? o['from'] : typeof o['user'] === 'string' ? o['user'] : ''
      const text = typeof o['text'] === 'string' ? o['text'] : typeof o['subject'] === 'string' ? o['subject'] : ''
      if (text !== '') return from === '' ? text : `${from}: ${text}`
    }
  } catch {
    // Fall through to the raw text.
  }
  return event.payload
}

export function WorkersSection(): JSX.Element | null {
  const { workers, loaded, error, reload } = useWorkers()
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  if (!loaded) return null
  const anyOn = workers.some((w) => w.enabled)

  return (
    <div style={{ marginTop: 34 }}>
      <SectionHeader eyebrow="WORKERS" line="Background scripts that tell your agent when something happens" />
      {error !== '' ? (
        <div className="banner wk-failed">
          The workers could not be read: {error}{' '}
          <button type="button" className="linkish" onClick={reload}>
            Try again
          </button>
        </div>
      ) : workers.length === 0 ? (
        <div className="banner">
          No workers yet. Ask your agent for one, for example: "watch my team chat and wake you up when someone messages me". It writes the script, you approve it once, and it shows here.
        </div>
      ) : (
        <div className="wk-list">
          {workers.map((worker) => (
            <WorkerCard key={worker.id} worker={worker} />
          ))}
        </div>
      )}
      {anyOn && settings !== null && !settings.launchAtLogin ? (
        <div className="banner wk-login" style={{ marginTop: 14 }}>
          Workers run while the app is open; when it opens again they catch up on what they missed. Open the app when you sign in so nothing waits.{' '}
          <button
            type="button"
            className="linkish"
            onClick={() => {
              void save({ launchAtLogin: true })
                .then(() => toast('The app now opens when you sign in.'))
                .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not change that setting.'))
            }}
          >
            Open at sign-in
          </button>
        </div>
      ) : null}
    </div>
  )
}

function WorkerCard({ worker }: { worker: WorkerInfo }): JSX.Element {
  const [open, setOpen] = useState<'events' | 'log' | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const missing = worker.secrets.filter((name) => !worker.secretsSet.includes(name))
  const live = worker.state === 'running' || worker.state === 'starting' || worker.state === 'waiting' || worker.state === 'backoff'

  const act = async (what: 'start' | 'stop' | 'restart' | 'remove'): Promise<void> => {
    setBusy(true)
    try {
      await agent.workers[what](worker.id)
      if (what === 'remove') toast(`${worker.name} deleted.`)
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not work.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`wk ${worker.state}`}>
      <div className="wk-head">
        <span className={`wk-dot ${worker.state}`} aria-hidden="true" />
        <div className="wk-title">
          <b>{worker.name}</b>
          <span>
            {STATE_LABEL[worker.state]} · {summary(worker)}
          </span>
        </div>
        <div className="rtn-actions">
          {live ? (
            <button type="button" className="ib" title="Stop" aria-label={`Stop ${worker.name}`} disabled={busy} onClick={() => void act('stop')}>
              <Icon name="stop" size={18} />
            </button>
          ) : (
            <button type="button" className="ib" title="Start" aria-label={`Start ${worker.name}`} disabled={busy} onClick={() => void act('start')}>
              <Icon name="play" size={18} />
            </button>
          )}
          <button type="button" className="ib" title="Restart" aria-label={`Restart ${worker.name}`} disabled={busy} onClick={() => void act('restart')}>
            <Icon name="sync" size={18} />
          </button>
          <button type="button" className="ib" title="Open its folder" aria-label={`Open the folder of ${worker.name}`} onClick={() => {
              void agent.workers.openFolder(worker.id).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not open its folder.'))
            }}>
            <Icon name="folder" size={18} />
          </button>
          <button
            type="button"
            className="ib"
            title="Delete"
            aria-label={`Delete ${worker.name}`}
            disabled={busy}
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" size={18} />
          </button>
        </div>
      </div>
      {worker.about !== '' ? <p className="wk-about">{worker.about}</p> : null}
      <div className="wk-facts">
        <span>
          Last event <b>{ago(worker.lastEventAt)}</b>
        </span>
        <span>
          Today <b>{worker.eventsToday}</b> events, <b>{worker.restartsToday}</b> restarts
        </span>
        <span>
          Last heard <b>{ago(worker.lastLineAt)}</b>
        </span>
        {worker.lastGap !== null && worker.lastGap.to - worker.lastGap.from >= 60_000 ? (
          <span>
            Last gap {clockOf(worker.lastGap.from)} to {clockOf(worker.lastGap.to)}, caught up <b>{worker.lastGap.caughtUp}</b>
          </span>
        ) : null}
      </div>
      {worker.lastError !== '' && worker.state !== 'running' ? (
        <div className={`wk-error ${worker.state === 'failing' ? 'bad' : ''}`}>
          <Icon name="bolt" size={16} />
          <span>{worker.lastError}</span>
        </div>
      ) : null}
      {missing.map((name) => (
        <SecretField key={name} worker={worker} name={name} />
      ))}
      <div className="wk-tabs">
        <button type="button" className={`chip ${open === 'events' ? 'on' : ''}`} onClick={() => setOpen(open === 'events' ? null : 'events')}>
          Events
        </button>
        <button type="button" className={`chip ${open === 'log' ? 'on' : ''}`} onClick={() => setOpen(open === 'log' ? null : 'log')}>
          Log
        </button>
        <span className="wk-meta">
          {worker.runtime} · {worker.mode === 'stay' ? 'always on' : `every ${worker.everyMinutes} min`} · {worker.id}
        </span>
      </div>
      {open === 'events' ? <EventList worker={worker} /> : null}
      {open === 'log' ? <LogList worker={worker} /> : null}
      {confirmDelete ? (
        <Dialog label="Delete worker" onClose={() => setConfirmDelete(false)} labelledBy={`wk-del-${worker.id}`}>
          <div>
            <span className="eyebrow">DELETE WORKER</span>
            <h2 className="h2" id={`wk-del-${worker.id}`} style={{ marginTop: 6 }}>
              Delete {worker.name}?
            </h2>
          </div>
          <p className="wk-confirm">Its script, its keys and its events go with it. This cannot be undone.</p>
          <div className="dialog-actions">
            <Button variant="text" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              className="danger"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(false)
                void act('remove')
              }}
            >
              Delete worker
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

function SecretField({ worker, name }: { worker: WorkerInfo; name: string }): JSX.Element {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <form
      className="wk-secret"
      onSubmit={(event) => {
        event.preventDefault()
        if (value.trim() === '') return
        setBusy(true)
        void agent.workers
          .setSecret(worker.id, name, value)
          .then(() => agent.workers.restart(worker.id))
          .then(() => {
            setValue('')
            toast(`${name} saved. ${worker.name} restarted with it.`)
          })
          .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not save that key.'))
          .finally(() => setBusy(false))
      }}
    >
      <label htmlFor={`wk-${worker.id}-${name}`}>
        <Icon name="key" size={16} /> {name} is not set
      </label>
      <input
        id={`wk-${worker.id}-${name}`}
        className="input"
        type="password"
        autoComplete="off"
        value={value}
        placeholder="Paste the key"
        onChange={(event) => setValue(event.target.value)}
      />
      <Button size="sm" type="submit" disabled={busy || value.trim() === ''}>
        Save
      </Button>
    </form>
  )
}

function EventList({ worker }: { worker: WorkerInfo }): JSX.Element {
  const [events, setEvents] = useState<WorkerEvent[] | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void agent.workers
        .events(worker.id, 30)
        .then((list) => {
          if (!alive) return
          setEvents(list)
          setFailed('')
        })
        .catch((cause: unknown) => {
          // Without this the list sat on "Reading..." for ever when the read failed.
          if (alive) setFailed(cause instanceof Error ? cause.message : 'Could not read its events.')
        })
    }
    read()
    // Only when this worker changed; another worker's burst of log lines is not ours to read.
    const off = agent.workers.onChange((changed) => {
      if (aboutWorker(changed, worker.id)) read()
    })
    return () => {
      alive = false
      off()
    }
  }, [worker.id])
  if (failed !== '' && events === null) return <div className="wk-rows small wk-failed">{failed}</div>
  if (events === null) return <div className="wk-rows small muted">Reading...</div>
  if (events.length === 0) return <div className="wk-rows small muted">Nothing emitted yet.</div>
  return (
    <ul className="wk-rows">
      {events.map((event) => (
        <li key={event.id}>
          <span className="wk-when">{clockOf(event.receivedAt)}</span>
          <span className={`wk-status ${event.status}`}>{event.status}</span>
          <span className="wk-what">
            <b>{event.event}</b> {payloadLine(event)}
            {event.note !== '' ? <em> · {event.note}</em> : null}
          </span>
        </li>
      ))}
    </ul>
  )
}

function LogList({ worker }: { worker: WorkerInfo }): JSX.Element {
  const [lines, setLines] = useState<WorkerLogLine[] | null>(null)
  const [failed, setFailed] = useState('')
  useEffect(() => {
    let alive = true
    const read = (): void => {
      void agent.workers
        .logs(worker.id, 80)
        .then((list) => {
          if (!alive) return
          setLines(list)
          setFailed('')
        })
        .catch((cause: unknown) => {
          if (alive) setFailed(cause instanceof Error ? cause.message : 'Could not read its log.')
        })
    }
    read()
    // Only when this worker changed; another worker's burst of log lines is not ours to read.
    const off = agent.workers.onChange((changed) => {
      if (aboutWorker(changed, worker.id)) read()
    })
    return () => {
      alive = false
      off()
    }
  }, [worker.id])
  if (failed !== '' && lines === null) return <div className="wk-rows small wk-failed">{failed}</div>
  if (lines === null) return <div className="wk-rows small muted">Reading...</div>
  if (lines.length === 0) return <div className="wk-rows small muted">No log lines yet.</div>
  return (
    <ul className="wk-rows wk-log">
      {lines.map((line, index) => (
        <li key={`${line.at}-${index}`} className={line.level}>
          <span className="wk-when">{line.at === 0 ? '' : clockOf(line.at)}</span>
          <span className="wk-what">{line.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** Home's Needs-you cards for workers that stopped retrying. */
export function FailingWorkers(): JSX.Element | null {
  const { workers } = useWorkers()
  const failing = workers.filter((w) => w.state === 'failing')
  if (failing.length === 0) return null
  return (
    <>
      {failing.map((worker) => (
        <div className="need" key={worker.id}>
          <div className="eyebrow">
            <Icon name="bolt" size={14} />
            WORKER STOPPED
          </div>
          <div className="q">{worker.name} keeps failing</div>
          <div className="small">{worker.lastError || 'It stopped too often, so the app stopped restarting it.'}</div>
          <div className="chips">
            <Button
              size="sm"
              variant="on-tc"
              onClick={() => {
                void agent.workers.start(worker.id).catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not start it.'))
              }}
            >
              Try again
            </Button>
          </div>
        </div>
      ))}
    </>
  )
}

/** How many workers need the person, for Home's "Needs you" count. */
export function useFailingCount(): number {
  return useWorkers().workers.filter((w) => w.state === 'failing').length
}
