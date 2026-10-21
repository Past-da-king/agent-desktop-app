import type { TriggerRow } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { dayLabel, clock, nextRun, scheduleLabel, timeAgo } from '../lib/format'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { SectionHeader } from '../ui/SectionHeader'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import { Switch } from '../ui/Switch'

interface Template {
  name: string
  kind: TriggerRow['kind']
  spec: string
  prompt: string
}

const TEMPLATES: Template[] = [
  {
    name: 'Morning brief',
    kind: 'daily',
    spec: '07:00',
    prompt: 'Look at my calendar, inbox and to-dos, then tell me what needs me today.',
  },
  {
    name: 'Inbox sweep',
    kind: 'daily',
    spec: '12:30',
    prompt: 'Clear the noise from my inbox and flag anything that needs a reply.',
  },
  {
    name: 'Weekly review',
    kind: 'daily',
    spec: '16:00',
    prompt: 'Summarise the week: what moved, what is stuck, and what is next.',
  },
  {
    name: 'Bills reminder',
    kind: 'daily',
    spec: '09:00',
    prompt: 'Remind me about any bills due in the next few days.',
  },
  {
    name: 'Price watch',
    kind: 'daily',
    spec: '08:00',
    prompt: 'Check the things I am watching and tell me if a price moved.',
  },
]

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function localDateTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** A routine the app runs itself (End of day): only its time and on/off change, and it cannot be deleted. */
function isBuiltin(trigger: TriggerRow): boolean {
  return typeof trigger.builtin === 'string' && trigger.builtin !== ''
}

function nextLabel(trigger: TriggerRow): string {
  const next = nextRun(trigger)
  if (next === null) return 'Off'
  return `${dayLabel(next)}, ${clock(next)}`
}

function lastLabel(trigger: TriggerRow): string {
  if (trigger.lastRunAt === null) return 'Not run yet'
  const result = trigger.lastResult.trim() || 'Ran'
  const when = timeAgo(trigger.lastRunAt)
  const readable = when === 'now' ? 'just now' : when === 'Yesterday' || /^[A-Z][a-z]{2}$/.test(when) ? when : `${when} ago`
  return `Last run ${readable}: ${result}`
}

function RoutineDialog({
  trigger,
  template,
  onClose,
}: {
  trigger: TriggerRow | null
  template: Template | null
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(trigger?.name ?? template?.name ?? '')
  const [kind, setKind] = useState<TriggerRow['kind']>(trigger?.kind ?? template?.kind ?? 'daily')
  const [spec, setSpec] = useState(trigger?.spec ?? template?.spec ?? '07:00')
  const [prompt, setPrompt] = useState(trigger?.prompt ?? template?.prompt ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const changeKind = (next: TriggerRow['kind']): void => {
    setKind(next)
    setError('')
    if (next === 'daily') setSpec('07:00')
    else if (next === 'interval') setSpec('60')
    else {
      const later = new Date(Date.now() + 60 * 60_000)
      later.setSeconds(0, 0)
      setSpec(later.toISOString())
    }
  }

  const builtin = trigger !== null && typeof trigger.builtin === 'string' && trigger.builtin !== ''

  const save = async (): Promise<void> => {
    if (builtin && trigger !== null) {
      if (!/^\d{1,2}:\d{2}$/.test(spec.trim())) {
        setError('Choose the time it should run.')
        return
      }
      setBusy(true)
      try {
        if (name.trim() === '') {
          setError('Give the routine a name first.')
          setBusy(false)
          return
        }
        await agent.data.upsert('trigger', { id: trigger.id, name: name.trim(), spec: spec.trim() })
        onClose()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not save that time.')
        setBusy(false)
      }
      return
    }
    if (name.trim() === '') {
      setError('Give the routine a name first.')
      return
    }
    if (kind === 'interval') {
      const minutes = Number(spec)
      if (!Number.isFinite(minutes) || minutes < 1) {
        setError('Use a number of minutes of 1 or more.')
        return
      }
    }
    if (kind === 'at') {
      const when = new Date(spec).getTime()
      if (!Number.isFinite(when)) {
        setError('Choose the day and time it should run.')
        return
      }
    }
    setBusy(true)
    const now = Date.now()
    const row: TriggerRow = {
      id: trigger?.id ?? '',
      createdAt: trigger?.createdAt ?? now,
      name: name.trim(),
      kind,
      spec: spec.trim(),
      prompt: prompt.trim(),
      enabled: trigger?.enabled ?? true,
      lastRunAt: trigger?.lastRunAt ?? null,
      lastResult: trigger?.lastResult ?? 'Not run yet',
    }
    try {
      await agent.data.upsert('trigger', row)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that routine.')
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={trigger ? 'Edit routine' : 'New routine'}
      onClose={onClose}
      labelledBy="routine-dialog-title"
    >
      <div>
        <span className="eyebrow">{trigger ? 'EDIT ROUTINE' : 'NEW ROUTINE'}</span>
        <h2 className="h2" id="routine-dialog-title" style={{ marginTop: 6 }}>
          {trigger ? 'Change this routine' : 'A job on a schedule'}
        </h2>
      </div>
      <Field
        label="Name"
        value={name}
        onChange={(value) => {
          setName(value)
          setError('')
        }}
        placeholder="Morning brief"
        error={builtin ? undefined : error}
      />
      {builtin ? (
        <p className="lead">{trigger?.prompt}</p>
      ) : (
        <>
          <Segmented
            ariaLabel="How often"
            value={kind}
            onChange={changeKind}
            options={[
              { value: 'daily', label: 'Every day' },
              { value: 'interval', label: 'Every few minutes' },
              { value: 'at', label: 'One time' },
            ]}
          />
        </>
      )}
      <div className="field">
        <label htmlFor="routine-spec">
          {kind === 'daily' ? 'Time' : kind === 'interval' ? 'Minutes between runs' : 'When'}
        </label>
        <input
          id="routine-spec"
          className="input"
          type={kind === 'daily' ? 'time' : kind === 'interval' ? 'number' : 'datetime-local'}
          min={kind === 'interval' ? 1 : undefined}
          value={kind === 'at' ? localDateTime(spec) : spec}
          onChange={(event) => {
            const value = event.target.value
            if (kind === 'at') {
              const date = new Date(value)
              setSpec(value === '' || Number.isNaN(date.getTime()) ? value : date.toISOString())
            } else {
              setSpec(value)
            }
            setError('')
          }}
          style={{ paddingRight: 18 }}
        />
        {builtin && error !== '' ? <span className="small" role="alert">{error}</span> : null}
      </div>
      {builtin ? null : (
        <div className="field">
          <label htmlFor="routine-prompt">What should it do?</label>
          <textarea
            id="routine-prompt"
            className="textarea"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Tell the agent what to look at and what to report back."
          />
        </div>
      )}
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            void save()
          }}
          disabled={busy}
        >
          {busy ? 'Saving...' : trigger ? 'Save changes' : 'Create routine'}
        </Button>
      </div>
    </Dialog>
  )
}

export function Routines(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const triggers = useEntity('trigger')
  const loaded = useEntityLoaded('trigger')
  const navigate = useUi((state) => state.navigate)
  const [dialog, setDialog] = useState<{ trigger: TriggerRow | null; template: Template | null } | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)

  const sorted = [...triggers].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  const enabled = sorted.filter((trigger) => trigger.enabled)
  const next = enabled
    .map((trigger) => ({ trigger, when: nextRun(trigger) }))
    .filter((item): item is { trigger: TriggerRow; when: number } => item.when !== null)
    .sort((a, b) => a.when - b.when)[0]

  const toggle = (trigger: TriggerRow): void => {
    void agent.data.upsert('trigger', { ...trigger, enabled: !trigger.enabled }).catch((cause: unknown) => {
      toast(cause instanceof Error ? cause.message : 'Could not change that routine.')
    })
  }

  const runNow = async (trigger: TriggerRow): Promise<void> => {
    setRunningId(trigger.id)
    try {
      await agent.routines.runNow(trigger.id)
      toast(`${trigger.name} is running now.`)
    } catch {
      toast(`${trigger.name} is saved and ready. Running it from here needs the scheduler, which is not switched on in this build.`)
    } finally {
      setRunningId(null)
    }
  }

  const remove = (trigger: TriggerRow): void => {
    void agent.data
      .remove('trigger', trigger.id)
      .then(() => {
        toast('Routine deleted.', {
          actionLabel: 'Undo',
          onAction: () => {
            void agent.data.upsert('trigger', trigger)
          },
        })
      })
      .catch((cause: unknown) => {
        toast(cause instanceof Error ? cause.message : 'Could not delete that routine.')
      })
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">ROUTINES</span>
          <h1 className="h1">
            {enabled.length === 0 ? 'Nothing on a schedule yet' : `${enabled.length} running on a schedule`}
          </h1>
          <p className="lead">Jobs your agent does without being asked.</p>
        </div>
        <div className="ph-actions">
          <Button onClick={() => setDialog({ trigger: null, template: null })}>
            <Icon name="plus" size={18} />
            New routine
          </Button>
        </div>
      </div>

      {!loaded ? (
        <Skeleton rows={4} />
      ) : triggers.length === 0 ? (
        <EmptyState
          mascot={settings?.mascot ?? 'scout'}
          title="No routines yet"
          line="A routine is a small job the agent does on its own, like a morning brief or an inbox sweep."
          action={
            <Button variant="tonal" size="sm" onClick={() => setDialog({ trigger: null, template: null })}>
              Create a routine
            </Button>
          }
        />
      ) : (
        <>
          {next ? (
            <div className="next">
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="eyebrow">NEXT UP</div>
                <div className="n1">{next.trigger.name}</div>
                <div className="n2">
                  {nextLabel(next.trigger)}. {next.trigger.prompt || 'It runs on its own and reports back.'}
                </div>
              </div>
              <Button
                variant="fill"
                disabled={runningId === next.trigger.id}
                onClick={() => {
                  void runNow(next.trigger)
                }}
              >
                <Icon name="play" size={18} />
                {runningId === next.trigger.id ? 'Running...' : 'Run it now'}
              </Button>
            </div>
          ) : null}

          <div style={{ marginTop: 34 }}>
            <SectionHeader eyebrow="ALL ROUTINES" line="Switch one off and it stays, ready for later" />
            <div className="rtn-grid">
              {sorted.map((trigger) => (
                <div className="rtn" key={trigger.id}>
                  <span className="mi2">
                    <Icon name={isBuiltin(trigger) ? 'sync' : 'clock'} size={22} />
                  </span>
                  <div className="rt">
                    <b>
                      {trigger.name}
                    </b>
                    <span className="rt-when">{scheduleLabel(trigger)}</span>
                    <span className="rt-last">{lastLabel(trigger)}</span>
                  </div>
                  <div className="rtn-actions">
                    <button
                      type="button"
                      className="ib"
                      aria-label={`Run ${trigger.name} now`}
                      title="Run now"
                      disabled={runningId === trigger.id}
                      onClick={() => {
                        void runNow(trigger)
                      }}
                    >
                      <Icon name="play" size={18} />
                    </button>
                    <button
                      type="button"
                      className="ib"
                      aria-label={`Edit ${trigger.name}`}
                      title="Edit"
                      onClick={() => setDialog({ trigger, template: null })}
                    >
                      <Icon name="edit" size={18} />
                    </button>
                    <button
                      type="button"
                      className="ib"
                      aria-label={`Delete ${trigger.name}`}
                      title="Delete"
                      onClick={() => remove(trigger)}
                    >
                      <Icon name="trash" size={18} />
                    </button>
                    <Switch
                      on={trigger.enabled}
                      onToggle={() => toggle(trigger)}
                      label={`Run ${trigger.name}`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {loaded ? (
        <div style={{ marginTop: 34 }}>
          <SectionHeader eyebrow="START FROM" line="Pick one and change anything" />
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {TEMPLATES.map((template) => (
              <button
                key={template.name}
                type="button"
                className="chip"
                onClick={() => setDialog({ trigger: null, template })}
              >
                <Icon name="plus" size={16} />
                {template.name}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="banner" style={{ marginTop: 28 }}>
        Routines run while the app is open. Anything missed while it was closed runs once on the next start.
        {' '}
        <button
          type="button"
          className="linkish"
          onClick={() => {
            navigate({ page: 'settings' })
          }}
        >
          Notification settings
        </button>{' '}
        decide whether results are shown on screen.
      </div>

      {dialog ? (
        <RoutineDialog
          trigger={dialog.trigger}
          template={dialog.template}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  )
}
