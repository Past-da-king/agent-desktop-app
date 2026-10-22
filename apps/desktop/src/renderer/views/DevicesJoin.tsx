/**
 * Settings > Devices > Join with a link: this computer joins the person's devices from a pairing link another node
 * made (its Add a device, or `agent-node offer` on a server). The other side of Add a device, for a computer.
 */
import { useState } from 'react'

import { agent } from '../bridge'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'

function message(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback
}

export function JoinRow(): JSX.Element {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState('')
  const [bad, setBad] = useState(false)
  const clean = link.trim()
  const valid = clean.startsWith('agent://pair?')

  const join = (): void => {
    if (!valid || busy) return
    setBusy(true)
    setLine('Joining...')
    setBad(false)
    agent.devices
      .join(clean)
      .then((done) => {
        setLink('')
        setLine(`Joined ${done.node.name || done.node.id}. This computer now keeps in step with it.`)
      })
      .catch((cause: unknown) => {
        const text = message(cause, 'Could not join.')
        setLine(text)
        setBad(true)
        toast(text)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="dv-net dv-join">
      <span className="eyebrow mute">JOIN WITH A LINK</span>
      <form
        className="dv-address-form"
        onSubmit={(event) => {
          event.preventDefault()
          join()
        }}
      >
        <input
          className="input dv-input"
          autoComplete="off"
          spellCheck={false}
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="agent://pair?... from another computer or a server"
          aria-label="Pairing link"
          maxLength={4000}
        />
        <Button variant="tonal" size="sm" type="submit" disabled={busy || !valid}>
          {busy ? 'Joining...' : 'Join'}
        </Button>
      </form>
      <p className={`small ${bad ? 'dv-error' : 'muted'}`}>
        {line !== '' ? line : 'Made on the other device with Add a device (or agent-node offer on a server). Good for 10 minutes, once.'}
      </p>
    </div>
  )
}
