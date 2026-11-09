import type { EnvironmentReport, Found, SystemInfo } from '@agent/core'
import { useEffect, useState, type ReactNode } from 'react'

import { agent } from '../bridge'
import { formatAccelerator } from '../lib/hotkey'
import { machineSummary, scanSummary } from '../lib/system'
import { failText, orTell } from '../lib/tell'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'
import { Segmented } from '../ui/Segmented'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'
import { ConnectedAppsSection, LearnedAppsSection } from './ConnectedApps'
import { MiniAppsSection } from './MiniApps'
import { Machines, useOpenDevices } from './Machines'

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
  const [appsTab, setAppsTab] = useState<'composio' | 'learned' | 'mini'>('composio')
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const navigate = useUi((state) => state.navigate)
  const openDevices = useOpenDevices()
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
      if (current.includes(folder)) {
        toast('That folder is already granted.')
        return
      }
      await save({ grantedFolders: [...current, folder] })
      toast('Folder granted. Your agent can read and write there.')
    } catch (cause: unknown) {
      // A cancelled picker resolves with nothing; this is a picker or a save that really failed.
      toast(failText(cause, 'The folder could not be added.'))
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

      <div className="apps-switch">
        <Segmented
          ariaLabel="Which apps"
          value={appsTab}
          onChange={setAppsTab}
          options={[
            { value: 'composio', label: 'Connected apps' },
            { value: 'learned', label: 'Learned apps' },
            { value: 'mini', label: 'Mini apps' },
          ]}
        />
      </div>
      {appsTab === 'composio' ? <ConnectedAppsSection /> : appsTab === 'learned' ? <LearnedAppsSection /> : <MiniAppsSection bare />}

      <div className="two conn-rest">
        <div className="stack">

          <section>
            <SectionHeader eyebrow="BUILT IN" line="Ready from the start, nothing to set up" />
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
                      void orTell(save({ notifications: next }), 'That could not be saved.')
                    }}
                    label="Desktop notifications"
                  />
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
                  <span className="conn-row-actions">
                    <Button
                      variant="tonal"
                      size="sm"
                      onClick={() => {
                        void askForFolder()
                      }}
                    >
                      {allowed.length === 0 ? 'Allow a folder' : 'Add'}
                    </Button>
                    {allowed.length === 0 ? null : (
                      <Button
                        variant="text"
                        size="sm"
                        onClick={() => {
                          navigate({ page: 'settings' })
                        }}
                      >
                        Manage
                      </Button>
                    )}
                  </span>
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
                <Button size="sm" onClick={openDevices}>
                  <Icon name="plus" size={16} />
                  Add machine
                </Button>
              }
            />
            <div className="list" style={{ padding: 6 }}>
              <Machines look="rows" thisName="This computer" thisLine={`${machine}, ${folderLine}. Runs jobs while the app is open.`} />
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
