/**
 * Where heavy work can run: this computer, then every linked device that can take work (Settings > Devices), each
 * with whether it is connected now. Home and Connections both draw it; with none linked it points to Devices.
 */
import { timeAgo } from '../lib/format'
import type { LinkedDevice } from '../lib/devices-summary'
import { useDevicesSummary } from '../state/useDevices'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Icon, type IconName } from '../ui/Icon'

/** Opens Settings at its Devices section. */
export function useOpenDevices(): () => void {
  const navigate = useUi((state) => state.navigate)
  return () => {
    navigate({ page: 'settings' })
    // The page draws after the route changes; try for a moment, then give up quietly.
    let tries = 0
    const find = (): void => {
      const section = document.getElementById('settings-devices')
      if (section !== null) section.scrollIntoView({ block: 'start', behavior: 'smooth' })
      else if (tries++ < 20) window.setTimeout(find, 50)
    }
    window.setTimeout(find, 0)
  }
}

function iconOf(device: LinkedDevice): IconName {
  return device.kind === 'server' ? 'server' : device.kind === 'phone' ? 'phone' : 'monitor'
}

function lineOf(device: LinkedDevice): string {
  if (device.online) return 'Linked. Takes work when it is placed there.'
  if (device.lastSeen > 0) return `Not connected. Last seen ${timeAgo(device.lastSeen) === 'now' ? 'just now' : timeAgo(device.lastSeen)}.`
  return 'Not connected right now.'
}

function Pill({ online }: { online: boolean }): JSX.Element {
  return <span className={`pill ${online ? 'ok' : 'mute'}`}>{online ? 'Online' : 'Offline'}</span>
}

/** `list`: Home's compact list. `rows`: the card rows Connections uses. */
export function Machines({ look, thisName, thisLine }: { look: 'list' | 'rows'; thisName: string; thisLine: string }): JSX.Element {
  const devices = useDevicesSummary()
  const openDevices = useOpenDevices()
  const others = devices.brains
  const rows: Array<{ key: string; icon: IconName; title: string; line: string; right: JSX.Element }> = [
    { key: 'self', icon: 'monitor', title: thisName, line: thisLine, right: <Pill online /> },
    ...others.map((device) => ({ key: device.id, icon: iconOf(device), title: device.name, line: lineOf(device), right: <Pill online={device.online} /> })),
  ]
  if (others.length === 0) {
    rows.push({
      key: 'link',
      icon: 'server',
      title: 'Another machine',
      line: devices.enabled ? 'Link a server or computer and heavy work can run there.' : 'Turn on Devices and link a server or computer to hand it heavy work.',
      right: (
        <Button variant="tonal" size="sm" onClick={openDevices}>
          Link one
        </Button>
      ),
    })
  }

  if (look === 'rows') {
    return (
      <>
        {rows.map((row) => (
          <div className="rowc" key={row.key}>
            <div className="ri">
              <Icon name={row.icon} size={22} />
            </div>
            <div className="rt">
              <b>{row.title}</b>
              <span>{row.line}</span>
            </div>
            {row.right}
          </div>
        ))}
      </>
    )
  }
  return (
    <ul className="list mach">
      {rows.map((row) => (
        <li key={row.key}>
          <span className="mi">
            <Icon name={row.icon} size={20} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="t1" style={{ font: "500 14px/1.3 'Roboto',sans-serif" }}>
              {row.title}
            </div>
            <div className="small muted">{row.line}</div>
          </div>
          {row.right}
        </li>
      ))}
    </ul>
  )
}
