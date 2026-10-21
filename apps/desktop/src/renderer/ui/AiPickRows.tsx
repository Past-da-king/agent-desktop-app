import { accountById, accountsOf, type AiPick, type AiPicks, type AiSlot, type ModelOption, type Settings } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { pickLine } from '../lib/ai'
import { Icon } from './Icon'
import { ModelList } from './ModelList'

/** On a plan, an empty model means "what the plan picks". */
const PLAN_DEFAULT: ModelOption = { id: '', label: 'Default', line: 'What your plan picks' }
const ACCOUNT_DEFAULT: ModelOption = { id: '', label: 'Default', line: "The account's own model" }

/** The two rows every chooser shows: who the agent thinks with, and who its helpers think with. */
export const SLOTS: Array<{ slot: AiSlot; title: string; line: string; icon: 'bolt' | 'tasks' }> = [
  { slot: 'main', title: 'Agent', line: 'Talks in the chat', icon: 'bolt' },
  { slot: 'helpers', title: 'Helpers', line: 'The work it hands out', icon: 'tasks' },
]

/**
 * One slot: an account menu and, once an account is chosen, its models asked live. `inherit` is the pick that
 * applies when this one is left as "same as the main thread" (project dialogs); absent for the main thread itself.
 */
export function AiPickRow({
  settings,
  slot,
  pick,
  inherit,
  note,
  onChange,
}: {
  settings: Settings
  slot: AiSlot
  pick: AiPick
  inherit?: AiPick
  /** A line under the row, e.g. "Switches when you start a new chat". */
  note?: string
  onChange: (pick: AiPick) => void
}): JSX.Element {
  const meta = SLOTS.find((each) => each.slot === slot) ?? SLOTS[0]!
  const accounts = accountsOf(settings)
  const account = accountById(settings, pick.account)
  const [models, setModels] = useState<{ id: string; list: ModelOption[]; message: string } | null>(null)
  const [openModels, setOpenModels] = useState(false)

  useEffect(() => {
    if (!openModels || account === null) return
    let live = true
    setModels(null)
    agent.settings.accounts
      .listModels(account.id)
      .then((result) => {
        if (live) setModels({ id: account.id, list: result.models, message: result.message })
      })
      .catch(() => {
        if (live) setModels({ id: account.id, list: [], message: `Could not ask ${account.label} for its models.` })
      })
    return () => {
      live = false
    }
  }, [openModels, account])

  const options = models === null ? [] : [account?.kind === 'api' ? ACCOUNT_DEFAULT : PLAN_DEFAULT, ...models.list.filter((m) => m.id !== '')]
  const inherited = inherit !== undefined && pick.account === ''
  const shownModel = inherited ? pickLine(settings, inherit) : account === null ? '' : pickLine(settings, pick)

  return (
    <div className={`aipick${inherited ? ' same' : ''}`}>
      <span className="aipick-ic" aria-hidden="true">
        <Icon name={meta.icon} size={16} />
      </span>
      <span className="aipick-t">
        <b>{meta.title}</b>
        <span>{meta.line}</span>
      </span>
      <label className="aipick-sel">
        <span className="small muted">Account</span>
        <select
          className="input"
          aria-label={`${meta.title}: account`}
          value={pick.account}
          onChange={(event) => {
            setOpenModels(false)
            onChange({ account: event.target.value, model: '' })
          }}
        >
          {inherit !== undefined ? <option value="">Same as the main thread</option> : null}
          {accounts.map((each) => (
            <option key={each.id} value={each.id}>
              {each.label}
            </option>
          ))}
        </select>
      </label>
      <div className="aipick-model">
        <span className="small muted">Model</span>
        <button
          type="button"
          className="input aipick-model-btn"
          aria-haspopup="listbox"
          aria-expanded={openModels}
          disabled={inherited || account === null}
          onClick={() => setOpenModels((value) => !value)}
          title={inherited ? 'Follows the main thread' : undefined}
        >
          <span>{inherited ? shownModel : pick.model.trim() === '' ? `Default${account?.model.trim() ? ` (${account.model.trim()})` : ''}` : pick.model}</span>
          <Icon name="chevd" size={14} />
        </button>
        {openModels && account !== null ? (
          <div className="aipick-menu" role="listbox" aria-label={`${meta.title}: models on ${account.label}`}>
            {models === null ? (
              <p className="small muted model-wait">Asking {account.label} for its models</p>
            ) : (
              <>
                {options.length > 1 ? null : <p className="small muted model-wait">{models.message}</p>}
                <ModelList
                  models={options}
                  value={pick.model}
                  onPick={(id) => {
                    onChange({ account: pick.account, model: id })
                    setOpenModels(false)
                  }}
                  autoFocus
                />
              </>
            )}
          </div>
        ) : null}
      </div>
      {note !== undefined && note !== '' ? <span className="aipick-note">{note}</span> : null}
    </div>
  )
}

/** Both rows together. */
export function AiPickRows({
  settings,
  picks,
  inherit,
  notes,
  onChange,
}: {
  settings: Settings
  picks: AiPicks
  /** The main thread's picks, when these are a project's. */
  inherit?: AiPicks
  notes?: Partial<Record<AiSlot, string>>
  onChange: (picks: AiPicks) => void
}): JSX.Element {
  return (
    <div className="aipicks">
      {SLOTS.map(({ slot }) => (
        <AiPickRow
          key={slot}
          settings={settings}
          slot={slot}
          pick={picks[slot]}
          {...(inherit === undefined ? {} : { inherit: slot === 'helpers' && inherit.helpers.account === '' ? inherit.main : inherit[slot] })}
          {...(notes?.[slot] === undefined ? {} : { note: notes[slot] })}
          onChange={(pick) => onChange({ ...picks, [slot]: pick })}
        />
      ))}
    </div>
  )
}
