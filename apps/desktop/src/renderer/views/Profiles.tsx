/**
 * Profiles, ported from the phone's ui/screens/Profiles.kt: parts of the person's life (Work,
 * Personal...). A profile groups what a helper may use: connected accounts, learned apps and its own
 * browser sign-ins. Every helper works inside exactly one; only the main agent may use everything.
 * General (none of the person's accounts) is the default for jobs that need nothing, so it is never
 * shown here. Everything goes through window.agent.profiles.
 */
import {
  PROFILE_COLORS,
  type AgentProfileInfo,
  type ConnectedAccount,
  type LearnedAppInfo,
  type ProfileColor,
} from '@agent/core'
import { useEffect, useState, type CSSProperties } from 'react'

import { agent } from '../bridge'
import { COLOR_LABELS, accountLabel, initialOf, logoUrl, nextColor, toneStyle, visibleProfiles } from '../lib/profiles'
import { AppLogo } from './ConnectedApps'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

export function tone(color: string): CSSProperties {
  return toneStyle(color) as CSSProperties
}

/** The person's own profiles (General hidden), reloaded when the main process says they changed. Null while loading. */
export function useProfiles(): AgentProfileInfo[] | null {
  const [list, setList] = useState<AgentProfileInfo[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    agent.profiles
      .list()
      .then((next) => {
        if (live) setList(visibleProfiles(next))
      })
      .catch(() => {
        if (live) setList([])
      })
    return () => {
      live = false
    }
  }, [tick])
  useEffect(() => agent.profiles.onChanged(() => setTick((n) => n + 1)), [])
  return list
}

export function ProfileBadge({ name, color, size = 'md' }: { name: string; color: string; size?: 'sm' | 'md' | 'lg' }): JSX.Element {
  return (
    <span className={`pf pf-badge${size === 'md' ? '' : ` ${size}`}`} style={tone(color)} aria-hidden="true">
      {initialOf(name)}
    </span>
  )
}

/** Toggle chips: which profiles one account or learned app belongs to. It can be in several. */
export function MemberChips({
  label,
  profiles,
  isMember,
  onToggle,
}: {
  label: string
  profiles: AgentProfileInfo[]
  isMember: (profile: AgentProfileInfo) => boolean
  onToggle: (profile: AgentProfileInfo, member: boolean) => Promise<void>
}): JSX.Element | null {
  if (profiles.length === 0) return null
  return (
    <div className="pf-in" role="group" aria-label={`Profiles for ${label}`}>
      {profiles.map((p) => {
        const member = isMember(p)
        return (
          <button
            key={p.id}
            type="button"
            className="pf pf-chip"
            style={tone(p.color)}
            aria-pressed={member}
            title={member ? `In ${p.name}. Press to take it out.` : `Add it to ${p.name}`}
            onClick={() => {
              onToggle(p, !member).catch((cause: unknown) => {
                toast(errorText(cause, 'The profile could not be changed.'))
              })
            }}
          >
            {member ? <Icon name="check" size={14} /> : <span className="pf-dot" aria-hidden="true" />}
            {p.name}
          </button>
        )
      })}
    </div>
  )
}

export function accountChips(account: ConnectedAccount, profiles: AgentProfileInfo[]): JSX.Element | null {
  return (
    <MemberChips
      label={accountLabel(account)}
      profiles={profiles}
      isMember={(p) => p.accounts.some((a) => a.id === account.id)}
      onToggle={(p, member) => agent.profiles.setMember(p.id, account.id, member)}
    />
  )
}

export function learnedChips(app: LearnedAppInfo, profiles: AgentProfileInfo[]): JSX.Element | null {
  return (
    <MemberChips
      label={app.name}
      profiles={profiles}
      isMember={(p) => p.learned.includes(app.id)}
      onToggle={async (p, member) => {
        const learned = member ? [...p.learned.filter((x) => x !== app.id), app.id] : p.learned.filter((x) => x !== app.id)
        const result = await agent.profiles.update(p.id, { learned })
        if (!result.ok) toast(result.message)
      }}
    />
  )
}

// ---- the editor ---------------------------------------------------------------------------------

interface CheckItem {
  id: string
  tile: string
  title: string
  line: string
  /** The app's logo; a lettered tile stands in when there is none or it does not load. */
  logo?: string
}

function Checklist({ items, picked, onToggle }: { items: CheckItem[]; picked: string[]; onToggle: (id: string) => void }): JSX.Element {
  return (
    <div className="pf-accts">
      {items.map((item) => {
        const on = picked.includes(item.id)
        return (
          <label key={item.id} className="pf-acct">
            <AppLogo name={item.tile} size="sm" {...(item.logo === undefined || item.logo === '' ? {} : { logo: item.logo })} />
            <span className="rt">
              <b>{item.title}</b>
              <span>{item.line}</span>
            </span>
            <input type="checkbox" checked={on} onChange={() => onToggle(item.id)} />
            <span className="pf-check" aria-hidden="true">
              {on ? <Icon name="check" size={16} /> : null}
            </span>
          </label>
        )
      })}
    </div>
  )
}

export function ProfileDialog({
  profile,
  all,
  accounts,
  learnedApps,
  onClose,
  onMade,
}: {
  /** Null for a new profile. */
  profile: AgentProfileInfo | null
  /** The person's profiles (without General). */
  all: AgentProfileInfo[]
  accounts: ConnectedAccount[]
  learnedApps: LearnedAppInfo[]
  onClose: () => void
  onMade?: (profile: AgentProfileInfo) => void
}): JSX.Element {
  const [name, setName] = useState(profile?.name ?? '')
  const [color, setColor] = useState<ProfileColor>(profile?.color ?? nextColor(all))
  const [picked, setPicked] = useState<string[]>(profile?.accounts.map((a) => a.id) ?? [])
  const [learned, setLearned] = useState<string[]>(profile?.learned ?? [])
  const [browser, setBrowser] = useState(profile?.browser ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const others = all.filter((p) => p.id !== profile?.id)
  const shownName = name.trim() === '' ? (profile === null ? 'New profile' : profile.name) : name.trim()

  const active = accounts.filter((a) => a.status === 'active')
  // Accounts the profile remembers that are no longer connected still show, so nothing vanishes silently.
  const accountItems: CheckItem[] = [
    ...active
      .slice()
      .sort((a, b) => a.appName.localeCompare(b.appName) || accountLabel(a).localeCompare(accountLabel(b)))
      .map((a) => ({ id: a.id, tile: a.appName, title: accountLabel(a), line: a.appName, logo: a.logo || logoUrl(a.app) })),
    ...(profile?.accounts ?? [])
      .filter((a) => !active.some((c) => c.id === a.id))
      .map((a) => ({ id: a.id, tile: a.app, title: a.label, line: 'Not connected right now', logo: logoUrl(a.app) })),
  ]
  const learnedItems: CheckItem[] = learnedApps.map((app) => ({ id: app.id, tile: app.name, title: app.name, line: app.host }))

  const flip = (list: string[], id: string): string[] => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const save = async (): Promise<void> => {
    if (name.trim() === '') {
      setError('Give the profile a name.')
      return
    }
    setBusy(true)
    try {
      const draft = { name: name.trim(), color, browser, accounts: picked, learned }
      if (profile === null) {
        const result = await agent.profiles.create(draft)
        if (!result.ok) {
          setError(result.message)
          return
        }
        toast(`Made ${name.trim()}`)
        if (result.profile !== undefined) onMade?.(result.profile)
      } else {
        const result = await agent.profiles.update(profile.id, draft)
        if (!result.ok) {
          setError(result.message)
          return
        }
        toast(`Saved ${name.trim()}`)
      }
      onClose()
    } catch (cause: unknown) {
      setError(errorText(cause, 'The profile could not be saved. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (profile === null) return
    setBusy(true)
    try {
      await agent.profiles.remove(profile.id)
      toast(`Deleted ${profile.name}`)
      onClose()
    } catch (cause: unknown) {
      setError(errorText(cause, 'The profile could not be deleted. Try again.'))
      setBusy(false)
    }
  }

  return (
    <Dialog label={profile === null ? 'New profile' : profile.name} onClose={onClose} labelledBy="pf-title" className="pf-dialog">
      <div className="pf-head">
        <ProfileBadge name={shownName} color={color} size="lg" />
        <div style={{ minWidth: 0 }}>
          <span className="eyebrow">{profile === null ? 'NEW PROFILE' : 'PROFILE'}</span>
          <h2 className="h2" id="pf-title">
            {shownName}
          </h2>
        </div>
      </div>
      <p className="pf-lead">
        A part of your life. Helpers given this profile can use only what is ticked here. Your main agent can still use everything.
      </p>

      <Field
        label="Name"
        value={name}
        onChange={(value) => {
          setName(value.slice(0, 40))
          setError('')
        }}
        placeholder="Strat Edge work"
        autoComplete="off"
        onEnter={() => void save()}
      />

      <div className="pf-part">
        <span className="eyebrow">COLOUR</span>
        <p>Its helpers show in this colour, so you can tell them apart at a glance.</p>
        <div className="pf-swatches" role="radiogroup" aria-label="Colour">
          {PROFILE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={COLOR_LABELS[c]}
              title={COLOR_LABELS[c]}
              className="pf pf-swatch"
              style={tone(c)}
              onClick={() => setColor(c)}
            >
              {c === color ? <Icon name="check" size={18} /> : null}
            </button>
          ))}
        </div>
      </div>

      <div className="pf-part">
        <span className="eyebrow">
          ACCOUNTS <span className="pf-count">{picked.length}</span>
        </span>
        <p>With one account of an app in the profile, that one is picked for its helpers.</p>
        {accountItems.length === 0 ? (
          <p className="pf-empty">No apps connected yet. Connect one, then tick it here.</p>
        ) : (
          <Checklist items={accountItems} picked={picked} onToggle={(id) => setPicked((now) => flip(now, id))} />
        )}
      </div>

      <div className="pf-part">
        <span className="eyebrow">
          LEARNED APPS <span className="pf-count">{learned.length}</span>
        </span>
        <p>Sites your agent taught itself, which its helpers may run.</p>
        {learnedItems.length === 0 ? (
          <p className="pf-empty">Nothing learned yet. Ask your agent to learn a site, then tick it here.</p>
        ) : (
          <Checklist items={learnedItems} picked={learned} onToggle={(id) => setLearned((now) => flip(now, id))} />
        )}
      </div>

      <div className="pf-part">
        <span className="eyebrow">BROWSER SIGN-INS</span>
        <p>Which sign-ins its helpers browse with. Its own keeps them apart from your other profiles.</p>
        <div className="pf-chips" role="radiogroup" aria-label="Browser sign-ins">
          <button type="button" role="radio" aria-checked={browser === ''} className={`chip${browser === '' ? ' on' : ''}`} onClick={() => setBrowser('')}>
            <Icon name="globe" size={16} />
            <span className="chip-t">Its own</span>
          </button>
          {others.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={browser === p.id}
              className="pf pf-chip"
              style={tone(p.color)}
              onClick={() => setBrowser(p.id)}
            >
              <span className="pf-dot" aria-hidden="true" />
              Same as {p.name}
            </button>
          ))}
        </div>
      </div>

      {error !== '' ? (
        <p className="pf-err" role="alert">
          {error}
        </p>
      ) : null}

      {deleting && profile !== null ? (
        <div className="pf-danger">
          <p>
            Delete {profile.name}? Its accounts stay connected and its browser sign-ins stay on this computer. Helpers can no longer be
            given it.
          </p>
          <Button variant="tonal" size="sm" onClick={() => setDeleting(false)}>
            Keep it
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </div>
      ) : null}

      <div className="dialog-actions pf-actions">
        {profile !== null && !deleting ? (
          <Button variant="text" className="pf-del" onClick={() => setDeleting(true)}>
            <Icon name="trash" size={16} />
            Delete profile
          </Button>
        ) : null}
        <span className="pf-right">
          <Button variant="tonal" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving...' : profile === null ? 'Make profile' : 'Save'}
          </Button>
        </span>
      </div>
    </Dialog>
  )
}
