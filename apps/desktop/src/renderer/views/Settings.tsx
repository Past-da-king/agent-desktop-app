import { PROVIDERS, type EnvironmentReport, type Found, type HotkeyStatus, type SystemInfo } from '@agent/core'
import { useEffect, useRef, useState } from 'react'

import { agent } from '../bridge'
import { folderName } from '../lib/files'
import { timeAgo } from '../lib/format'
import { acceleratorFromEvent, formatAccelerator } from '../lib/hotkey'
import { machineSummary, scanSummary } from '../lib/system'
import { ACCENTS, applyAccent } from '../state/theme'
import { useAccountStatus } from '../state/useAccount'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Avatar, IconButton, Pill } from '../ui/bits'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { MASCOT_ORDER, Mascot, MASCOTS } from '../ui/Mascot'
import { SectionHeader } from '../ui/SectionHeader'
import { VoiceSettings } from '../voice/VoiceSettings'
import { Segmented } from '../ui/Segmented'
import { Switch } from '../ui/Switch'

function ResetDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const navigate = useUi((state) => state.navigate)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog label="Reset this computer" onClose={onClose} labelledBy="reset-title">
      <div>
        <span className="eyebrow">DANGER ZONE</span>
        <h2 className="h2" id="reset-title" style={{ marginTop: 6 }}>
          Reset everything on this computer?
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          This deletes keys, memory, to-dos, routines and chats from this computer only. Your account keeps its copy
          on the server.
        </p>
      </div>
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="line"
          style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void agent.settings
              .reset()
              .then(() => {
                onClose()
                navigate({ page: 'onboarding', step: 'signin' })
              })
              .catch(() => setBusy(false))
          }}
        >
          {busy ? 'Resetting...' : 'Reset this computer'}
        </Button>
      </div>
    </Dialog>
  )
}

function HotkeyRecorder({
  value,
  platform,
  onSave,
}: {
  value: string
  platform: string
  onSave: (accelerator: string) => void
}): JSX.Element {
  const [recording, setRecording] = useState(false)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  useEffect(() => {
    if (!recording) return
    const onKey = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(false)
        return
      }
      const accelerator = acceleratorFromEvent(event, platform)
      if (accelerator === null) return
      setRecording(false)
      saveRef.current(accelerator)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, platform])

  const keys = formatAccelerator(value, platform)

  return (
    <div className="kbds">
      {recording ? (
        <span className="small muted">Press the keys now</span>
      ) : keys.length > 0 ? (
        keys.map((key) => <kbd key={key}>{key}</kbd>)
      ) : (
        <span className="small muted">No shortcut</span>
      )}
      <Button variant="tonal" size="sm" onClick={() => setRecording(true)}>
        {recording ? 'Listening...' : 'Record'}
      </Button>
    </div>
  )
}

function toolsLine(report: EnvironmentReport): string {
  const shells = report.shells.filter((item) => item.found).map((item) => item.label)
  const runtimes = report.runtimes.filter((item) => item.found).map((item) => foundName(item))
  const aiTools = report.aiTools.filter((item) => item.found).map((item) => foundName(item))
  const missing = report.aiTools.filter((item) => !item.found).map((item) => item.label)
  const parts = [...shells, ...runtimes, ...aiTools]
  const found = parts.length === 0 ? 'Nothing found yet' : parts.join(', ')
  return missing.length === 0 ? found : `${found}. Not found: ${missing.join(', ')}.`
}

function foundName(item: Found): string {
  return item.version === undefined ? item.label : `${item.label} ${item.version}`
}

export function Settings(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const navigateTo = useUi((state) => state.navigate)
  const [cliStatus, setCliStatus] = useState('')
  const [cliBusy, setCliBusy] = useState(false)
  const checkCli = async (): Promise<void> => {
    setCliBusy(true)
    try {
      const result = await agent.settings.checkCli()
      setCliStatus(result.message)
    } catch (cause) {
      setCliStatus(cause instanceof Error ? cause.message : 'Could not reach Claude Code.')
    } finally {
      setCliBusy(false)
    }
  }
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const status = useAccountStatus()
  const [resetting, setResetting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus | null>(null)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null)
  const [scanning, setScanning] = useState(true)

  useEffect(() => {
    let live = true
    agent.system
      .info()
      .then((info) => {
        if (live) setSystem(info)
      })
      .catch(() => {
        // The machine line is a detail; the rest of Settings works without it.
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    agent.environment
      .scan()
      .then((report) => {
        if (live) setEnvironment(report)
      })
      .catch(() => {
        // The summary is a detail; the rest of Settings works without it.
      })
      .finally(() => {
        if (live) setScanning(false)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => agent.window.onHotkeyStatus((status) => setHotkeyStatus(status)), [])

  const scanAgain = async (): Promise<void> => {
    setScanning(true)
    try {
      const report = await agent.environment.scan(true)
      setEnvironment(report)
      toast(scanSummary(report))
    } catch (cause: unknown) {
      toast(cause instanceof Error ? cause.message : 'The scan could not finish.')
    } finally {
      setScanning(false)
    }
  }

  const provider = PROVIDERS.find((item) => item.id === settings?.provider)
  const model = settings?.model.trim() || provider?.defaultModel || 'No model chosen'
  const signedIn = settings?.signedIn ?? false
  const userName = settings?.userName.trim() || 'You'
  const email = settings?.syncEmail ?? ''
  const device = settings?.deviceName || 'This computer'

  const syncLine = status.syncing
    ? 'Syncing now'
    : status.error
      ? 'Offline, will sync later'
      : status.lastSyncedAt !== null
        ? `Synced ${timeAgo(status.lastSyncedAt) === 'now' ? 'just now' : timeAgo(status.lastSyncedAt)}`
        : 'Not synced yet'

  const syncNow = async (): Promise<void> => {
    if (!signedIn || syncing) return
    setSyncing(true)
    try {
      await agent.account.syncNow()
    } catch {
      // The status listener shows an offline state; the button returns to normal.
    } finally {
      setSyncing(false)
    }
  }

  const addFolder = async (): Promise<void> => {
    if (pickingFolder) return
    setPickingFolder(true)
    try {
      const folder = await agent.files.pickFolder()
      if (folder === null) return
      const current = settings?.grantedFolders ?? []
      if (!current.includes(folder)) await save({ grantedFolders: [...current, folder] })
    } catch {
      // A cancelled or refused picker leaves the list as it was.
    } finally {
      setPickingFolder(false)
    }
  }

  const removeFolder = (folder: string): void => {
    const current = settings?.grantedFolders ?? []
    void save({ grantedFolders: current.filter((item) => item !== folder) })
  }

  const folders = settings?.grantedFolders ?? []

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">SETTINGS</span>
          <h1 className="h1">Settings</h1>
          <p className="lead">Account, AI, look and this computer.</p>
        </div>
      </div>

      <div className="two">
        <div className="stack">
          <section>
            <SectionHeader eyebrow="ACCOUNT AND SYNC" line="One agent across your devices" />
            <div className="card" style={{ padding: 10 }}>
              <div className="rowc">
                <Avatar name={userName} size={48} />
                <div className="rt">
                  <b>{signedIn ? userName : 'This computer only'}</b>
                  <span>{signedIn ? email : 'No account. Everything stays here.'}</span>
                </div>
                {signedIn ? (
                  <Button
                    variant="tonal"
                    size="sm"
                    onClick={() => {
                      void agent.account.signOut().then(() => {
                        navigate({ page: 'onboarding', step: 'signin' })
                      })
                    }}
                  >
                    Sign out
                  </Button>
                ) : (
                  <Button
                    variant="tonal"
                    size="sm"
                    onClick={() => navigate({ page: 'onboarding', step: 'signin' })}
                  >
                    Sign in
                  </Button>
                )}
              </div>
              <div className="rowc" title="Coming soon">
                <div className="ri">
                  <Icon name="phone" size={22} />
                </div>
                <div className="rt">
                  <b>Your phone</b>
                  <span>Sync with the Android app arrives after the desktop is done.</span>
                </div>
                <Pill tone="mute">Coming soon</Pill>
              </div>
              <div className="rowc">
                <div className="ri">
                  <Icon name="monitor" size={22} />
                </div>
                <div className="rt">
                  <b>This computer</b>
                  <span>
                    {device}, {syncLine}
                  </span>
                </div>
                <Pill tone="pri">This one</Pill>
              </div>
              <div style={{ padding: '6px 18px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Button
                  variant="tonal"
                  size="sm"
                  onClick={() => {
                    void syncNow()
                  }}
                  disabled={!signedIn || syncing}
                >
                  <Icon name="sync" size={16} />
                  {syncing ? 'Syncing...' : 'Sync now'}
                </Button>
                <span className="small muted">Keys never sync. Each device keeps its own.</span>
              </div>
            </div>
          </section>

          <section>
            <SectionHeader eyebrow="YOUR AI" line="The service that does the thinking" />
            <div className="card" style={{ padding: 10 }}>
              {settings?.mode === 'subscription' ? (
                <div className="rowc">
                  <div className="ri ok">
                    <Icon name="bolt" size={22} />
                  </div>
                  <div className="rt">
                    <b>{settings.cli === 'codex' ? 'Your ChatGPT plan, through Codex' : 'Your Claude plan'}</b>
                    <span>{cliStatus === '' ? 'No API key needed. Billed by your plan, not by the app.' : cliStatus}</span>
                  </div>
                  <Button variant="tonal" size="sm" disabled={cliBusy} onClick={() => void checkCli()}>
                    {cliBusy ? 'Checking...' : 'Check'}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="rowc">
                    <div className="ri">
                      <Icon name="bolt" size={22} />
                    </div>
                    <div className="rt">
                      <b>{provider?.label ?? 'No provider yet'}</b>
                      <span>Model: {model}</span>
                    </div>
                  </div>
                  <div className="rowc">
                    <div className="ri">
                      <Icon name="key" size={22} />
                    </div>
                    <div className="rt">
                      <b>API key</b>
                      <span>
                        {settings?.hasKey
                          ? 'Stored by your operating system, never shown in this window.'
                          : 'No key on this computer yet.'}
                      </span>
                    </div>
                    <Pill tone={settings?.hasKey ? 'ok' : 'mute'}>{settings?.hasKey ? 'Works' : 'Not yet'}</Pill>
                  </div>
                </>
              )}
              <div className="rowc">
                <div className="ri">
                  <Icon name="sync" size={22} />
                </div>
                <div className="rt">
                  <b>Change how your agent thinks</b>
                  <span>Switch between your Claude plan, your ChatGPT plan and an API key</span>
                </div>
                <Button variant="tonal" size="sm" onClick={() => navigateTo({ page: 'onboarding', step: 'ai' })}>
                  Change
                </Button>
              </div>
            </div>
          </section>

          <VoiceSettings />
        </div>

        <div className="stack">
          <section>
            <SectionHeader eyebrow="LOOK" line="Light, dark or the same as your computer, your colour, your sidekick" />
            <div className="card">
              <Segmented
                ariaLabel="Theme"
                value={settings?.theme ?? 'system'}
                onChange={(value) => {
                  void save({ theme: value })
                }}
                options={[
                  { value: 'system', label: 'System', icon: <Icon name="monitor" size={18} /> },
                  { value: 'light', label: 'Light', icon: <Icon name="sun" size={18} /> },
                  { value: 'dark', label: 'Dark', icon: <Icon name="moon" size={18} /> },
                ]}
                style={{ marginBottom: 20 }}
              />
              <div className="eyebrow mute" style={{ marginBottom: 10 }}>
                YOUR COLOUR
              </div>
              <div className="swatches" style={{ marginBottom: 22 }}>
                {ACCENTS.map((accent) => {
                  const active = (settings?.accent ?? 'iris') === accent.id
                  return (
                    <button
                      key={accent.id}
                      type="button"
                      className={`sw${active ? ' on' : ''}`}
                      aria-label={accent.label}
                      aria-pressed={active}
                      style={{ background: accent.swatch }}
                      onClick={() => {
                        applyAccent(accent.id)
                        void save({ accent: accent.id })
                      }}
                    >
                      {active ? <Icon name="check" size={20} /> : null}
                    </button>
                  )
                })}
              </div>
              <div className="eyebrow mute" style={{ marginBottom: 10 }}>
                YOUR SIDEKICK
              </div>
              <div className="mascots">
                {MASCOT_ORDER.map((id) => {
                  const active = (settings?.mascot ?? 'scout') === id
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`mk${active ? ' on' : ''}`}
                      aria-label={MASCOTS[id].label}
                      aria-pressed={active}
                      onClick={() => {
                        void save({ mascot: id })
                      }}
                    >
                      <Mascot id={id} size={38} />
                    </button>
                  )
                })}
              </div>
            </div>
          </section>

          <section>
            <SectionHeader eyebrow="THIS COMPUTER" line="How the app behaves here" />
            <div className="card" style={{ padding: 10 }}>
              <div className="rowc">
                <div className="ri">
                  <Icon name="monitor" size={22} />
                </div>
                <div className="rt">
                  <b>{device}</b>
                  <span>{system ? machineSummary(system) : 'This computer'}</span>
                </div>
                <Pill tone="ok">This one</Pill>
              </div>
              <div className="rowc">
                <div className="ri">
                  <Icon name="search" size={22} />
                </div>
                <div className="rt">
                  <b>Tools on this computer</b>
                  <span>{environment === null ? 'Looking at this computer...' : toolsLine(environment)}</span>
                </div>
                <Button variant="tonal" size="sm" disabled={scanning} onClick={() => void scanAgain()}>
                  {scanning ? 'Scanning...' : 'Scan again'}
                </Button>
              </div>
              <div className="rowc">
                <div className="ri">
                  <Icon name="play" size={22} />
                </div>
                <div className="rt">
                  <b>Start when I sign in</b>
                  <span>So routines run without you opening anything</span>
                </div>
                <Switch
                  on={settings?.launchAtLogin ?? false}
                  onToggle={(next) => {
                    void save({ launchAtLogin: next })
                  }}
                  label="Start when I sign in"
                />
              </div>
              <div className="rowc">
                <div className="ri">
                  <Icon name="bell" size={22} />
                </div>
                <div className="rt">
                  <b>Desktop notifications</b>
                  <span>For questions and approvals</span>
                </div>
                <Switch
                  on={settings?.notifications ?? true}
                  onToggle={(next) => {
                    void save({ notifications: next })
                  }}
                  label="Desktop notifications"
                />
              </div>
              <div className="rowc">
                <div className="ri">
                  <Icon name="panel" size={22} />
                </div>
                <div className="rt">
                  <b>Keep running in the tray</b>
                  <span>Closing the window does not stop routines</span>
                </div>
                <Switch
                  on={settings?.closeToTray ?? true}
                  onToggle={(next) => {
                    void save({ closeToTray: next })
                  }}
                  label="Keep running in the tray"
                />
              </div>
              <div className="rowc" style={{ flexWrap: 'wrap' }}>
                <div className="ri">
                  <Icon name="bolt" size={22} />
                </div>
                <div className="rt">
                  <b>Quick Ask shortcut</b>
                  <span>A small box from anywhere on this computer</span>
                </div>
                <HotkeyRecorder
                  value={settings?.quickAskHotkey ?? 'CommandOrControl+Shift+Space'}
                  platform={agent.platform}
                  onSave={(accelerator) => {
                    void save({ quickAskHotkey: accelerator })
                  }}
                />
              </div>
              {hotkeyStatus !== null ? (
                <div className="small muted" style={{ padding: '0 18px 12px 78px' }}>
                  {hotkeyStatus.message}
                </div>
              ) : null}
              <div className="rowc">
                <div className="ri">
                  <Icon name="folder" size={22} />
                </div>
                <div className="rt">
                  <b>Folders I can use</b>
                  <span>
                    {folders.length === 0
                      ? 'None yet. I ask before touching any file.'
                      : `${folders.length} ${folders.length === 1 ? 'folder' : 'folders'} I can read and write without asking`}
                  </span>
                </div>
                <Button
                  variant="tonal"
                  size="sm"
                  disabled={pickingFolder}
                  onClick={() => {
                    void addFolder()
                  }}
                >
                  {pickingFolder ? 'Choosing...' : 'Add folder'}
                </Button>
              </div>
              {folders.map((folder) => (
                <div className="rowc" key={folder}>
                  <div className="ri" style={{ background: 'var(--s-high)', color: 'var(--on-sv)' }}>
                    <Icon name="folder" size={18} />
                  </div>
                  <div className="rt">
                    <b>{folderName(folder)}</b>
                    <span>{folder}</span>
                  </div>
                  <IconButton
                    icon="trash"
                    size={18}
                    label={`Remove ${folder}`}
                    onClick={() => removeFolder(folder)}
                  />
                </div>
              ))}
              <div className="rowc">
                <div className="ri">
                  <Icon name="shield" size={22} />
                </div>
                <div className="rt">
                  <b>Commands and files</b>
                  <span>
                    {settings?.shell === 'never'
                      ? 'Never run a command or code on this computer'
                      : settings?.shell === 'always'
                        ? 'Runs commands and code, and opens files anywhere, without asking'
                        : 'Asks before every command, and before files outside your folders'}
                  </span>
                </div>
                <Pill tone={settings?.shell === 'always' ? 'pri' : 'mute'}>
                  {settings?.shell === 'never' ? 'Off' : settings?.shell === 'always' ? 'No asking' : 'Ask first'}
                </Pill>
              </div>
              <div style={{ padding: '0 18px 14px 78px' }}>
                <Segmented
                  ariaLabel="Commands and files"
                  value={settings?.shell ?? 'ask'}
                  onChange={(value) => {
                    void save({ shell: value })
                  }}
                  options={[
                    { value: 'always', label: 'Run without asking' },
                    { value: 'ask', label: 'Ask first' },
                    { value: 'never', label: 'Never' },
                  ]}
                />
              </div>
            </div>
          </section>

          <section>
            <SectionHeader eyebrow="DANGER ZONE" line="Cannot be undone" />
            <div className="card" style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 220 }}>
                <div className="h3 danger">Reset everything on this computer</div>
                <div className="small muted">
                  Deletes keys, memory, to-dos, routines and chats from this computer only. Your account keeps its
                  copy.
                </div>
              </div>
              <Button
                variant="line"
                size="sm"
                style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
                onClick={() => setResetting(true)}
              >
                Reset
              </Button>
            </div>
          </section>
        </div>
      </div>

      {resetting ? <ResetDialog onClose={() => setResetting(false)} /> : null}
    </div>
  )
}
