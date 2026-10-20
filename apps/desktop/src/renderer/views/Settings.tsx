import { PROVIDERS } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { timeAgo } from '../lib/format'
import { ACCENTS, applyAccent, isDarkNow } from '../state/theme'
import { useAccountStatus } from '../state/useAccount'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Avatar, Pill } from '../ui/bits'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { MASCOT_ORDER, Mascot, MASCOTS } from '../ui/Mascot'
import { SectionHeader } from '../ui/SectionHeader'
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

export function Settings(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const status = useAccountStatus()
  const [resetting, setResetting] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const provider = PROVIDERS.find((item) => item.id === settings?.provider)
  const model = settings?.model.trim() || provider?.defaultModel || 'No model chosen'
  const dark = isDarkNow()
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
              <div className="rowc">
                <div className="ri">
                  <Icon name="bolt" size={22} />
                </div>
                <div className="rt">
                  <b>{provider?.label ?? 'No provider yet'}</b>
                  <span>Model: {model}</span>
                </div>
                <Button variant="tonal" size="sm" comingSoon>
                  Change
                </Button>
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
            </div>
          </section>
        </div>

        <div className="stack">
          <section>
            <SectionHeader eyebrow="LOOK" line="Light or dark, your colour, your sidekick" />
            <div className="card">
              <Segmented
                ariaLabel="Theme"
                value={dark ? 'dark' : 'light'}
                onChange={(value) => {
                  void save({ theme: value })
                }}
                options={[
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
                  comingSoon={agent.platform === 'web'}
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
                  comingSoon={agent.platform === 'web'}
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
