import type { ReactNode } from 'react'

import { agent } from '../bridge'
import { useSettings } from '../state/useSettings'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'

function Row({
  icon,
  title,
  line,
  right,
}: {
  icon: IconName
  title: string
  line: string
  right: ReactNode
}): JSX.Element {
  return (
    <div className="rowc">
      <div className="ri">
        <Icon name={icon} size={22} />
      </div>
      <div className="rt">
        <b>{title}</b>
        <span>{line}</span>
      </div>
      {right}
    </div>
  )
}

function hotkeyKeys(hotkey: string, platform: string): string[] {
  return hotkey
    .split('+')
    .map((part) => {
      if (part === 'CommandOrControl') return platform === 'darwin' ? 'Cmd' : 'Ctrl'
      if (part === 'Control') return 'Ctrl'
      if (part === 'Space') return 'Space'
      return part
    })
    .filter(Boolean)
}

export function Connections(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const allowed = settings?.grantedFolders ?? []
  const keys = hotkeyKeys(settings?.quickAskHotkey || 'CommandOrControl+Shift+Space', agent.platform)
  const device = settings?.deviceName || 'This computer'

  const askForFolder = async (): Promise<void> => {
    try {
      const folder = await agent.files.pickFolder()
      if (!folder) return
      const current = settings?.grantedFolders ?? []
      if (!current.includes(folder)) await save({ grantedFolders: [...current, folder] })
    } catch {
      // Folder picking arrives with the desktop-native milestone; nothing to add yet.
    }
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">CONNECTIONS</span>
          <h1 className="h1">On this computer</h1>
          <p className="lead">What your agent can reach from this computer.</p>
        </div>
      </div>

      <div className="two">
        <div className="stack">
          <section>
            <SectionHeader eyebrow="BUILT IN" line="On this computer, plus the machines you add" />
            <div className="list" style={{ padding: 6 }}>
              <Row
                icon="globe"
                title="Agent's browser"
                line="A real browser it uses while you do other things"
                right={<span className="pill mute">Coming soon</span>}
              />
              <Row
                icon="bell"
                title="Notifications"
                line="Results and questions reach you, even when the window is closed"
                right={
                  <Switch
                    on={settings?.notifications ?? true}
                    onToggle={(next) => {
                      void save({ notifications: next })
                    }}
                    label="Desktop notifications"
                  />
                }
              />
              <Row
                icon="folder"
                title="Files on this computer"
                line={
                  allowed.length === 0
                    ? 'Let your agent find and read files you point it to'
                    : `${allowed.length} ${allowed.length === 1 ? 'folder' : 'folders'} granted`
                }
                right={
                  <Button
                    variant="tonal"
                    size="sm"
                    comingSoon={agent.platform !== 'web'}
                    onClick={() => {
                      void askForFolder()
                    }}
                  >
                    Allow
                  </Button>
                }
              />
              <Row
                icon="clip"
                title="Drop zone"
                line="Drag any file onto the window or the tray icon"
                right={<span className="pill mute">Coming soon</span>}
              />
              <Row
                icon="bolt"
                title="Quick ask shortcut"
                line="Opens a small box from anywhere"
                right={
                  <span className="kbds">
                    {keys.map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </span>
                }
              />
            </div>
          </section>

          <section>
            <SectionHeader eyebrow="PROFILES" line="Group accounts by part of your life" />
            <div className="prof" title="Coming soon">
              <div className="ri">
                <Icon name="person" size={24} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="h3">Work</div>
                <div className="small muted">Slack, Outlook and Teams. Coming soon.</div>
              </div>
              <Button variant="tonal" size="sm" comingSoon>
                Open
              </Button>
            </div>
            <div className="prof" style={{ marginTop: 10 }} title="Coming soon">
              <div className="ri" style={{ background: 'var(--sc)', color: 'var(--on-sc)' }}>
                <Icon name="mail" size={24} />
              </div>
              <div style={{ flex: 1 }}>
                <div className="h3">Personal</div>
                <div className="small muted">Gmail. Coming soon.</div>
              </div>
              <Button variant="tonal" size="sm" comingSoon>
                Open
              </Button>
            </div>
          </section>
        </div>

        <div className="stack">
          <section>
            <SectionHeader
              eyebrow="MACHINES"
              line="Hand heavy work to your servers and computers"
              right={
                <Button size="sm" comingSoon>
                  <Icon name="plus" size={16} />
                  Add machine
                </Button>
              }
            />
            <div className="list" style={{ padding: 6 }}>
              <Row
                icon="monitor"
                title="This computer"
                line={`${device}, runs jobs while the app is open`}
                right={<span className="pill ok">Online</span>}
              />
              <Row
                icon="server"
                title="Another machine"
                line="Signed in with its own key"
                right={<span className="pill mute">Coming soon</span>}
              />
            </div>
            <p className="small muted" style={{ margin: '10px 6px 0', lineHeight: 1.5 }}>
              Your agent only sees the names. Addresses, passwords and keys stay encrypted on this computer.
            </p>
          </section>

          <section>
            <SectionHeader eyebrow="ACCOUNTS" line="Sites your agent has learned to use" />
            <div className="list" style={{ padding: 6 }}>
              <Row
                icon="globe"
                title="Web accounts"
                line="Sites the agent signs in to for you"
                right={<span className="pill mute">Coming soon</span>}
              />
            </div>
            <p className="small muted" style={{ margin: '10px 6px 0', lineHeight: 1.5 }}>
              Connected accounts arrive after the browser does. Nothing is connected today.
            </p>
          </section>

          <section>
            <SectionHeader eyebrow="SHELL" line="Commands are always approved first" />
            <div className="list" style={{ padding: 6 }}>
              <Row
                icon="shield"
                title="Shell commands"
                line={settings?.shell === 'never' ? 'Never run on this computer' : 'Ask before every command'}
                right={<span className="pill mute">{settings?.shell === 'never' ? 'Off' : 'Ask first'}</span>}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
