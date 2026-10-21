import type { BrowserPerson, BrowserState } from '@agent/core'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'

import { agent } from '../bridge'
import { toneStyle } from '../lib/profiles'
import { useUi } from '../state/useUi'
import { Icon } from '../ui/Icon'

/** The browser profiles, read again when the person switches profile, opens the menu or a profile changes. */
export function usePeople(state: BrowserState | null, refresh: number): BrowserPerson[] {
  const [people, setPeople] = useState<BrowserPerson[]>([])
  const [tick, setTick] = useState(0)
  useEffect(() => agent.profiles.onChanged(() => setTick((n) => n + 1)), [])
  const personPartition = state?.personPartition ?? ''
  useEffect(() => {
    let live = true
    void agent.browser
      .people()
      .then((next) => {
        if (live) setPeople(next)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [personPartition, tick, refresh])
  return people
}

function Avatar({ person, size = 24 }: { person: BrowserPerson; size?: number }): JSX.Element {
  return (
    <span className="pf bp-av" style={{ ...(toneStyle(person.color) as CSSProperties), width: size, height: size }} aria-hidden="true">
      {person.kind === 'mine' ? <Icon name="person" size={Math.round(size * 0.62)} /> : person.kind === 'shared' ? <Icon name="bolt" size={Math.round(size * 0.58)} /> : (person.name.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}

function whoLine(person: BrowserPerson): string {
  if (person.kind === 'mine') return person.usedBy.length === 0 ? 'Only you. No agent uses it.' : `You, and ${person.usedBy.join(', ')} (lent)`
  return `Used by ${person.usedBy.join(', ')}`
}

/**
 * The browser's profile switch, like Chrome's: which profile the tabs you open use, the Google accounts signed in
 * to each, and a way to sign one out. Your own (Mine) is never used by an agent unless you lend it to a profile.
 */
export function BrowserPeople({ state, compact = false }: { state: BrowserState | null; compact?: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [confirm, setConfirm] = useState<string | null>(null)
  const people = usePeople(state, refresh)
  const navigate = useUi((store) => store.navigate)
  const box = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const current = people.find((person) => person.current) ?? people[0]

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (box.current?.contains(target) !== true && menu.current?.contains(target) !== true) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  if (current === undefined) return null
  return (
    <div className="bp" ref={box}>
      <button
        type="button"
        className={`bp-btn${compact ? ' compact' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Your tabs open in ${current.name}${current.google[0] !== undefined ? ` (${current.google[0]})` : ''}`}
        aria-label={`Browser profile: ${current.name}`}
        onClick={(event) => {
          // Drawn over the whole window (the page and the card would clip it), under the button, kept on screen.
          const rect = event.currentTarget.getBoundingClientRect()
          setAt({ top: rect.bottom + 6, left: Math.max(16, Math.min(rect.left, window.innerWidth - 376)) })
          setConfirm(null)
          setRefresh((n) => n + 1)
          setOpen(!open)
        }}
      >
        <Avatar person={current} size={compact ? 26 : 22} />
        {compact ? null : (
          <>
            <span className="bp-name">{current.name}</span>
            <Icon name="chevd" size={14} />
          </>
        )}
      </button>
      {open && at !== null ? createPortal(
        <div className="bp-menu" role="menu" aria-label="Browser profiles" ref={menu} style={{ top: at.top, left: at.left }}>
          <div className="bp-head">
            <span className="eyebrow">BROWSER PROFILES</span>
            <span className="small muted">Each keeps its own sign-ins. New tabs you open use the one you pick.</span>
          </div>
          {people.map((person) => (
            <div key={person.id} className={`bp-row${person.current ? ' on' : ''}`}>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={person.current}
                className="bp-pick"
                onClick={() => {
                  void agent.browser.usePerson(person.id).then(() => setOpen(false))
                }}
              >
                <Avatar person={person} size={32} />
                <span className="bp-t">
                  <b>{person.name}</b>
                  <span>{person.google.length === 0 ? 'Not signed in to Google' : person.google.join(', ')}</span>
                  <span className="bp-who">{whoLine(person)}</span>
                </span>
                {person.current ? <Icon name="check" size={18} /> : null}
              </button>
              {confirm === person.id ? (
                <span className="bp-confirm">
                  <button
                    type="button"
                    className="bp-link danger"
                    onClick={() => {
                      void agent.browser.signOut(person.id).then(() => {
                        setConfirm(null)
                        setRefresh((n) => n + 1)
                      })
                    }}
                  >
                    Sign out of every site
                  </button>
                  <button type="button" className="bp-link" onClick={() => setConfirm(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" className="bp-link" aria-label={`Sign ${person.name} out of every site`} onClick={() => setConfirm(person.id)}>
                  Sign out
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="bp-manage"
            onClick={() => {
              setOpen(false)
              navigate({ page: 'connections' })
            }}
          >
            <Icon name="sliders" size={16} />
            Manage profiles
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

/** The profile a tab belongs to, by its partition. */
export function personOfTab(people: BrowserPerson[], partition: string | undefined): BrowserPerson | undefined {
  return partition === undefined ? undefined : people.find((person) => person.partition === partition)
}
