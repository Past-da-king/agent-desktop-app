/**
 * Settings > Devices: this computer as a node other devices pair with (docs/devices-protocol.md). The switch, the
 * Add a device dialog (QR code, short code, 10-minute countdown), the paired devices with their roles and brain
 * order, and the addresses this computer gives out. In the remote window (a phone) it is read-only.
 */
import type { DeviceRole, DeviceRow, DevicesStatus, PairingOfferInfo } from '@agent/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { agent } from '../bridge'
import { timeAgo } from '../lib/format'
import { toast } from '../state/useToast'
import { IconButton, Pill } from '../ui/bits'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon, type IconName } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'

const ROLE_LABEL: Record<DeviceRole, string> = { screen: 'Screen', brain: 'Answers', hands: 'Acts' }
const ROLE_HINT: Record<DeviceRole, string> = {
  screen: 'Shows your chats and sends messages',
  brain: 'Runs the agent with its own plan or key',
  hands: 'Opens links, takes files and runs tools on itself',
}
const KIND_LABEL: Record<DeviceRow['kind'], string> = { phone: 'Phone', tablet: 'Tablet', desktop: 'Computer', server: 'Server' }
const KIND_ICON: Record<DeviceRow['kind'], IconName> = { phone: 'phone', tablet: 'phone', desktop: 'monitor', server: 'server' }

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
}

/** The QR code as an SVG. Always dark on light (the light theme's own surface and text tones), so it scans in dark mode too. */
export function QrCode({ matrix, size = 232, label }: { matrix: boolean[][]; size?: number; label: string }): JSX.Element {
  const quiet = 4
  const count = matrix.length + quiet * 2
  const path = useMemo(() => {
    const parts: string[] = []
    matrix.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`)
      })
    })
    return parts.join('')
  }, [matrix])
  return (
    <svg className="dv-qr" width={size} height={size} viewBox={`0 0 ${count} ${count}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={count} height={count} fill="#FEFDFB" />
      <path d={path} fill="#1B1A1F" />
    </svg>
  )
}

function useCountdown(until: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [until])
  // The clock may be older than the offer it counts down (it starts before the offer arrives).
  return Math.max(0, until - Math.max(now, Date.now()))
}

function clock(ms: number): string {
  const total = Math.ceil(ms / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function AddDeviceDialog({ onClose, known }: { onClose: () => void; known: string[] }): JSX.Element {
  const [offer, setOffer] = useState<PairingOfferInfo | null>(null)
  const [error, setError] = useState('')
  const [paired, setPaired] = useState<DeviceRow | null>(null)
  const knownRef = useRef(known)
  const left = useCountdown(offer?.expiresAt ?? 0)

  const make = useCallback(() => {
    setError('')
    agent.devices
      .offer()
      .then(setOffer)
      .catch((cause: unknown) => setError(message(cause, 'Could not make a code. Try again.')))
  }, [])

  useEffect(() => {
    make()
    // A device that pairs while the dialog is open shows here, and the code is used up.
    const off = agent.devices.onChanged(() => {
      void agent.devices.list().then((rows) => {
        const fresh = rows.find((row) => !row.revoked && !knownRef.current.includes(row.id))
        if (fresh !== undefined) setPaired(fresh)
      })
    })
    return () => {
      off()
      void agent.devices.cancelOffer().catch(() => undefined)
    }
  }, [make])

  const expired = offer !== null && left === 0
  return (
    <Dialog label="Add a device" onClose={onClose} labelledBy="dv-add-title" className="dv-dialog">
      <div>
        <span className="eyebrow">ADD A DEVICE</span>
        <h2 className="h2" id="dv-add-title" style={{ marginTop: 6 }}>
          {paired === null ? 'Scan this with the Agent app' : `${paired.name} is linked`}
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          {paired === null
            ? 'On your phone or other computer, open Agent, choose Link to my computer and point the camera here.'
            : 'It can use your agent from now on. You can change what it does in the list.'}
        </p>
      </div>
      {paired !== null ? (
        <div className="dv-done">
          <span className="ri ok">
            <Icon name="check" size={22} />
          </span>
          <span>
            {KIND_LABEL[paired.kind]}, {paired.roles.map((role) => ROLE_LABEL[role]).join(', ')}
          </span>
        </div>
      ) : error !== '' ? (
        <p className="dv-error" role="alert">
          {error}
        </p>
      ) : offer === null ? (
        <p className="small muted">Making a code...</p>
      ) : (
        <div className="dv-offer">
          <div className={`dv-qr-wrap${expired ? ' expired' : ''}`}>
            <QrCode matrix={offer.qr} label="Pairing code to scan" />
          </div>
          <div className="dv-code-side">
            <span className="eyebrow mute">OR TYPE THIS CODE</span>
            <div className="dv-code" aria-label={`Code ${offer.shortCode.split('').join(' ')}`}>
              {offer.shortCode}
            </div>
            <p className="small muted" aria-live="polite">
              {expired ? 'This code has run out.' : `Works once, for ${clock(left)} more.`}
            </p>
            {offer.urls.length > 0 ? (
              <>
                <span className="eyebrow mute" style={{ marginTop: 12 }}>
                  WITH ONE OF THESE ADDRESSES
                </span>
                <ul className="dv-urls">
                  {offer.urls.map((url) => (
                    <li key={url}>{url}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="small muted">This computer has no address other devices can reach. Add one in Devices.</p>
            )}
          </div>
        </div>
      )}
      <div className="dialog-actions">
        {paired === null && (expired || error !== '') ? (
          <Button variant="tonal" onClick={make}>
            Make a new code
          </Button>
        ) : null}
        <Button variant={paired === null ? 'text' : 'fill'} onClick={onClose}>
          {paired === null ? 'Cancel' : 'Done'}
        </Button>
      </div>
    </Dialog>
  )
}

function RevokeDialog({ device, onClose }: { device: DeviceRow; onClose: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog label="Take this device out" onClose={onClose} labelledBy="dv-revoke-title">
      <div>
        <span className="eyebrow">TAKE OUT</span>
        <h2 className="h2" id="dv-revoke-title" style={{ marginTop: 6 }}>
          Take {device.name} out?
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          It stops reaching your agent at once. To use it again, add it again with a new code.
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
            agent.devices
              .revoke(device.id)
              .then(() => {
                toast(`${device.name} is taken out.`)
                onClose()
              })
              .catch((cause: unknown) => {
                setBusy(false)
                toast(message(cause, 'Could not take it out. Try again.'))
              })
          }}
        >
          {busy ? 'Taking out...' : 'Take it out'}
        </Button>
      </div>
    </Dialog>
  )
}

function seenLine(device: DeviceRow, self: boolean, connected: boolean): string {
  if (self) return 'You are on it now'
  if (connected) return 'Connected now'
  if (device.lastSeen <= 0) return 'Not seen yet'
  const ago = timeAgo(device.lastSeen)
  return ago === 'now' ? 'Seen just now' : `Seen ${ago}`
}

function DeviceItem({
  device,
  self,
  connected,
  brainIndex,
  brainCount,
  readOnly,
  onRevoke,
}: {
  device: DeviceRow
  self: boolean
  connected: boolean
  brainIndex: number
  brainCount: number
  readOnly: boolean
  onRevoke: () => void
}): JSX.Element {
  const toggle = (role: DeviceRole): void => {
    const next = device.roles.includes(role) ? device.roles.filter((r) => r !== role) : [...device.roles, role]
    if (next.length === 0) {
      toast('A device needs at least one role.')
      return
    }
    void agent.devices.setRoles(device.id, next).catch((cause: unknown) => toast(message(cause, 'Could not change that.')))
  }
  const move = (direction: 'up' | 'down'): void => {
    void agent.devices.move(device.id, direction).catch((cause: unknown) => toast(message(cause, 'Could not move it.')))
  }
  return (
    <div className="rowc dv-row">
      <div className={`ri${connected || self ? ' ok' : ''}`}>
        <Icon name={KIND_ICON[device.kind]} size={22} />
      </div>
      <div className="rt">
        <b>{device.name}</b>
        <span>
          {KIND_LABEL[device.kind]}
          {brainIndex >= 0 ? `, answers ${brainIndex === 0 ? 'first' : `in turn ${brainIndex + 1}`}` : ''}. {seenLine(device, self, connected)}
        </span>
        <div className="dv-roles" role="group" aria-label={`What ${device.name} does`}>
          {(['screen', 'brain', 'hands'] as const).map((role) => {
            const on = device.roles.includes(role)
            return (
              <button
                key={role}
                type="button"
                className={`chip dv-role${on ? ' on' : ''}`}
                aria-pressed={on}
                title={self ? 'This computer always answers and acts as itself' : ROLE_HINT[role]}
                disabled={self || readOnly}
                onClick={() => toggle(role)}
              >
                {on ? <Icon name="check" size={14} /> : null}
                {ROLE_LABEL[role]}
              </button>
            )
          })}
        </div>
      </div>
      <div className="dv-acts">
        {self ? <Pill tone="pri">This one</Pill> : connected ? <Pill tone="ok">Connected</Pill> : null}
        {brainIndex >= 0 && brainCount > 1 && !readOnly ? (
          <span className="dv-order">
            <IconButton icon="chevd" label={`Move ${device.name} up`} className="dv-up" size={18} disabled={brainIndex === 0} onClick={() => move('up')} />
            <IconButton icon="chevd" label={`Move ${device.name} down`} size={18} disabled={brainIndex === brainCount - 1} onClick={() => move('down')} />
          </span>
        ) : null}
        {!self && !readOnly ? (
          <Button variant="text" size="sm" onClick={onRevoke}>
            Take out
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function DevicesSettings(): JSX.Element {
  const readOnly = agent.remote !== undefined
  const [status, setStatus] = useState<DevicesStatus | null>(null)
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [adding, setAdding] = useState(false)
  const [revoking, setRevoking] = useState<DeviceRow | null>(null)
  const [switching, setSwitching] = useState(false)
  const [address, setAddress] = useState('')

  const refresh = useCallback(() => {
    void agent.devices.status().then(setStatus).catch(() => undefined)
    void agent.devices.list().then(setDevices).catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()
    const off = agent.devices.onChanged(refresh)
    const offData = agent.data.onChanged((change) => {
      if (change.entity === 'device') refresh()
    })
    return () => {
      off()
      offData()
    }
  }, [refresh])

  const live = devices.filter((device) => !device.revoked)
  const brains = live.filter((device) => device.roles.includes('brain')).sort((a, b) => a.priority - b.priority)
  const connected = new Set(status?.connected ?? [])
  const enabled = status?.enabled ?? false

  const setEnabled = (on: boolean): void => {
    setSwitching(true)
    agent.devices
      .setEnabled(on)
      .then((next) => {
        setStatus(next)
        if (next.error !== '') toast(next.error)
      })
      .catch((cause: unknown) => toast(message(cause, 'Could not change that.')))
      .finally(() => setSwitching(false))
  }

  const addAddress = (): void => {
    const value = address.trim()
    if (value === '' || status === null) return
    agent.devices
      .setExtraUrls([...status.extraUrls, value])
      .then((next) => {
        if (next.extraUrls.length === status.extraUrls.length) toast('That does not look like an address. Try a name like my-computer.example.com.')
        else setAddress('')
        setStatus(next)
      })
      .catch((cause: unknown) => toast(message(cause, 'Could not add that address.')))
  }

  const removeAddress = (url: string): void => {
    if (status === null) return
    void agent.devices
      .setExtraUrls(status.extraUrls.filter((item) => item !== url))
      .then(setStatus)
      .catch(() => undefined)
  }

  const line = status === null
    ? 'Looking...'
    : status.error !== ''
      ? status.error
      : status.running
        ? `On. Your devices reach this computer on port ${status.port}.`
        : 'Off. No other device can reach this computer.'

  return (
    <section className="dv">
      <SectionHeader eyebrow="DEVICES" line="Your phone and other computers, one agent" />
      <div className="card" style={{ padding: 10 }}>
        {readOnly ? (
          <div className="rowc">
            <div className="ri ok">
              <Icon name="link" size={22} />
            </div>
            <div className="rt">
              <b>Linked to {agent.remote?.nodeName ?? 'your computer'}</b>
              <span>Add or take out devices on that computer, in Settings, Devices.</span>
            </div>
          </div>
        ) : (
          <div className="rowc">
            <div className={`ri${status?.running === true ? ' ok' : ''}`}>
              <Icon name="server" size={22} />
            </div>
            <div className="rt">
              <b>Let my other devices connect</b>
              <span className={status?.error ? 'dv-error-line' : undefined}>{line}</span>
            </div>
            <Switch on={enabled} label="Let my other devices connect" disabled={switching || status === null} onToggle={setEnabled} />
          </div>
        )}

        {enabled && !readOnly ? (
          <div className="dv-add">
            <Button variant="fill" size="sm" disabled={status?.running !== true} onClick={() => setAdding(true)}>
              <Icon name="plus" size={16} />
              Add a device
            </Button>
            {status !== null ? (
              <span className="small muted">
                Security words for this computer: <b className="dv-fp">{status.fpWords}</b>
              </span>
            ) : null}
          </div>
        ) : null}

        {live.length > 0 ? <div className="dv-sep" /> : null}
        {live.map((device) => (
          <DeviceItem
            key={device.id}
            device={device}
            self={device.id === status?.nodeId}
            connected={connected.has(device.id)}
            brainIndex={brains.findIndex((brain) => brain.id === device.id)}
            brainCount={brains.length}
            readOnly={readOnly}
            onRevoke={() => setRevoking(device)}
          />
        ))}

        {!readOnly && status !== null ? (
          <div className="dv-addresses">
            <span className="eyebrow mute">ADDRESSES THIS COMPUTER GIVES OUT</span>
            {status.urls.length === 0 ? (
              <p className="small muted">{enabled ? 'None found. Add the address your devices can reach.' : 'Shown when Devices is on.'}</p>
            ) : (
              <ul className="dv-urls">
                {status.urls.map((url) => (
                  <li key={url}>
                    <span>{url}</span>
                    {status.extraUrls.includes(url) ? (
                      <IconButton icon="x" label={`Remove ${url}`} size={16} onClick={() => removeAddress(url)} />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="dv-address-form"
              onSubmit={(event) => {
                event.preventDefault()
                addAddress()
              }}
            >
              <input
                className="input dv-input"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="Another address, like my-computer.example.com"
                aria-label="Another address for this computer"
                maxLength={300}
              />
              <Button variant="tonal" size="sm" type="submit" disabled={address.trim() === ''}>
                Add
              </Button>
            </form>
          </div>
        ) : null}
      </div>
      {adding ? <AddDeviceDialog known={live.map((device) => device.id)} onClose={() => setAdding(false)} /> : null}
      {revoking !== null ? <RevokeDialog device={revoking} onClose={() => setRevoking(null)} /> : null}
    </section>
  )
}
