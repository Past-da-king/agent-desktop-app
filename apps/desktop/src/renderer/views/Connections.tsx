import type { EnvironmentReport, Found, SystemInfo } from '@agent/core'
import { useEffect, useState, type ReactNode } from 'react'

import { agent } from '../bridge'
import { formatAccelerator } from '../lib/hotkey'
import { machineSummary, scanSummary } from '../lib/system'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'
import { ConnectedAppsSection, LearnedAppsSection } from './ConnectedApps'

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

function FoundRow({ item }: { item: Found }): JSX.Element {
  const line = item.found ? (item.version === undefined ? 'Found' : item.version) : 'Not found'
  return (
    <span className={`found-chip${item.found ? ' on' : ''}`} title={item.found ? `${item.label}: ${line}` : `${item.label} is not on this computer`}>
      <Icon name={item.found ? 'check' : 'x'} size={14} />
      <b>{item.label}</b>
      {item.found && item.version !== undefined ? <span>{item.version}</span> : null}
    </span>
  )
}

function FoundGroup({ title, items }: { title: string; items: Found[] }): JSX.Element {
  return (
    <div>
      <p className="eyebrow mute" style={{ margin: '10px 4px 2px' }}>
        {title}
      </p>
      {items.length === 0 ? (
        <p className="small muted" style={{ margin: '4px' }}>
          Nothing looked for yet.
        </p>
      ) : (
        <div className="found-chips">
          {items.map((item) => (
            <FoundRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  )
}

export function Connections(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [environment, setEnvironment] = useState<EnvironmentReport | null>(null)
  const [scanning, setScanning] = useState(true)
  const allowed = settings?.grantedFolders ?? []
  const keys = formatAccelerator(settings?.quickAskHotkey || 'CommandOrControl+Shift+Space', agent.platform)
  const device = settings?.deviceName || 'This computer'
  const machine = system ? machineSummary(system) : 'This computer'
  const folderLine = `${allowed.length} ${allowed.length === 1 ? 'folder' : 'folders'} granted`

  useEffect(() => {
    let live = true
    agent.system
      .info()
      .then((info) => {
        if (live) setSystem(info)
      })
      .catch(() => {
        // The machine line falls back to "This computer" when the main process cannot answer.
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
        // The list simply stays as it was; the rest of the page works without it.
      })
      .finally(() => {
        if (live) setScanning(false)
      })
    return () => {
      live = false
    }
  }, [])

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

  const askForFolder = async (): Promise<void> => {
    try {
      const folder = await agent.files.pickFolder()
      if (!folder) return
      const current = settings?.grantedFolders ?? []
      if (!current.includes(folder)) await save({ grantedFolders: [...current, folder] })
    } catch {
      // A cancelled or refused picker leaves the granted list as it was.
    }
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">CONNECTIONS</span>
          <h1 className="h1">On this computer</h1>
          <p className="lead">What your agent can reach from this computer, and the apps it can use for you.</p>
        </div>
      </div>

      <ConnectedAppsSection />

      <div className="two conn-rest">
        <div className="stack">
          <LearnedAppsSection />

          <section>
            <SectionHeader eyebrow="BUILT IN" line="On this computer, plus the machines you add" />
            <div className="list" style={{ padding: 6 }}>
              <Row
                icon="globe"
                title="Agent's browser"
                line="Its own browser, with separate sign-ins for each profile. It shows in Chat while it works, and hands over to you when a page needs you"
                right={<span className="pill ok">Ready</span>}
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
                line="Drag files onto a chat to attach them, up to 20 MB each"
                right={<span className="pill ok">Ready</span>}
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
        </div>

        <div className="stack">
          <section>
            <SectionHeader eyebrow="THIS COMPUTER" line="What your agent can use here" />
            <div className="card" style={{ padding: 10 }}>
              <Row
                icon="monitor"
                title={device}
                line={machine}
                right={<span className="pill ok">Online</span>}
              />
              <Row
                icon="folder"
                title="Granted folders"
                line={
                  allowed.length === 0
                    ? 'None yet. Your agent asks before touching a file.'
                    : `${folderLine}. Your agent can read and write there without asking.`
                }
                right={
                  <Button
                    variant="tonal"
                    size="sm"
                    onClick={() => {
                      navigate({ page: 'settings' })
                    }}
                  >
                    Manage
                  </Button>
                }
              />
              <Row
                icon="shield"
                title="Shell commands"
                line={settings?.shell === 'never' ? 'Never run on this computer' : settings?.shell === 'always' ? 'Runs without asking' : 'Ask before every command'}
                right={<span className="pill mute">{settings?.shell === 'never' ? 'Off' : settings?.shell === 'always' ? 'No asking' : 'Ask first'}</span>}
              />
            </div>
          </section>

          <section>
            <SectionHeader
              eyebrow="FOUND HERE"
              line="What is already on this computer"
              right={
                <Button variant="tonal" size="sm" disabled={scanning} onClick={() => void scanAgain()}>
                  {scanning ? 'Scanning...' : 'Scan again'}
                </Button>
              }
            />
            <div className="card" style={{ padding: 10 }}>
              {environment === null ? (
                <p className="small muted" style={{ margin: '4px' }}>
                  Looking at this computer...
                </p>
              ) : (
                <>
                  <FoundGroup title="SHELLS" items={environment.shells} />
                  <FoundGroup title="RUNTIMES" items={environment.runtimes} />
                  <FoundGroup title="AI TOOLS" items={environment.aiTools} />
                  {environment.notes.map((note) => (
                    <p key={note} className="small muted" style={{ margin: '10px 4px 0', lineHeight: 1.5 }}>
                      {note}
                    </p>
                  ))}
                </>
              )}
            </div>
          </section>

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
                line={`${machine}, ${folderLine}. Runs jobs while the app is open.`}
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
        </div>
      </div>
    </div>
  )
}
