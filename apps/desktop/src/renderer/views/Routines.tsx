import type { TriggerRow } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { dayLabel, clock, nextRun, scheduleLabel } from '../lib/format'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
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

const TEMPLATES: Array<{ name: string; kind: TriggerRow['kind']; spec: string; prompt: string }> = [
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

function nextLabel(trigger: TriggerRow): string {
  const next = nextRun(trigger)
  if (next === null) return 'Off'
  return `${dayLabel(next)}, ${clock(next)}`
}

function RoutineDialog({
  template,
  onClose,
}: {
  template: (typeof TEMPLATES)[number] | null
  onClose: () => void
}): JSX.Element {
  const [name, setName] = useState(template?.name ?? '')
  const [kind, setKind] = useState<TriggerRow['kind']>(template?.kind ?? 'daily')
  const [spec, setSpec] = useState(template?.spec ?? '07:00')
  const [prompt, setPrompt] = useState(template?.prompt ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (name.trim() === '') {
      setError('Give the routine a name first.')
      return
    }
    if (spec.trim() === '') {
      setError('Choose when it should run.')
      return
    }
    setBusy(true)
    const now = Date.now()
    const row: TriggerRow = {
      id: '',
      createdAt: now,
      name: name.trim(),
      kind,
      spec: spec.trim(),
      prompt: prompt.trim(),
      enabled: true,
      lastRunAt: null,
      lastResult: 'Not run yet',
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
    <Dialog label="New routine" onClose={onClose} labelledBy="routine-dialog-title">
      <div>
        <span className="eyebrow">NEW ROUTINE</span>
        <h2 className="h2" id="routine-dialog-title" style={{ marginTop: 6 }}>
          A job on a schedule
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
        error={error}
      />
      <Segmented
        ariaLabel="How often"
        value={kind}
        onChange={(value) => {
          setKind(value)
          setSpec(value === 'daily' ? '07:00' : value === 'interval' ? '60' : new Date().toISOString())
        }}
        options={[
          { value: 'daily', label: 'Every day' },
          { value: 'interval', label: 'Every few minutes' },
          { value: 'at', label: 'One time' },
        ]}
      />
      <div className="field">
        <label htmlFor="routine-spec">{kind === 'daily' ? 'Time' : kind === 'interval' ? 'Minutes' : 'When'}</label>
        <input
          id="routine-spec"
          className="input"
          type={kind === 'daily' ? 'time' : kind === 'interval' ? 'number' : 'datetime-local'}
          value={kind === 'at' ? spec.slice(0, 16) : spec}
          onChange={(event) => {
            const value = event.target.value
            if (kind === 'at') {
              const date = new Date(value)
              setSpec(value === '' || Number.isNaN(date.getTime()) ? '' : date.toISOString())
            } else {
              setSpec(value)
            }
            setError('')
          }}
          style={{ paddingRight: 18 }}
        />
      </div>
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
          {busy ? 'Saving...' : 'Create routine'}
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
  const [creating, setCreating] = useState<(typeof TEMPLATES)[number] | null | 'blank'>(null)

  const sorted = [...triggers].sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
  const enabled = sorted.filter((trigger) => trigger.enabled)
  const next = enabled
    .map((trigger) => ({ trigger, when: nextRun(trigger) }))
    .filter((item): item is { trigger: TriggerRow; when: number } => item.when !== null)
    .sort((a, b) => a.when - b.when)[0]

  const toggle = (trigger: TriggerRow): void => {
    void agent.data.upsert('trigger', { ...trigger, enabled: !trigger.enabled })
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">ROUTINES</span>
          <h1 className="h1">{enabled.length} running on a schedule</h1>
          <p className="lead">Jobs your agent does without being asked.</p>
        </div>
        <div className="ph-actions">
          <Button onClick={() => setCreating('blank')}>
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
            <Button variant="tonal" size="sm" onClick={() => setCreating('blank')}>
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
              <Button variant="fill" comingSoon>
                <Icon name="play" size={18} />
                Run it now
              </Button>
            </div>
          ) : null}

          <div style={{ marginTop: 34 }}>
            <SectionHeader eyebrow="ALL ROUTINES" line="Switch one off and it stays, ready for later" />
            <div className="cols2">
              {sorted.map((trigger) => (
                <div className="rtn" key={trigger.id}>
                  <span className="mi2">
                    <Icon name="clock" size={22} />
                  </span>
                  <div className="rt">
                    <b>{trigger.name}</b>
                    <span>{scheduleLabel(trigger)}</span>
                    <br />
                    <span>
                      {trigger.lastRunAt === null ? 'Not run yet' : `Last: ${trigger.lastResult || 'Ran'}`}
                    </span>
                  </div>
                  <Switch
                    on={trigger.enabled}
                    onToggle={() => toggle(trigger)}
                    label={`Run ${trigger.name}`}
                  />
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 34 }}>
            <SectionHeader eyebrow="START FROM" line="Pick one and change anything" />
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {TEMPLATES.map((template) => (
                <button
                  key={template.name}
                  type="button"
                  className="chip"
                  onClick={() => setCreating(template)}
                >
                  <Icon name="plus" size={16} />
                  {template.name}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      <div className="banner" style={{ marginTop: 28 }}>
        Routines run while the app is open. The scheduler and notifications arrive with the live data milestone.
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
        already save for when it does.
      </div>

      {creating !== null ? (
        <RoutineDialog
          template={creating === 'blank' ? null : creating}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </div>
  )
}
