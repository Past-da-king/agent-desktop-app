/**
 * Settings (redesigned 4 Nov 2026, the approved mock-ups): a section rail with the ten sections and their counts, one
 * search field that finds every setting in every section (hidden ones too), one row shape for every setting, and the
 * danger zone at the bottom of Privacy and data.
 *
 * The rows, their labels, their descriptions and the sections live in views/settings/registry.ts, so the page, the
 * rail, the search box and the tests all read the same list. Every change saves as it happens, through the same
 * settings call the rest of the window uses (useSettings.save); nothing about how settings are stored or synced
 * changed. A row says its default and offers Reset only while its value is not the default, and a group of rows (the
 * AI accounts, the folders, the devices) is never emptied by one button.
 */
import type { AiAccount, AiPicks, GitLogEntry, Settings as SettingsValues } from '@agent/core'
import { VOICES } from '@agent/core'
import { useCallback, useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import type { Route } from '../state/route'
import { accountsOf } from '@agent/core'
import { kindLine } from '../lib/ai'
import { folderName } from '../lib/files'
import { timeAgo } from '../lib/format'
import { ACCENTS, applyAccent } from '../state/theme'
import { useAccountStatus } from '../state/useAccount'
import { refreshDevicesSummary, useDevicesData } from '../state/useDevices'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { IconButton, Pill } from '../ui/bits'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { AiPickRows } from '../ui/AiPickRows'
import { Mascot, MASCOT_ORDER, MASCOTS } from '../ui/Mascot'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'
import { AccountDialog } from './AiAccounts'
import { DevicesSettings } from './Devices'
import { outcome, waiting } from './GitSettings'
import { speakText, stopSpeaking, useSpeaker } from '../voice/speaker'
import { WakeLog } from './settings/WakeLog'
import { SettingsRail, DEFAULT_SECTION } from './settings/Rail'
import { DateTimeControl, HotkeyControl, NumberControl, SelectControl, SliderControl, TextControl, TimeControl } from './settings/Controls'
import { SectionBlock, SettingRow } from './settings/Row'
import { PromptRulesSettings } from './PromptRules'
import { takeSettingsSection } from '../lib/settings-jump'
import { VaultSettings } from './Vault'
import { ROW_BY_KEY, defaultOf, isDefault, railSections, searchSettings, type RowSpec, type SectionId } from './settings/registry'

const row = (key: string): RowSpec => {
  const spec = ROW_BY_KEY[key]
  if (spec === undefined) throw new Error(`Settings has no row for ${key}`)
  return spec
}

/** A row that is never emptied by one button: a group of rows, a value read from somewhere else, or a name. */
const isQuiet = (spec: RowSpec): boolean => spec.quiet === true || spec.control === 'block' || spec.control === 'readonly'

/** What the row says about itself: changed only when a single value is not the default. */
function changedNow(spec: RowSpec, settings: SettingsValues | null): boolean {
  if (settings === null || isQuiet(spec)) return false
  return !isDefault(spec, (settings as unknown as Record<string, unknown>)[spec.key])
}

/** The end of every row: the control, and Reset while the value is not the default. */
export function Settings(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const [query, setQuery] = useState('')
  const [current, setCurrent] = useState<SectionId>(DEFAULT_SECTION)
  const field = useRef<HTMLInputElement>(null)
  const showDeveloper = settings?.showDeveloperSettings ?? false
  const rail = railSections(showDeveloper, settings as unknown as Record<string, unknown> | null)
  const hits = searchSettings(query, showDeveloper)
  const searching = query.trim() !== ''

  const put = useCallback(
    (patch: Partial<SettingsValues>): void => {
      void save(patch).catch(() => toast('Could not save that. Try again.'))
    },
    [save],
  )

  const resetRow = (spec: RowSpec): void => {
    put({ [spec.key]: defaultOf(spec.key) } as Partial<SettingsValues>)
  }

  const goTo = (id: SectionId): void => {
    setCurrent(id)
    const target = document.getElementById(`set-${id}`)
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  // Another page asked for one section (Connections, Manage folders): open there, once.
  useEffect(() => {
    const asked = takeSettingsSection()
    if (asked === null || !rail.some((section) => section.id === asked)) return undefined
    const id = asked as SectionId
    setCurrent(id)
    const frame = window.requestAnimationFrame(() => document.getElementById(`set-${id}`)?.scrollIntoView({ block: 'start' }))
    return () => window.cancelAnimationFrame(frame)
    // Only when Settings opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Ctrl+F (Cmd+F on a Mac) puts the cursor in the search box, and Escape empties it, the way the field itself says.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        field.current?.focus()
        field.current?.select()
        return
      }
      if (event.key !== 'Escape') return
      if (query !== '') setQuery('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [query])

  // The rail follows the page: the section nearest the top of the sheet is the one marked.
  useEffect(() => {
    const sheet = document.querySelector('.sheet')
    if (sheet === null) return
    const onScroll = (): void => {
      let best: SectionId | null = null
      let bestTop = Number.POSITIVE_INFINITY
      for (const item of rail) {
        const element = document.getElementById(`set-${item.section.id}`)
        if (element === null) continue
        const top = Math.abs(element.getBoundingClientRect().top - 90)
        if (element.getBoundingClientRect().bottom > 120 && top < bestTop) {
          bestTop = top
          best = item.section.id
        }
      }
      if (best !== null) setCurrent(best)
    }
    sheet.addEventListener('scroll', onScroll, { passive: true })
    return () => sheet.removeEventListener('scroll', onScroll)
  }, [rail])

  const openHit = (rowKey: string, hidden: boolean): void => {
    const spec = row(rowKey)
    if (hidden) put({ showDeveloperSettings: true })
    setQuery('')
    // The section is drawn on the next paint once a hidden one is shown, so the scroll waits a moment.
    window.setTimeout(() => goTo(spec.section), 60)
  }

  return (
    <div className="page setg">
      <div className="ph">
        <div>
          <span className="eyebrow">SETTINGS</span>
          <h1 className="h1">Settings</h1>
          <p className="lead">Your account, your agent, this computer and its devices.</p>
        </div>
        <div className="ssrch">
          <Icon name="search" size={18} />
          <input
            ref={field}
            type="search"
            value={query}
            aria-label="Search settings"
            placeholder="Search settings"
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="kbd" aria-hidden="true">
            {searching ? 'Esc' : 'Ctrl F'}
          </span>
        </div>
      </div>

      <div className="settings">
        <SettingsRail sections={rail} current={current} onPick={goTo} />
        <div className="content">
          {searching ? (
            <div className="hits" role="region" aria-label="Search results">
              <div className="hits-h">
                <span className="eyebrow mute">Results</span>
                <span className="n">
                  {hits.length === 0 ? 'Nothing matches' : `${hits.length} ${hits.length === 1 ? 'setting' : 'settings'}`}
                </span>
              </div>
              {hits.length === 0 ? (
                <div className="nores">Nothing in Settings matches that. Try a plainer word, like theme, volume or folders.</div>
              ) : null}
              {hits.map((hit) => (
                <button type="button" className="hit" key={hit.row.key} onClick={() => openHit(hit.row.key, hit.hidden)}>
                  <span className="ri">
                    <Icon name={hit.row.icon} size={18} />
                  </span>
                  <span className="rt">
                    <b>{hit.row.label}</b>
                    <span className="d">{hit.row.description}</span>
                  </span>
                  <span className="where">
                    {hit.section.name}
                    {hit.hidden ? <span className="pill warn">Hidden</span> : null}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          <AccountSection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
          <ConnectionsSection navigate={navigate} />
          <DevicesSection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
          <AgentsSection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
          <VoiceSection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
          <NotifySection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
          <AppearanceSection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
          <PrivacySection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
          {showDeveloper ? (
            <>
              <GitSection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
              <AdvancedSection settings={settings} put={put} resetRow={resetRow} navigate={navigate} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

interface SectionProps {
  settings: SettingsValues | null
  put: (patch: Partial<SettingsValues>) => void
  resetRow: (spec: RowSpec) => void
  navigate: (route: Route) => void
}

/** Account and AI: the two names, who is signed in, the AI accounts and what thinks in the main chat. */
function AccountSection({ settings, put, resetRow, navigate }: SectionProps): JSX.Element {
  const status = useAccountStatus()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<AiAccount | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const signedIn = settings?.signedIn ?? false
  const accounts = settings === null ? [] : accountsOf(settings)
  const syncLine = status.syncing
    ? 'Syncing now'
    : status.error
      ? 'Offline, will sync later'
      : status.lastSyncedAt !== null
        ? `Synced ${timeAgo(status.lastSyncedAt) === 'now' ? 'just now' : timeAgo(status.lastSyncedAt)}`
        : 'Not synced yet'

  const signOut = (): void => {
    void agent.account
      .signOut()
      .then(() => navigate({ page: 'onboarding', step: 'signin' }))
      .catch(() => toast('Could not sign out. Try again.'))
  }

  /** The accounts live outside the settings file; an empty save reads them back in, and a failure is said. */
  const changeAccount = (work: Promise<unknown>, failed: string): void => {
    void work.then(() => put({})).catch(() => toast(failed))
  }

  return (
    <SectionBlock id="account" name="Account and AI" line="Who you are, who your agent is, and what it thinks with.">
      <SettingRow spec={row('userName')} changed={changedNow(row('userName'), settings)} onReset={() => resetRow(row('userName'))}>
        <TextControl
          label="Your name"
          value={settings?.userName ?? ''}
          placeholder="Your name"
          onCommit={(value) => put({ userName: value })}
        />
      </SettingRow>
      <SettingRow spec={row('agentName')} changed={changedNow(row('agentName'), settings)} onReset={() => resetRow(row('agentName'))}>
        <TextControl
          label="Your agent's name"
          value={settings?.agentName ?? ''}
          placeholder="Your agent's name"
          onCommit={(value) => put({ agentName: value })}
        />
      </SettingRow>
      <div className="divider" />
      <SettingRow
        spec={
          signedIn
            ? {
                ...row('syncEmail'),
                label: settings?.syncEmail || 'Signed in',
                description: `Signed in on this computer. ${syncLine}. Keys never sync.`,
              }
            : { ...row('syncEmail'), label: 'No account', description: 'Sign in to sync with your other devices. Keys never sync.' }
        }
        icon={{ name: 'mail', tone: signedIn ? 'ok' : undefined }}
      >
        {signedIn ? (
          <Button
            variant="text"
            size="sm"
            disabled={syncing || status.syncing}
            onClick={() => {
              setSyncing(true)
              void agent.account
                .syncNow()
                .catch(() => toast('Could not sync just now. It will try again by itself.'))
                .finally(() => setSyncing(false))
            }}
          >
            {syncing || status.syncing ? 'Syncing...' : 'Sync now'}
          </Button>
        ) : null}
        <Button variant="tonal" size="sm" onClick={signedIn ? signOut : () => navigate({ page: 'onboarding', step: 'signin' })}>
          {signedIn ? 'Sign out' : 'Sign in'}
        </Button>
      </SettingRow>
      <div className="divider" />
      <SettingRow spec={row('accounts')}>
        <Button variant="tonal" size="sm" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} />
          Add an account
        </Button>
      </SettingRow>
      {accounts.length === 0 ? (
        <div className="rowempty">No AI account yet. Add your plan or a key, and your agent can think.</div>
      ) : null}
      {accounts.map((account) => (
        <SettingRow
          key={account.id}
          spec={{ ...row('accounts'), label: account.label, description: kindLine(account) }}
          sub
          below={
            <>
              <span className="lbl">Pictures</span>
              <Segmented
                ariaLabel={`Pictures on ${account.label}`}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'on', label: 'Always' },
                  { value: 'off', label: 'Never' },
                ]}
                value={account.pictures ?? 'auto'}
                onChange={(next) => changeAccount(agent.settings.accounts.update(account.id, { pictures: next }), 'Could not change that. Try again.')}
              />
            </>
          }
        >
          <Pill tone={account.kind === 'api' ? (account.hasKey ? 'ok' : 'mute') : 'ok'}>
            {account.kind === 'api' ? (account.hasKey ? 'Key saved' : 'No key') : 'Plan'}
          </Pill>
          <Button variant="text" size="sm" onClick={() => setEditing(account)}>
            Change
          </Button>
          {removing === account.id ? (
            <>
              <Button
                variant="text"
                size="sm"
                className="danger"
                onClick={() => {
                  setRemoving(null)
                  changeAccount(agent.settings.accounts.remove(account.id), `Could not remove ${account.label}. Try again.`)
                }}
              >
                Remove it
              </Button>
              <Button variant="text" size="sm" onClick={() => setRemoving(null)}>
                Keep
              </Button>
            </>
          ) : (
            <Button variant="text" size="sm" onClick={() => setRemoving(account.id)}>
              Remove
            </Button>
          )}
        </SettingRow>
      ))}
      <div className="divider" />
      <SettingRow spec={row('ai')} />
      {settings === null ? null : (
        <div className="pickwrap">
          <AiPickRows settings={settings} picks={settings.ai} onChange={(ai: AiPicks) => put({ ai })} />
        </div>
      )}
      {adding ? <AccountDialog onClose={() => setAdding(false)} /> : null}
      {editing !== null ? <AccountDialog account={editing} onClose={() => setEditing(null)} /> : null}
    </SectionBlock>
  )
}

/** Profiles and connections: the two places a person looks for their accounts. Each row opens the page that owns it. */
function ConnectionsSection({ navigate }: { navigate: SectionProps['navigate'] }): JSX.Element {
  return (
    <SectionBlock id="profiles" name="Profiles and connections" line="Where your accounts live. They are kept on the Connections page.">
      <SettingRow
        spec={{
          key: 'profiles.connected',
          section: 'profiles',
          label: 'Connected apps and profiles',
          description:
            'Mail, calendar, Slack and the rest, the profile each one belongs to, and the sites your browser is signed in to. Profiles are picked and changed there, next to the accounts they use.',
          control: 'block',
          icon: 'grid',
          sample: null,
        }}
      >
        <Button variant="tonal" size="sm" onClick={() => navigate({ page: 'connections' })}>
          Open Connections
        </Button>
      </SettingRow>
    </SectionBlock>
  )
}

/** The groups of this computer's tools another device may be given first (protocol s11). */
const SHARE_GROUPS: Array<[string, string]> = [
  ['browser', 'The browser'],
  ['files', 'Files'],
  ['notifications', 'Notifications'],
  ['approval', 'Questions and approvals'],
  ['shell', 'Commands'],
]

/** Which of the person's devices is used first for each shared tool. Empty means any device that is free. */
function PreferredDevices({ settings, put }: { settings: SettingsValues | null; put: SectionProps['put'] }): JSX.Element {
  // The shared read (state/useDevices): no fetch of its own, and it follows the devices changed event.
  const { status, rows, error } = useDevicesData()
  const self = status === null ? '' : status.viewer || status.nodeId
  const devices = rows.filter((item) => !item.revoked && item.id !== self).map((item) => ({ id: item.id, name: item.name }))
  const preferred = settings?.devicesPreferred ?? {}
  return (
    <>
      <SettingRow spec={row('devicesPreferred')}>
        {error !== '' ? (
          <>
            <span className="small dv-error-line" role="alert">
              Could not read your devices.
            </span>
            <Button variant="text" size="sm" onClick={refreshDevicesSummary}>
              Retry
            </Button>
          </>
        ) : (
          <span className="small muted">
            {status === null ? 'Looking...' : devices.length === 0 ? 'No other device yet' : 'Any device means the first one that is free'}
          </span>
        )}
      </SettingRow>
      {SHARE_GROUPS.map(([group, label]) => (
        <SettingRow key={group} spec={{ ...row('devicesPreferred'), label, description: '' }} sub>
          <SelectControl
            label={`Preferred device for ${label.toLowerCase()}`}
            value={preferred[group] ?? ''}
            options={[{ value: '', label: 'Any device' }, ...devices.map((device) => ({ value: device.id, label: device.name }))]}
            onChange={(value) => put({ devicesPreferred: { ...preferred, [group]: value } })}
          />
        </SettingRow>
      ))}
    </>
  )
}

/** Devices: this computer's name, what may connect, the devices themselves, and what they may use here. */
function DevicesSection({ settings, put, resetRow }: SectionProps): JSX.Element {
  return (
    <SectionBlock id="devices" name="Devices" line="Your phone and other computers, one agent.">
      <SettingRow spec={row('deviceName')}>
        <TextControl
          label="This computer's name"
          value={settings?.deviceName ?? ''}
          placeholder="This computer"
          onCommit={(value) => put({ deviceName: value })}
        />
      </SettingRow>
      <div className="dv-embed">
        <DevicesSettings />
      </div>
      <div className="divider" />
      <PreferredDevices settings={settings} put={put} />
      <SettingRow
        spec={row('devicesJobLimit')}
        changed={changedNow(row('devicesJobLimit'), settings)}
        onReset={() => resetRow(row('devicesJobLimit'))}
      >
        <SelectControl
          label="Work for your other devices"
          value={String(settings?.devicesJobLimit ?? 0)}
          options={[
            { value: '0', label: 'No limit' },
            { value: '4', label: '4 at once' },
            { value: '8', label: '8 at once' },
            { value: '16', label: '16 at once' },
          ]}
          onChange={(value) => put({ devicesJobLimit: Number(value) })}
        />
      </SettingRow>
    </SectionBlock>
  )
}

/** Where a helper runs: here, or on a linked server when it is free. */
function RunHelpersOn({ settings, put, resetRow }: SectionProps): JSX.Element {
  const { status, rows } = useDevicesData()
  // This computer is in its own device list, and it is already the 'This computer' choice.
  const self = status === null ? '' : status.viewer || status.nodeId
  const brains = rows
    .filter((item) => !item.revoked && item.id !== self && item.roles.includes('brain'))
    .map((item) => ({ id: item.id, name: item.name }))
  const value = settings?.helpersRunOn ?? 'best'
  const options = [
    { value: 'best', label: 'Best' },
    { value: 'here', label: 'This computer' },
    ...brains.map((device) => ({ value: device.id, label: device.name })),
  ]
  return (
    <SettingRow
      spec={row('helpersRunOn')}
      changed={changedNow(row('helpersRunOn'), settings)}
      onReset={() => resetRow(row('helpersRunOn'))}
      stack={options.length > 2}
    >
      <Segmented ariaLabel="Run helpers on" options={options} value={value} onChange={(next) => put({ helpersRunOn: next })} />
    </SettingRow>
  )
}

/** Agents and helpers: what helpers think with, how much runs at once, and whether the app keeps running. */
function AgentsSection({ settings, put, resetRow }: SectionProps): JSX.Element {
  const limit = (key: string, label: string, off: string, decimal = false, unit?: string): JSX.Element => {
    const spec = row(key)
    return (
      <SettingRow spec={spec} changed={changedNow(spec, settings)} onReset={() => resetRow(spec)}>
        <NumberControl
          label={label}
          value={Number((settings as unknown as Record<string, unknown> | null)?.[key] ?? 0)}
          off={off}
          decimal={decimal}
          unit={unit}
          onCommit={(next) => put({ [key]: next } as Partial<SettingsValues>)}
        />
      </SettingRow>
    )
  }

  const quiet = String(settings?.helperQuietMinutes ?? 0)
  return (
    <SectionBlock
      id="agents"
      name="Agents and helpers"
      line="What helpers think with, how many work at once, and whether the app keeps running."
      extra={<PromptRulesSettings />}
    >
      {limit('helpersAtOnce', 'Helpers at once', 'No limit')}
      {limit('helperMaxSteps', 'Steps per helper', 'No limit')}
      {limit('routinesAtOnce', 'Routines at once', 'No limit')}
      <SettingRow
        spec={row('helperQuietMinutes')}
        changed={changedNow(row('helperQuietMinutes'), settings)}
        onReset={() => resetRow(row('helperQuietMinutes'))}
      >
        <SelectControl
          label="Heads-up on a quiet helper"
          value={quiet}
          options={[
            { value: '0', label: 'Never' },
            { value: '5', label: '5 minutes' },
            { value: '10', label: '10 minutes' },
            { value: '15', label: '15 minutes' },
            { value: '30', label: '30 minutes' },
            { value: '60', label: '60 minutes' },
          ]}
          onChange={(value) => put({ helperQuietMinutes: Number(value) })}
        />
      </SettingRow>
      {limit('helperMinFreeRamGb', 'Pause helpers when memory is low, GB', 'No check', true, 'GB')}
      {limit('helperMinFreeDiskGb', 'Pause helpers when disk is low, GB', 'No check', true, 'GB')}
      {limit('helperBusyCpu', 'Busy processor use, percent', 'Off', false, '%')}
      <RunHelpersOn settings={settings} put={put} resetRow={resetRow} navigate={() => undefined} />
      <SettingRow spec={row('launchAtLogin')} changed={changedNow(row('launchAtLogin'), settings)} onReset={() => resetRow(row('launchAtLogin'))}>
        <Switch on={settings?.launchAtLogin ?? false} label="Start when I sign in" onToggle={(next) => put({ launchAtLogin: next })} />
      </SettingRow>
      <SettingRow spec={row('closeToTray')} changed={changedNow(row('closeToTray'), settings)} onReset={() => resetRow(row('closeToTray'))}>
        <Switch on={settings?.closeToTray ?? true} label="Keep running in the tray" onToggle={(next) => put({ closeToTray: next })} />
      </SettingRow>
      <SettingRow spec={row('dailyMemoryAt')} changed={changedNow(row('dailyMemoryAt'), settings)} onReset={() => resetRow(row('dailyMemoryAt'))}>
        <TimeControl label="End of day memory pass" value={settings?.dailyMemoryAt ?? ''} onCommit={(value) => put({ dailyMemoryAt: value })} />
        <Button variant="text" size="sm" onClick={() => useUi.getState().navigate({ page: 'routines' })}>
          Routines
        </Button>
      </SettingRow>
    </SectionBlock>
  )
}

/** The Gemini key, in its own dialog: pasted once, stored by the operating system, never shown again. */
function VoiceKeyDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const hasKey = useSettings((state) => state.settings?.hasVoiceKey ?? false)

  const store = (): void => {
    const value = draft.trim()
    if (value === '') return
    setBusy(true)
    void agent.voice
      .setKey(value)
      .then(() => agent.voice.check())
      .then((result) => {
        setStatus(result)
        setDraft('')
      })
      .catch(() => setStatus({ ok: false, message: 'Could not store the key.' }))
      .finally(() => setBusy(false))
  }

  return (
    <Dialog label="Voice key" onClose={onClose}>
      <div>
        <span className="eyebrow">VOICE</span>
        <h2 className="h2" style={{ marginTop: 6 }}>
          {hasKey ? 'Replace the Gemini key' : 'Add a Gemini key'}
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          Voice runs on Google Gemini. A free key from Google AI Studio works. It is stored by your operating system
          and never shown in this window.
        </p>
      </div>
      <Field
        label="Gemini key"
        type="password"
        revealable
        revealLabel="key"
        autoComplete="off"
        value={draft}
        onChange={setDraft}
        placeholder="Starts with AIza"
        onEnter={store}
      />
      {status !== null ? (
        <p className="small" role="status" style={{ color: status.ok ? 'var(--ok)' : 'var(--err)' }}>
          {status.message}
        </p>
      ) : null}
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Close
        </Button>
        <Button disabled={busy || draft.trim() === ''} onClick={store}>
          {busy ? 'Checking...' : 'Save key'}
        </Button>
      </div>
    </Dialog>
  )
}

/** Voice and dictation: the key, the voice, the voice note, and the two shortcuts. */
function VoiceSection({ settings, put, resetRow }: SectionProps): JSX.Element {
  const [keyOpen, setKeyOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const sampling = useSpeaker((state) => state.speaking === 'voice-sample' || state.loading === 'voice-sample')
  const hasKey = settings?.hasVoiceKey ?? false
  const voice = settings?.voiceName || 'Kore'

  const check = (): void => {
    setChecking(true)
    void agent.voice
      .check()
      .then((result) => toast(result.message))
      .catch(() => toast('Could not reach Gemini.'))
      .finally(() => setChecking(false))
  }

  return (
    <SectionBlock id="voice" name="Voice and dictation" line="Talk to your agent, dictate anywhere, and hear replies.">
      <SettingRow spec={row('hasVoiceKey')} icon={{ name: 'key', tone: hasKey ? 'ok' : undefined }}>
        <Pill tone={hasKey ? 'ok' : 'mute'}>{hasKey ? 'Key stored' : 'No key'}</Pill>
        <Button variant="tonal" size="sm" onClick={() => setKeyOpen(true)}>
          {hasKey ? 'Replace' : 'Add a key'}
        </Button>
        {hasKey ? (
          <Button variant="text" size="sm" disabled={checking} onClick={check}>
            {checking ? 'Checking...' : 'Check'}
          </Button>
        ) : null}
      </SettingRow>
      <SettingRow spec={row('voiceName')} changed={changedNow(row('voiceName'), settings)} onReset={() => resetRow(row('voiceName'))}>
        <SelectControl
          label="Voice"
          value={voice}
          options={VOICES.map((option) => ({ value: option.id, label: `${option.id}, ${option.feel}` }))}
          onChange={(value) => put({ voiceName: value })}
        />
        <Button
          variant="tonal"
          size="sm"
          disabled={!hasKey}
          title={hasKey ? 'Hear this voice' : 'Add a Gemini key first'}
          onClick={() => {
            if (sampling) stopSpeaking()
            else void speakText('voice-sample', 'Hi. This is how I sound on a call and when I read your replies.')
          }}
        >
          {sampling ? 'Stop' : 'Hear it'}
        </Button>
      </SettingRow>
      <SettingRow spec={row('speakReplies')} changed={changedNow(row('speakReplies'), settings)} onReset={() => resetRow(row('speakReplies'))}>
        <Switch
          on={settings?.speakReplies ?? false}
          disabled={!hasKey}
          label="Voice note with every reply"
          onToggle={(next) => put({ speakReplies: next })}
        />
      </SettingRow>
      <SettingRow spec={row('dictateHotkey')} changed={changedNow(row('dictateHotkey'), settings)} onReset={() => resetRow(row('dictateHotkey'))}>
        <HotkeyControl label="Dictation shortcut" value={settings?.dictateHotkey ?? ''} onSave={(next) => put({ dictateHotkey: next })} />
      </SettingRow>
      <SettingRow
        spec={row('dictateCleanHotkey')}
        changed={changedNow(row('dictateCleanHotkey'), settings)}
        onReset={() => resetRow(row('dictateCleanHotkey'))}
      >
        <HotkeyControl
          label="Clean-up dictation shortcut"
          value={settings?.dictateCleanHotkey ?? ''}
          onSave={(next) => put({ dictateCleanHotkey: next })}
        />
      </SettingRow>
      {keyOpen ? <VoiceKeyDialog onClose={() => setKeyOpen(false)} /> : null}
    </SectionBlock>
  )
}

/** The quiet hours presets, and whatever else the file already holds. */
const QUIET_PRESETS = ['', '22:00-07:00', '23:00-06:00', '21:00-06:00', '00:00-07:00']

function quietLabel(value: string): string {
  if (value === '') return 'Off'
  const [from, to] = value.split('-')
  return `${from} to ${to}`
}

/** Notifications and wake-ups: when something needs you now, and how loud it is. */
function NotifySection({ settings, put, resetRow }: SectionProps): JSX.Element {
  const [where, setWhere] = useState<'here' | 'all'>('here')
  const quiet = settings?.wakeupQuietHours ?? ''
  const paused = settings?.wakeupsPauseHereUntil ?? ''
  const presets = QUIET_PRESETS.includes(quiet) ? QUIET_PRESETS : [...QUIET_PRESETS, quiet]

  const test = (severity: 'critical' | 'urgent' | 'heads_up'): void => {
    void agent.wakeups
      .test(severity, where)
      .then(() => toast(`Test sent ${where === 'here' ? 'on this computer' : 'on every device'}.`))
      .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'The test did not ring.'))
  }

  return (
    <SectionBlock
      id="notify"
      name="Notifications and wake-ups"
      line="When something needs you now, your devices ring until you answer."
      extra={<WakeLog />}
    >
      <SettingRow spec={row('notifications')} changed={changedNow(row('notifications'), settings)} onReset={() => resetRow(row('notifications'))}>
        <Switch on={settings?.notifications ?? true} label="Desktop notifications" onToggle={(next) => put({ notifications: next })} />
      </SettingRow>
      <SettingRow
        spec={row('wakeupsRingHere')}
        changed={changedNow(row('wakeupsRingHere'), settings)}
        onReset={() => resetRow(row('wakeupsRingHere'))}
      >
        <Switch on={settings?.wakeupsRingHere ?? true} label="Ring on this computer" onToggle={(next) => put({ wakeupsRingHere: next })} />
      </SettingRow>
      <SettingRow
        spec={row('wakeupsPauseHereUntil')}
        changed={changedNow(row('wakeupsPauseHereUntil'), settings)}
        onReset={() => resetRow(row('wakeupsPauseHereUntil'))}
      >
        <DateTimeControl label="Pause ringing on this computer" value={paused} onCommit={(value) => put({ wakeupsPauseHereUntil: value })} />
        {paused === '' ? null : (
          <Button variant="text" size="sm" onClick={() => put({ wakeupsPauseHereUntil: '' })}>
            Resume
          </Button>
        )}
      </SettingRow>
      <SettingRow
        spec={row('wakeupsPhoneOnlyWhenIdle')}
        changed={changedNow(row('wakeupsPhoneOnlyWhenIdle'), settings)}
        onReset={() => resetRow(row('wakeupsPhoneOnlyWhenIdle'))}
      >
        <Switch
          on={settings?.wakeupsPhoneOnlyWhenIdle ?? true}
          label="Only the phone when this computer is idle or locked"
          onToggle={(next) => put({ wakeupsPhoneOnlyWhenIdle: next })}
        />
      </SettingRow>
      <SettingRow
        spec={row('wakeupsIdleMinutes')}
        changed={changedNow(row('wakeupsIdleMinutes'), settings)}
        onReset={() => resetRow(row('wakeupsIdleMinutes'))}
      >
        <SelectControl
          label="Idle after"
          value={String(settings?.wakeupsIdleMinutes ?? 5)}
          options={[1, 2, 5, 10, 15, 30, 60].map((minutes) => ({ value: String(minutes), label: `${minutes} minutes` }))}
          onChange={(value) => put({ wakeupsIdleMinutes: Number(value) })}
        />
      </SettingRow>
      <SettingRow
        spec={row('wakeupSnoozeMinutes')}
        changed={changedNow(row('wakeupSnoozeMinutes'), settings)}
        onReset={() => resetRow(row('wakeupSnoozeMinutes'))}
      >
        <SelectControl
          label="Snooze"
          value={String(settings?.wakeupSnoozeMinutes ?? 5)}
          options={[1, 2, 5, 10, 15, 30].map((minutes) => ({ value: String(minutes), label: `${minutes} minutes` }))}
          onChange={(value) => put({ wakeupSnoozeMinutes: Number(value) })}
        />
      </SettingRow>
      <SettingRow
        spec={row('wakeupQuietHours')}
        changed={changedNow(row('wakeupQuietHours'), settings)}
        onReset={() => resetRow(row('wakeupQuietHours'))}
      >
        <SelectControl
          label="Quiet hours"
          value={quiet}
          options={presets.map((value) => ({ value, label: quietLabel(value) }))}
          onChange={(value) => put({ wakeupQuietHours: value })}
        />
      </SettingRow>
      <SettingRow spec={row('wakeupVolume')} changed={changedNow(row('wakeupVolume'), settings)} onReset={() => resetRow(row('wakeupVolume'))}>
        <SliderControl label="Alarm volume" value={settings?.wakeupVolume ?? 1} onChange={(value) => put({ wakeupVolume: value })} />
      </SettingRow>
      <div className="divider" />
      <SettingRow
        spec={{
          key: 'wakeups.test',
          section: 'notify',
          label: 'Test a wake-up',
          description: 'Rings for real, at the severity you pick, so you know what it sounds like.',
          control: 'block',
          icon: 'bell',
          sample: null,
        }}
        stack
      >
        <Segmented
          ariaLabel="Where the test rings"
          value={where}
          onChange={setWhere}
          options={[
            { value: 'here', label: 'This computer' },
            { value: 'all', label: 'Every device' },
          ]}
        />
        <Button variant="tonal" size="sm" onClick={() => test('critical')}>
          Critical
        </Button>
        <Button variant="tonal" size="sm" onClick={() => test('urgent')}>
          Urgent
        </Button>
        <Button variant="tonal" size="sm" onClick={() => test('heads_up')}>
          Heads-up
        </Button>
      </SettingRow>
    </SectionBlock>
  )
}

/** Appearance: the theme, the accent, the sidekick and how many pinned apps the sidebar keeps. */
function AppearanceSection({ settings, put, resetRow }: SectionProps): JSX.Element {
  const accent = settings?.accent ?? 'iris'
  const mascot = settings?.mascot ?? 'scout'
  return (
    <SectionBlock id="appearance" name="Appearance" line="Light, dark or the same as your computer, your colour, your sidekick.">
      <SettingRow spec={row('theme')} changed={changedNow(row('theme'), settings)} onReset={() => resetRow(row('theme'))}>
        <Segmented
          ariaLabel="Theme"
          value={settings?.theme ?? 'system'}
          onChange={(value) => put({ theme: value as SettingsValues['theme'] })}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
        />
      </SettingRow>
      <SettingRow spec={row('accent')} changed={changedNow(row('accent'), settings)} onReset={() => resetRow(row('accent'))} stack>
        <div className="swatches" role="radiogroup" aria-label="Your colour">
          {ACCENTS.map((item) => {
            const on = item.id === accent
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={item.label}
                className={`sw${on ? ' on' : ''}`}
                style={{ background: item.swatch }}
                onClick={() => {
                  applyAccent(item.id)
                  put({ accent: item.id })
                }}
              >
                {on ? <Icon name="check" size={18} /> : null}
              </button>
            )
          })}
        </div>
      </SettingRow>
      <SettingRow spec={row('mascot')} changed={changedNow(row('mascot'), settings)} onReset={() => resetRow(row('mascot'))} stack>
        <div className="mascots" role="radiogroup" aria-label="Your sidekick">
          {MASCOT_ORDER.map((id) => {
            const on = id === mascot
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={MASCOTS[id].label}
                className={`mk${on ? ' on' : ''}`}
                onClick={() => put({ mascot: id })}
              >
                <Mascot id={id} size={34} />
              </button>
            )
          })}
        </div>
      </SettingRow>
      <SettingRow
        spec={row('miniappPinCap')}
        changed={changedNow(row('miniappPinCap'), settings)}
        onReset={() => resetRow(row('miniappPinCap'))}
      >
        <SelectControl
          label="Pinned apps in the sidebar"
          value={String(settings?.miniappPinCap ?? 8)}
          options={[4, 6, 8, 12, 16, 20].map((count) => ({ value: String(count), label: `${count} apps` }))}
          onChange={(value) => put({ miniappPinCap: Number(value) })}
        />
      </SettingRow>
    </SectionBlock>
  )
}

/** The three things that cannot be undone, each in the app's own dialog, saying exactly what goes. */
function DangerZone({ navigate }: { navigate: SectionProps['navigate'] }): JSX.Element {
  const [which, setWhich] = useState<'settings' | 'data' | 'signout' | null>(null)
  const folders = useSettings((state) => state.settings?.grantedFolders ?? [])
  const accounts = useSettings((state) => (state.settings === null ? 0 : accountsOf(state.settings).length))
  return (
    <div className="danger-card">
      <div className="ssec-h">
        <span className="eyebrow">Danger zone</span>
        <span className="line">These cannot be undone. Each one asks first, and says exactly what goes.</span>
      </div>
      <div className="srow">
        <div className="ri">
          <Icon name="sync" size={22} />
        </div>
        <div className="rt">
          <b>Reset settings only</b>
          <span className="d">Every setting on this computer goes back to its default. Chats, memory, keys and files stay.</span>
        </div>
        <div className="end">
          <button type="button" className="btn-danger" onClick={() => setWhich('settings')}>
            Reset settings
          </button>
        </div>
      </div>
      <div className="srow">
        <div className="ri">
          <Icon name="trash" size={22} />
        </div>
        <div className="rt">
          <b>Delete everything on this computer</b>
          <span className="d">Chats, memory, to-dos, routines, wake-ups, mini-apps, keys and settings. Your account keeps its copy.</span>
        </div>
        <div className="end">
          <button type="button" className="btn-danger" onClick={() => setWhich('data')}>
            Delete local data
          </button>
        </div>
      </div>
      <div className="srow">
        <div className="ri">
          <Icon name="x" size={22} />
        </div>
        <div className="rt">
          <b>Sign out</b>
          <span className="d">Stops syncing on this computer and asks you to sign in again. It deletes nothing.</span>
        </div>
        <div className="end">
          <button type="button" className="btn-danger" onClick={() => setWhich('signout')}>
            Sign out
          </button>
        </div>
      </div>

      {which === 'settings' ? (
        <Dialog label="Reset settings" onClose={() => setWhich(null)}>
          <div>
            <span className="eyebrow">DANGER ZONE</span>
            <h2 className="h2" style={{ marginTop: 6 }}>
              Put every setting back to its default?
            </h2>
            <p className="lead" style={{ marginTop: 8 }}>
              Every setting on this computer goes back to its default: your name, your agent&apos;s name, {accounts}{' '}
              {accounts === 1 ? 'AI account' : 'AI accounts'} and their keys, the theme, the shortcuts, the wake-ups,
              the {folders.length} {folders.length === 1 ? 'folder' : 'folders'} you allowed and the device settings.
            </p>
            <p className="lead" style={{ marginTop: 8 }}>
              Chats, memory, to-dos, routines and files are not touched, and your account keeps its copy.
            </p>
          </div>
          <div className="dialog-actions">
            <Button variant="text" onClick={() => setWhich(null)}>
              Cancel
            </Button>
            <Button
              variant="line"
              style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
              onClick={() => {
                void agent.settings
                  .resetSettings()
                  .then(() => {
                    toast('Every setting is back to its default.')
                    setWhich(null)
                  })
                  .catch(() => toast('Could not reset the settings.'))
              }}
            >
              Reset every setting
            </Button>
          </div>
        </Dialog>
      ) : null}

      {which === 'data' ? (
        <Dialog label="Delete local data" onClose={() => setWhich(null)}>
          <div>
            <span className="eyebrow">DANGER ZONE</span>
            <h2 className="h2" style={{ marginTop: 6 }}>
              Delete everything on this computer?
            </h2>
            <p className="lead" style={{ marginTop: 8 }}>
              This deletes keys, memory, to-dos, routines, wake-ups, mini-apps, chats and settings from this computer
              only, then asks you to set it up again. Your account keeps its copy on the server.
            </p>
          </div>
          <div className="dialog-actions">
            <Button variant="text" onClick={() => setWhich(null)}>
              Cancel
            </Button>
            <Button
              variant="line"
              style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
              onClick={() => {
                void agent.settings
                  .reset()
                  .then(() => navigate({ page: 'onboarding', step: 'signin' }))
                  .catch(() => toast('Could not delete the local data.'))
              }}
            >
              Delete it all
            </Button>
          </div>
        </Dialog>
      ) : null}

      {which === 'signout' ? (
        <Dialog label="Sign out" onClose={() => setWhich(null)}>
          <div>
            <span className="eyebrow">ACCOUNT</span>
            <h2 className="h2" style={{ marginTop: 6 }}>
              Sign out of this computer?
            </h2>
            <p className="lead" style={{ marginTop: 8 }}>
              Nothing is deleted. This computer stops syncing, keeps everything it already has here, and asks you to
              sign in the next time it needs the server.
            </p>
          </div>
          <div className="dialog-actions">
            <Button variant="text" onClick={() => setWhich(null)}>
              Cancel
            </Button>
            <Button
              variant="line"
              style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
              onClick={() => {
                void agent.account
                  .signOut()
                  .then(() => {
                    setWhich(null)
                    navigate({ page: 'onboarding', step: 'signin' })
                  })
                  .catch(() => toast('Could not sign out. Try again.'))
              }}
            >
              Sign out
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  )
}

/** Privacy and data: folders, commands, recordings, the developer switch, the Vault and the danger zone. */
function PrivacySection({ settings, put, resetRow, navigate }: SectionProps): JSX.Element {
  const [pickingFolder, setPickingFolder] = useState(false)
  const folders = settings?.grantedFolders ?? []

  const addFolder = (): void => {
    if (pickingFolder) return
    setPickingFolder(true)
    void agent.files
      .pickFolder()
      .then((folder) => {
        if (folder === null) return
        if (!folders.includes(folder)) put({ grantedFolders: [...folders, folder] })
      })
      .catch(() => toast('Could not open the folder picker. Try again.'))
      .finally(() => setPickingFolder(false))
  }

  return (
    <SectionBlock
      id="privacy"
      name="Privacy and data"
      line="What your agent may touch on this computer, and what is kept."
      extra={
        <>
          <div className="embed">
            <VaultSettings />
          </div>
          <DangerZone navigate={navigate} />
        </>
      }
    >
      <SettingRow spec={row('grantedFolders')}>
        <Button variant="tonal" size="sm" disabled={pickingFolder} onClick={addFolder}>
          {pickingFolder ? 'Choosing...' : 'Add folder'}
        </Button>
      </SettingRow>
      {folders.length === 0 ? <div className="rowempty">No folder yet. Your agent asks before it touches any file.</div> : null}
      {folders.map((folder) => (
        <SettingRow key={folder} spec={{ ...row('grantedFolders'), label: folderName(folder), description: folder }} sub>
          <IconButton
            icon="trash"
            size={18}
            label={`Remove ${folder}`}
            onClick={() => put({ grantedFolders: folders.filter((item) => item !== folder) })}
          />
        </SettingRow>
      ))}
      <div className="divider" />
      <SettingRow spec={row('shell')} changed={changedNow(row('shell'), settings)} onReset={() => resetRow(row('shell'))}>
        <Segmented
          ariaLabel="Commands and code"
          value={settings?.shell ?? 'ask'}
          onChange={(value) => put({ shell: value as SettingsValues['shell'] })}
          options={[
            { value: 'always', label: 'Run without asking' },
            { value: 'ask', label: 'Ask first' },
            { value: 'never', label: 'Never' },
          ]}
        />
      </SettingRow>
      <SettingRow
        spec={row('recordingAudioKeep')}
        changed={changedNow(row('recordingAudioKeep'), settings)}
        onReset={() => resetRow(row('recordingAudioKeep'))}
      >
        <SelectControl
          label="Keep recording audio"
          value={settings?.recordingAudioKeep ?? 'today'}
          options={[
            { value: 'today', label: 'Until the end of today' },
            { value: 'week', label: 'A week' },
            { value: 'always', label: 'Always' },
          ]}
          onChange={(value) => put({ recordingAudioKeep: value as SettingsValues['recordingAudioKeep'] })}
        />
      </SettingRow>
      <div className="divider" />
      <SettingRow
        spec={row('showDeveloperSettings')}
        changed={changedNow(row('showDeveloperSettings'), settings)}
        onReset={() => resetRow(row('showDeveloperSettings'))}
      >
        <Switch
          on={settings?.showDeveloperSettings ?? false}
          label="Developer settings"
          onToggle={(next) => put({ showDeveloperSettings: next })}
        />
      </SettingRow>
      <div className="divider" />
      <SettingRow
        spec={{
          key: 'memory.open',
          section: 'privacy',
          label: 'Memory',
          description: 'What your agent remembers about you, and every version of it.',
          control: 'block',
          icon: 'memory',
          sample: null,
        }}
      >
        <Button variant="tonal" size="sm" onClick={() => navigate({ page: 'memory' })}>
          Open Memory
        </Button>
      </SettingRow>
    </SectionBlock>
  )
}

/** Git and developer: what is committed and pushed after a run, and what is waiting in the project folders. */
function GitSection({ settings, put, resetRow }: SectionProps): JSX.Element {
  const [log, setLog] = useState<GitLogEntry[]>([])
  const [checking, setChecking] = useState(false)
  const [logError, setLogError] = useState(false)
  const readLog = useRef<() => void>(() => undefined)
  const SIZES = [1, 2, 5, 10, 25, 50, 100]
  const size = settings?.gitMaxFileMb ?? 5

  // Read when the section opens, when it scrolls into view and when the window comes back to the front: a run
  // commits while the person is elsewhere, so those are the moments the list can have changed. No timer.
  useEffect(() => {
    let live = true
    let inView = false
    const read = (): void => {
      void agent.git
        .log()
        .then((list) => {
          if (!live) return
          setLog(list)
          setLogError(false)
        })
        .catch(() => live && setLogError(true))
    }
    readLog.current = read
    read()
    const onFocus = (): void => {
      if (inView) read()
    }
    window.addEventListener('focus', onFocus)
    const section = document.getElementById('set-git')
    const watcher =
      section === null || typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver((entries) => {
            const now = entries.some((entry) => entry.isIntersecting)
            if (now && !inView) read()
            inView = now
          })
    if (watcher !== null && section !== null) watcher.observe(section)
    return () => {
      live = false
      window.removeEventListener('focus', onFocus)
      watcher?.disconnect()
    }
  }, [])

  const check = (): void => {
    setChecking(true)
    void agent.git
      .report()
      .then((list) => {
        const pending = list.filter((item) => waiting(item) !== '')
        toast(
          pending.length === 0
            ? 'Every project folder is committed and pushed.'
            : `${pending.length} ${pending.length === 1 ? 'folder needs' : 'folders need'} attention: ${pending
                .map((item) => `${item.root.split(/[\\/]/).filter((part) => part !== '').pop() ?? item.root} (${waiting(item)})`)
                .join(', ')}`,
        )
      })
      .catch(() => toast('Could not read the project folders.'))
      .finally(() => {
        setChecking(false)
        readLog.current()
      })
  }

  return (
    <SectionBlock id="git" name="Git and developer" line="What is committed and pushed after a run.">
      <SettingRow spec={row('gitAutoCommit')} changed={changedNow(row('gitAutoCommit'), settings)} onReset={() => resetRow(row('gitAutoCommit'))}>
        <Switch on={settings?.gitAutoCommit === true} label="Commit after each run" onToggle={(next) => put({ gitAutoCommit: next })} />
      </SettingRow>
      <SettingRow spec={row('gitAutoPush')} changed={changedNow(row('gitAutoPush'), settings)} onReset={() => resetRow(row('gitAutoPush'))}>
        <Switch on={settings?.gitAutoPush !== false} label="Push after the commit" onToggle={(next) => put({ gitAutoPush: next })} />
      </SettingRow>
      <SettingRow spec={row('gitMaxFileMb')} changed={changedNow(row('gitMaxFileMb'), settings)} onReset={() => resetRow(row('gitMaxFileMb'))}>
        <SelectControl
          label="Biggest file"
          value={String(size)}
          options={(SIZES.includes(size) ? SIZES : [...SIZES, size]).map((mb) => ({ value: String(mb), label: `${mb} MB` }))}
          onChange={(value) => put({ gitMaxFileMb: Number(value) })}
        />
      </SettingRow>
      <SettingRow spec={row('gitExclude')} changed={changedNow(row('gitExclude'), settings)} onReset={() => resetRow(row('gitExclude'))}>
        <TextControl
          label="Also leave out"
          value={settings?.gitExclude ?? ''}
          placeholder="Nothing more"
          width={220}
          onCommit={(value) => put({ gitExclude: value })}
        />
      </SettingRow>
      <div className="divider" />
      <SettingRow
        spec={{
          key: 'git.report',
          section: 'git',
          label: 'Project folders',
          description: 'Which folders hold work that is not committed or not pushed yet.',
          control: 'block',
          icon: 'folder',
          sample: null,
        }}
      >
        <Button variant="tonal" size="sm" disabled={checking} onClick={check}>
          {checking ? 'Checking...' : 'Check now'}
        </Button>
      </SettingRow>
      {logError ? (
        <div className="rowempty rowerr" role="alert">
          <span>Could not read what was committed.</span>
          <Button variant="text" size="sm" onClick={() => readLog.current()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="rowempty">
          {log.length === 0
            ? 'Nothing has been committed after a run yet.'
            : log
                .slice(0, 5)
                .map((entry) => `${outcome(entry)} (${timeAgo(entry.at)})`)
                .join('. ')}
        </div>
      )}
    </SectionBlock>
  )
}

/** Advanced: the quick chat shortcut, the sync server, the freeze watchdog, and every stored value in one table. */
function AdvancedSection({ settings, put, resetRow }: SectionProps): JSX.Element {
  const stored = ['mode', 'cli', 'cliModel', 'provider', 'model', 'hasKey', 'baseUrl', 'allowHttp', 'onboarded']
  const shown = (value: unknown): string => {
    if (typeof value === 'boolean') return value ? 'yes' : 'no'
    if (value === '' || value === null || value === undefined) return 'empty'
    return String(value)
  }
  return (
    <SectionBlock
      id="advanced"
      name="Advanced"
      line="Shortcuts, the sync server and the stored values. Every one of these is also found by the search box."
    >
      <SettingRow
        spec={row('quickAskHotkey')}
        changed={changedNow(row('quickAskHotkey'), settings)}
        onReset={() => resetRow(row('quickAskHotkey'))}
      >
        <HotkeyControl label="Quick chat shortcut" value={settings?.quickAskHotkey ?? ''} onSave={(next) => put({ quickAskHotkey: next })} />
      </SettingRow>
      <SettingRow spec={row('syncUrl')} changed={changedNow(row('syncUrl'), settings)} onReset={() => resetRow(row('syncUrl'))}>
        <TextControl
          label="Sync server"
          value={settings?.syncUrl ?? ''}
          placeholder="The default service"
          width={240}
          onCommit={(value) => put({ syncUrl: value })}
        />
      </SettingRow>
      <SettingRow spec={row('watchdogMs')} changed={changedNow(row('watchdogMs'), settings)} onReset={() => resetRow(row('watchdogMs'))}>
        <NumberControl
          label="Log a frozen main thread, ms"
          value={settings?.watchdogMs ?? 1000}
          off="Off"
          max={60_000}
          unit="ms"
          onCommit={(next) => put({ watchdogMs: next })}
        />
      </SettingRow>
      <div className="divider" />
      <div className="rowempty" style={{ paddingBottom: 0 }}>
        <b>Stored values</b>
        <div className="small muted">Read only. Kept from installs that came before AI accounts; the account holds the truth now.</div>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>What</th>
            <th>Key</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {stored.map((key) => (
            <tr key={key}>
              <td className="what">{row(key).label}</td>
              <td>
                <code>{key}</code>
              </td>
              <td>{shown((settings as unknown as Record<string, unknown> | null)?.[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="rowempty" />
    </SectionBlock>
  )
}
