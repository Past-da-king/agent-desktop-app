/**
 * Settings > Devices > Network (docs/devices-protocol.md s10): None, Tailscale or the person's own Headscale, with an
 * auth key. Optional: with None, devices reach this computer on the local network or at an address typed above.
 * The key goes straight to the main process (secrets module); the window only learns whether one is saved.
 */
import type { DevicesStatus, NetworkMode } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
}

export function NetworkRow({ status, onStatus }: { status: DevicesStatus; onStatus: (next: DevicesStatus) => void }): JSX.Element | null {
  const net = status.network
  const [mode, setMode] = useState<NetworkMode>(net?.mode ?? 'none')
  const [url, setUrl] = useState(net?.controlUrl ?? '')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

  // Follow the saved choice when it changes elsewhere (another window, the headless CLI).
  useEffect(() => {
    if (net !== undefined) {
      setMode(net.mode)
      setUrl(net.controlUrl)
    }
  }, [net?.mode, net?.controlUrl])

  if (net === undefined) return null

  const save = (next: NetworkMode): void => {
    setBusy(true)
    agent.devices
      .setNetwork({ mode: next, controlUrl: next === 'headscale' ? url.trim() : undefined, authKey: key.trim() === '' ? undefined : key.trim() })
      .then((saved) => {
        setKey('')
        onStatus(saved)
      })
      .catch((cause: unknown) => toast(message(cause, 'Could not change the network.')))
      .finally(() => setBusy(false))
  }

  const pick = (next: NetworkMode): void => {
    setMode(next)
    // Off is one tap. Tailscale with a key already saved is one tap too; otherwise the key field asks first.
    if (next === 'none' && net.mode !== 'none') save('none')
    else if (next === 'tailscale' && net.hasKey && net.mode !== 'tailscale') save('tailscale')
  }

  const dirty = mode !== net.mode || key.trim() !== '' || (mode === 'headscale' && url.trim() !== net.controlUrl)
  const canSave = mode !== 'none' && (key.trim() !== '' || net.hasKey) && (mode !== 'headscale' || url.trim() !== '')

  let line: string
  let bad = false
  if (mode !== net.mode) line = mode === 'none' ? '' : 'Paste an auth key from your admin console, then Save.'
  else if (net.mode === 'none') line = 'Devices find this computer on your local network or at an address you add.'
  else if (net.state === 'error') {
    line = net.error
    bad = true
  } else if (net.state === 'off') line = 'Starts when Let my other devices connect is on.'
  else if (net.state === 'starting') line = 'Joining the network...'
  else if (net.state === 'needs-login') line = net.hasKey ? 'The network did not accept the key. Paste a new one.' : 'Needs an auth key, or a sign-in.'
  else {
    const where = net.dnsName !== '' ? net.dnsName : (net.addresses[0] ?? '')
    line = `Joined as ${where}. ${net.peers === 1 ? '1 other machine' : `${net.peers} other machines`} on it.`
  }

  return (
    <div className="dv-net">
      <span className="eyebrow mute">NETWORK</span>
      <Segmented<NetworkMode>
        ariaLabel="Network"
        value={mode}
        onChange={pick}
        options={[
          { value: 'none', label: 'None' },
          { value: 'tailscale', label: 'Tailscale' },
          { value: 'headscale', label: 'Headscale' },
        ]}
      />
      {mode !== 'none' ? (
        <form
          className="dv-net-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSave && dirty) save(mode)
          }}
        >
          {mode === 'headscale' ? (
            <input
              className="input dv-input"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="Your Headscale address, like https://headscale.example.com"
              aria-label="Headscale address"
              maxLength={300}
            />
          ) : null}
          <div className="dv-address-form">
            <input
              className="input dv-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={net.hasKey ? 'Auth key saved (paste to replace)' : 'Auth key'}
              aria-label="Auth key"
              maxLength={500}
            />
            <Button variant="tonal" size="sm" type="submit" disabled={busy || !canSave || !dirty}>
              Save
            </Button>
          </div>
        </form>
      ) : null}
      {line !== '' ? (
        <p className={`small ${bad ? 'dv-error' : 'muted'}`}>
          {line}
          {net.state === 'needs-login' && net.authUrl !== '' && mode === net.mode ? (
            <>
              {' '}
              <button type="button" className="linkish" onClick={() => void agent.shell.openExternal(net.authUrl)}>
                Sign in
              </button>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  )
}
