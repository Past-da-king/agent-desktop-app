import {
  GOOD_FOR_MAX,
  MAX_ROSTER,
  NO_PICK,
  accountById,
  accountsOf,
  cleanRoster,
  defaultGoodFor,
  knownRoster,
  mainRosterOf,
  pickModel,
  resolveRoster,
  rosterName,
  type AiPick,
  type AiPicks,
  type AiRosterEntry,
  type AiSlot,
  type ModelOption,
  type Settings,
} from '@agent/core'
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

/** Where a menu opens: under its button, or just above it when there is more room there; inside the window. */
type MenuAt = { top?: number; bottom?: number; left: number; width: number; maxHeight: number }
function placeUnder(button: HTMLElement | null): MenuAt | null {
  const rect = button?.getBoundingClientRect()
  if (rect === undefined) return null
  const width = Math.min(Math.max(rect.width, 340), window.innerWidth - 32)
  const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))
  const below = window.innerHeight - rect.bottom - 24
  const above = rect.top - 24
  if (below < 380 && above > below) return { bottom: window.innerHeight - rect.top + 8, left, width, maxHeight: Math.min(520, above) }
  return { top: rect.bottom + 8, left, width, maxHeight: Math.min(520, below) }
}

/** Closes a menu on a click outside it (and outside its button) or Esc. */
function useDismiss(open: boolean, refs: Array<{ current: HTMLElement | null }>, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (refs.every((ref) => ref.current?.contains(target) !== true)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close()
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, refs, close])
}

/**
 * The menu every chooser opens, over the whole window: the accounts (and "Same as …" when there is something to
 * follow), then the chosen account's models, asked live, with search. Picking an account keeps the menu open on its
 * models; picking a model is the end (`done`).
 */
function PickMenu({
  settings,
  value,
  at,
  title,
  same,
  menuRef,
  onPick,
}: {
  settings: Settings
  value: AiPick | null
  at: MenuAt
  title: string
  /** The "Same as the main thread" row: what it reads as, and whether it is the current choice. */
  same?: { label: string; line: string; on: boolean; onPick: () => void }
  menuRef: React.RefObject<HTMLDivElement>
  onPick: (pick: AiPick, done: boolean) => void
}): JSX.Element {
  const accounts = accountsOf(settings)
  const own = value === null ? null : accountById(settings, value.account)
  const [models, setModels] = useState<{ id: string; list: ModelOption[]; message: string } | null>(null)

  useEffect(() => {
    if (own === null) return
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
  }, [own])

  const options = models === null || own === null ? [] : [own.kind === 'api' ? ACCOUNT_DEFAULT : PLAN_DEFAULT, ...models.list.filter((m) => m.id !== '')]

  return createPortal(
    <div ref={menuRef} className="aipop" role="dialog" aria-label={title} style={{ ...(at.top === undefined ? {} : { top: at.top }), ...(at.bottom === undefined ? {} : { bottom: at.bottom }), left: at.left, width: at.width, maxHeight: at.maxHeight }}>
      <div className="aipop-h">
        <span className="eyebrow">ACCOUNT</span>
      </div>
      <div className="aipop-accts" role="radiogroup" aria-label="Account">
        {same !== undefined ? (
          <button type="button" role="radio" aria-checked={same.on} className={`aipop-acct${same.on ? ' on' : ''}`} onClick={same.onPick}>
            <span className="aipick-glyph same" aria-hidden="true">
              <AccountGlyph kind="same" />
            </span>
            <span className="aipop-acct-t">
              <b>{same.label}</b>
              <span>{same.line}</span>
            </span>
            {same.on ? <Icon name="check" size={18} /> : null}
          </button>
        ) : null}
        {accounts.map((each) => {
          const on = same?.on !== true && value?.account === each.id
          return (
            <button
              key={each.id}
              type="button"
              role="radio"
              aria-checked={on}
              className={`aipop-acct${on ? ' on' : ''}`}
              onClick={() => {
                if (!on) onPick({ account: each.id, model: '' }, false)
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
      {own !== null && same?.on !== true ? (
        <>
          <div className="aipop-h">
            <span className="eyebrow">MODEL ON {own.label.toUpperCase()}</span>
          </div>
          {models === null ? (
            <p className="aipop-wait">Asking {own.label} for its models</p>
          ) : (
            <>
              {options.length > 1 ? null : <p className="aipop-wait">{models.message}</p>}
              <ModelList models={options} value={value?.model ?? ''} onPick={(id) => onPick({ account: own.id, model: id }, true)} autoFocus />
            </>
          )}
        </>
      ) : null}
    </div>,
    document.body,
  )
}

/** The model a pick runs, in words. */
function modelName(settings: Settings, value: AiPick): string {
  const owner = accountById(settings, value.account)
  if (owner === null) return 'Not set up'
  const chosen = pickModel(settings, value)
  return chosen !== '' ? chosen : owner.kind === 'api' ? 'Default model' : 'What the plan picks'
}

/**
 * The agent's slot: who thinks for it, as ONE chooser. The row shows the account and the model in full words.
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
  const inherited = inherit !== undefined && pick.account === ''
  // What the slot runs on right now: its own pick, or the main thread's when it follows it.
  const effective = inherited && inherit !== undefined ? inherit : pick
  const account = accountById(settings, effective.account)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState<MenuAt | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const refs = useRef([button, menu]).current
  const close = useRef(() => setOpen(false)).current
  useDismiss(open, refs, close)

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
        aria-label={`${meta.title}: ${inherited ? 'same as the main thread, ' : ''}${account?.label ?? 'not set up'}, ${modelName(settings, effective)}. Change`}
        onClick={() => {
          setAt(placeUnder(button.current))
          setOpen((value) => !value)
        }}
      >
        <span className={`aipick-glyph${inherited ? ' same' : ''}`} aria-hidden="true">
          <AccountGlyph kind={inherited ? 'same' : (account?.kind ?? 'api')} />
        </span>
        <span className="aipick-val">
          <b>{inherited ? 'Same as the main thread' : (account?.label ?? 'Choose an account')}</b>
          <span>{inherited ? `${account?.label ?? 'Not set up'} · ${modelName(settings, effective)}` : modelName(settings, effective)}</span>
        </span>
        <Icon name="chevd" size={16} />
      </button>
      {note !== undefined && note !== '' ? <span className="aipick-note">{note}</span> : null}
      {open && at !== null ? (
        <PickMenu
          settings={settings}
          value={inherited ? null : pick}
          at={at}
          title={`${meta.title}: what it thinks with`}
          menuRef={menu}
          {...(inherit === undefined
            ? {}
            : {
                same: {
                  label: 'Same as the main thread',
                  line: pickLine(settings, inherit),
                  on: inherited,
                  onPick: () => {
                    onChange(NO_PICK)
                    setOpen(false)
                  },
                },
              })}
          onPick={(next, done) => {
            onChange(next)
            if (done) {
              setOpen(false)
              button.current?.focus()
            }
          }}
        />
      ) : null}
    </div>
  )
}

/** A list of helper models as the picks store it: the list, and the one helpers pick mirroring its first. */
export function withRoster(picks: AiPicks, roster: AiRosterEntry[]): AiPicks {
  const clean = cleanRoster(roster)
  const first = clean[0]
  return { ...picks, helpers: first === undefined ? NO_PICK : { account: first.account, model: first.model }, roster: clean }
}

/** The list a set of picks holds of its own: its roster, else its one helpers pick. Empty = it follows another. */
export function ownRoster(settings: Settings, picks: AiPicks): AiRosterEntry[] {
  const list = knownRoster(settings, picks.roster)
  if (list.length > 0) return list
  return picks.helpers.account !== '' && accountById(settings, picks.helpers.account) !== null ? [{ account: picks.helpers.account, model: picks.helpers.model, goodFor: '' }] : []
}

/** One helper model in the list: what it is, what it is good for, and its controls. */
function RosterEntry({
  settings,
  entry,
  index,
  count,
  onEdit,
  onNote,
  onFirst,
  onRemove,
  editing,
  buttonRef,
}: {
  settings: Settings
  entry: AiRosterEntry
  index: number
  count: number
  onEdit: () => void
  onNote: (goodFor: string) => void
  onFirst: () => void
  onRemove: () => void
  editing: boolean
  buttonRef: (node: HTMLButtonElement | null) => void
}): JSX.Element {
  const account = accountById(settings, entry.account)
  const [note, setNote] = useState(entry.goodFor)
  useEffect(() => setNote(entry.goodFor), [entry.goodFor])
  const commit = (): void => {
    const clean = note.replace(/\s+/g, ' ').trim().slice(0, GOOD_FOR_MAX)
    if (clean !== entry.goodFor) onNote(clean)
  }
  const name = rosterName(settings, entry)
  return (
    <li className={`rost-row${index === 0 ? ' first' : ''}${editing ? ' open' : ''}`}>
      <div className="rost-top">
        <button ref={buttonRef} type="button" className="rost-pick" aria-haspopup="dialog" aria-expanded={editing} aria-label={`${name}. Change`} onClick={onEdit}>
          <span className="aipick-glyph" aria-hidden="true">
            <AccountGlyph kind={account?.kind ?? 'api'} />
          </span>
          <span className="aipick-val">
            <b>{modelName(settings, entry)}</b>
            <span>{account?.label ?? 'Not set up'}</span>
          </span>
          {index === 0 && count > 1 ? <span className="rost-first">Default</span> : null}
          <Icon name="chevd" size={16} />
        </button>
        <span className="rost-acts">
          {index > 0 ? (
            <button type="button" className="rost-ib" title="Make it the default" aria-label={`Make ${name} the default`} onClick={onFirst}>
              <Icon name="arrow" size={16} />
            </button>
          ) : null}
          {count > 1 ? (
            <button type="button" className="rost-ib" title="Take it off the list" aria-label={`Remove ${name}`} onClick={onRemove}>
              <Icon name="x" size={16} />
            </button>
          ) : null}
        </span>
      </div>
      <div className="rost-note">
        <span className="rost-note-k" aria-hidden="true">
          Good for
        </span>
        <input
          value={note}
          maxLength={GOOD_FOR_MAX}
          aria-label={`What ${name} is good for`}
          placeholder={`e.g. ${(defaultGoodFor(pickModel(settings, entry)).split(/[;:]/)[0] ?? '').split(',')[0]}`}
          onChange={(event) => setNote(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
              event.currentTarget.blur()
            }
          }}
        />
      </div>
    </li>
  )
}

/**
 * The helpers' row: the models they may run on, first = the default, each with what it is good for; the agent picks
 * one per job. In a project, an empty list follows the main thread's (or the project's own agent), shown read-only.
 */
function HelperModels({
  settings,
  picks,
  inherit,
  note,
  onChange,
}: {
  settings: Settings
  picks: AiPicks
  inherit?: AiPicks
  note?: string
  onChange: (picks: AiPicks) => void
}): JSX.Element {
  // The main thread always has a list: its own, else the one model its helpers run on now (its agent's).
  const own = inherit === undefined && ownRoster(settings, picks).length === 0 ? mainRosterOf(settings) : ownRoster(settings, picks)
  const inherited = inherit !== undefined && own.length === 0
  // What it follows: in a project, its own agent when that is set, else the main thread's list.
  const followsAgent = inherited && picks.main.account !== '' && accountById(settings, picks.main.account) !== null
  const shown = inherited ? (followsAgent ? resolveRoster(settings, { main: picks.main, helpers: NO_PICK }) : resolveRoster(settings, inherit)) : own
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [at, setAt] = useState<MenuAt | null>(null)
  const buttons = useRef(new Map<number | 'new', HTMLButtonElement>())
  const anchor = useRef<HTMLElement | null>(null)
  const menu = useRef<HTMLDivElement>(null)
  const refs = useRef([anchor, menu]).current
  const close = useRef(() => setEditing(null)).current
  useDismiss(editing !== null, refs, close)

  const write = (list: AiRosterEntry[]): void => onChange(withRoster(picks, list))
  const open = (key: number | 'new'): void => {
    const node = buttons.current.get(key) ?? null
    anchor.current = node
    setAt(placeUnder(node))
    setEditing((current) => (current === key ? null : key))
  }
  const current: AiPick | null = editing === null || editing === 'new' ? null : (own[editing] ?? null)

  return (
    <div className="aipick rost">
      <span className="aipick-ic" aria-hidden="true">
        <Icon name="tasks" size={16} />
      </span>
      <span className="aipick-t">
        <b>Helpers</b>
        <span>{shown.length > 1 ? 'Your agent picks one per job' : 'The work it hands out'}</span>
      </span>
      {inherited ? (
        <button ref={(node) => void (node === null ? buttons.current.delete('new') : buttons.current.set('new', node))} type="button" className="btn tonal sm rost-own" onClick={() => write(shown)}>
          <Icon name="edit" size={16} />
          Choose for this project
        </button>
      ) : own.length < MAX_ROSTER ? (
        <button ref={(node) => void (node === null ? buttons.current.delete('new') : buttons.current.set('new', node))} type="button" className="btn tonal sm rost-add" aria-haspopup="dialog" aria-expanded={editing === 'new'} onClick={() => open('new')}>
          <Icon name="plus" size={16} />
          Add a model
        </button>
      ) : (
        <span className="small muted rost-full">{MAX_ROSTER} at most</span>
      )}
      {inherited ? (
        <div className="rost-same">
          <span className="aipick-glyph same" aria-hidden="true">
            <AccountGlyph kind="same" />
          </span>
          <span className="aipick-val">
            <b>{followsAgent ? "Same as this project's agent" : 'Same as the main thread'}</b>
            <span>{shown.length === 0 ? 'Not set up' : shown.map((entry) => modelName(settings, entry)).join(' · ')}</span>
          </span>
        </div>
      ) : (
        <ol className="rost-list">
          {own.length === 0 ? <li className="rost-empty">No AI account yet. Add one in Settings, then choose models here.</li> : null}
          {own.map((entry, index) => (
            <RosterEntry
              key={`${entry.account}:${entry.model}`}
              settings={settings}
              entry={entry}
              index={index}
              count={own.length}
              editing={editing === index}
              buttonRef={(node) => void (node === null ? buttons.current.delete(index) : buttons.current.set(index, node))}
              onEdit={() => open(index)}
              onNote={(goodFor) => write(own.map((each, i) => (i === index ? { ...each, goodFor } : each)))}
              onFirst={() => write([entry, ...own.filter((_, i) => i !== index)])}
              onRemove={() => write(own.filter((_, i) => i !== index))}
            />
          ))}
        </ol>
      )}
      {!inherited && inherit !== undefined ? (
        <button type="button" className="rost-follow" onClick={() => write([])}>
          Use the main thread&apos;s helpers instead
        </button>
      ) : null}
      {note !== undefined && note !== '' ? <span className="aipick-note">{note}</span> : null}
      {editing !== null && at !== null ? (
        <PickMenu
          settings={settings}
          value={current}
          at={at}
          title={editing === 'new' ? 'Add a helper model' : 'Change this helper model'}
          menuRef={menu}
          onPick={(next, done) => {
            if (editing === 'new') {
              // The account lands at once (on its default model); the menu stays on it to pick the model.
              const list = [...own, { account: next.account, model: next.model, goodFor: '' }]
              write(list)
              const index = list.length - 1
              setEditing(done ? null : index)
            } else {
              write(own.map((each, i) => (i === editing ? { ...each, account: next.account, model: next.model } : each)))
              if (done) setEditing(null)
            }
          }}
        />
      ) : null}
    </div>
  )
}

/** Both rows together: the agent's one chooser, and the helpers' list of models. */
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
      <AiPickRow
        settings={settings}
        slot="main"
        pick={picks.main}
        {...(inherit === undefined ? {} : { inherit: inherit.main })}
        {...(notes?.main === undefined ? {} : { note: notes.main })}
        onChange={(pick) => onChange({ ...picks, main: pick })}
      />
      <HelperModels settings={settings} picks={picks} {...(inherit === undefined ? {} : { inherit })} {...(notes?.helpers === undefined ? {} : { note: notes.helpers })} onChange={onChange} />
    </div>
  )
}
