import { accountById, accountsOf, type AiPick, type AiPicks, type AiSlot, type ModelOption, type Settings } from '@agent/core'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { agent } from '../bridge'
import { kindLine, pickLine } from '../lib/ai'
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

/** The account's glyph: a plan runs on the person's subscription, a key is billed by the provider. */
function AccountGlyph({ kind, size = 16 }: { kind: 'claude' | 'codex' | 'api' | 'same'; size?: number }): JSX.Element {
  return <Icon name={kind === 'api' ? 'key' : kind === 'same' ? 'sync' : 'bolt'} size={size} />
}

/**
 * One slot: who thinks for it, as ONE chooser. The row shows the account and the model in full words; the menu
 * lists the accounts (and "Same as the main thread" in a project) and that account's models, asked live, with search.
 * `inherit` is what applies when the slot is left as the main thread's (project dialogs); absent for the main thread.
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
  const inherited = inherit !== undefined && pick.account === ''
  // What the slot runs on right now: its own pick, or the main thread's when it follows it.
  const effective = inherited && inherit !== undefined ? inherit : pick
  const account = accountById(settings, effective.account)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<{ top: number; left: number; width: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [models, setModels] = useState<{ id: string; list: ModelOption[]; message: string } | null>(null)
  const own = accountById(settings, pick.account)

  useEffect(() => {
    if (!open || own === null) return
    let live = true
    setModels(null)
    agent.settings.accounts
      .listModels(own.id)
      .then((result) => {
        if (live) setModels({ id: own.id, list: result.models, message: result.message })
      })
      .catch(() => {
        if (live) setModels({ id: own.id, list: [], message: `Could not ask ${own.label} for its models.` })
      })
    return () => {
      live = false
    }
  }, [open, own])

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (button.current?.contains(target) !== true && menu.current?.contains(target) !== true) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
        button.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const toggle = (): void => {
    const rect = button.current?.getBoundingClientRect()
    if (rect !== undefined) {
      // Under the button, as wide as it (at least 340), kept inside the window; above it when there is no room below.
      const width = Math.min(Math.max(rect.width, 340), window.innerWidth - 32)
      const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))
      const below = window.innerHeight - rect.bottom
      const top = below < 380 && rect.top > below ? Math.max(16, rect.top - 8 - Math.min(460, rect.top - 24)) : rect.bottom + 8
      setAt({ top, left, width })
    }
    setOpen((value) => !value)
  }

  const modelName = (value: AiPick): string => {
    const owner = accountById(settings, value.account)
    if (owner === null) return 'Not set up'
    const chosen = value.model.trim()
    if (chosen !== '') return chosen
    const fallback = owner.model.trim()
    return fallback !== '' ? fallback : owner.kind === 'api' ? 'Default model' : 'What the plan picks'
  }
  const options =
    models === null || own === null ? [] : [own.kind === 'api' ? ACCOUNT_DEFAULT : PLAN_DEFAULT, ...models.list.filter((m) => m.id !== '')]

  return (
    <div className="aipick">
      <span className="aipick-ic" aria-hidden="true">
        <Icon name={meta.icon} size={16} />
      </span>
      <span className="aipick-t">
        <b>{meta.title}</b>
        <span>{meta.line}</span>
      </span>
      <button
        ref={button}
        type="button"
        className={`aipick-btn${open ? ' open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${meta.title}: ${inherited ? 'same as the main thread, ' : ''}${account?.label ?? 'not set up'}, ${modelName(effective)}. Change`}
        onClick={toggle}
      >
        <span className={`aipick-glyph${inherited ? ' same' : ''}`} aria-hidden="true">
          <AccountGlyph kind={inherited ? 'same' : (account?.kind ?? 'api')} />
        </span>
        <span className="aipick-val">
          <b>{inherited ? 'Same as the main thread' : (account?.label ?? 'Choose an account')}</b>
          <span>{inherited ? `${account?.label ?? 'Not set up'} · ${modelName(effective)}` : modelName(effective)}</span>
        </span>
        <Icon name="chevd" size={16} />
      </button>
      {note !== undefined && note !== '' ? <span className="aipick-note">{note}</span> : null}
      {open && at !== null
        ? createPortal(
            <div ref={menu} className="aipop" role="dialog" aria-label={`${meta.title}: what it thinks with`} style={{ top: at.top, left: at.left, width: at.width }}>
              <div className="aipop-h">
                <span className="eyebrow">ACCOUNT</span>
              </div>
              <div className="aipop-accts" role="radiogroup" aria-label="Account">
                {inherit !== undefined ? (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={inherited}
                    className={`aipop-acct${inherited ? ' on' : ''}`}
                    onClick={() => {
                      onChange({ account: '', model: '' })
                      setOpen(false)
                    }}
                  >
                    <span className="aipick-glyph same" aria-hidden="true">
                      <AccountGlyph kind="same" />
                    </span>
                    <span className="aipop-acct-t">
                      <b>Same as the main thread</b>
                      <span>{pickLine(settings, inherit)}</span>
                    </span>
                    {inherited ? <Icon name="check" size={18} /> : null}
                  </button>
                ) : null}
                {accounts.map((each) => {
                  const on = !inherited && pick.account === each.id
                  return (
                    <button
                      key={each.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`aipop-acct${on ? ' on' : ''}`}
                      onClick={() => {
                        if (!on) onChange({ account: each.id, model: '' })
                      }}
                    >
                      <span className="aipick-glyph" aria-hidden="true">
                        <AccountGlyph kind={each.kind} />
                      </span>
                      <span className="aipop-acct-t">
                        <b>{each.label}</b>
                        <span>{kindLine(each)}</span>
                      </span>
                      {on ? <Icon name="check" size={18} /> : null}
                    </button>
                  )
                })}
              </div>
              {own !== null && !inherited ? (
                <>
                  <div className="aipop-h">
                    <span className="eyebrow">MODEL ON {own.label.toUpperCase()}</span>
                  </div>
                  {models === null ? (
                    <p className="aipop-wait">Asking {own.label} for its models</p>
                  ) : (
                    <>
                      {options.length > 1 ? null : <p className="aipop-wait">{models.message}</p>}
                      <ModelList
                        models={options}
                        value={pick.model}
                        onPick={(id) => {
                          onChange({ account: pick.account, model: id })
                          setOpen(false)
                          button.current?.focus()
                        }}
                        autoFocus
                      />
                    </>
                  )}
                </>
              ) : null}
            </div>,
            document.body,
          )
        : null}
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
