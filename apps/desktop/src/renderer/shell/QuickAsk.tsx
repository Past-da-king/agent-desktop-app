import { useEffect, useState } from 'react'

import { chat } from '../bridge'
import { orTell } from '../lib/tell'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Kbd } from '../ui/bits'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'

export function QuickAsk(): JSX.Element | null {
  const overlay = useUi((state) => state.overlay)
  const close = useUi((state) => state.closeOverlay)
  const navigate = useUi((state) => state.navigate)
  const settings = useSettings((state) => state.settings)
  const [text, setText] = useState('')

  const open = overlay === 'quick'

  useEffect(() => {
    if (open) setText('')
  }, [open])

  if (!open) return null

  const agentName = settings?.agentName.trim() || 'your agent'

  const send = (): void => {
    const value = text.trim()
    if (value === '') return
    close()
    void orTell(chat.send(value), 'Your message could not be sent. Try again.')
    navigate({ page: 'chat' })
  }

  return (
    <Dialog label="Quick ask" surface="quick" onClose={close}>
      <div className="row">
        <Mascot id={settings?.mascot ?? 'scout'} size={44} busy />
        <input
          placeholder={`Ask ${agentName} anything`}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              send()
            }
          }}
          autoComplete="off"
          aria-label={`Ask ${agentName}`}
        />
        <button type="button" className="send" onClick={send} aria-label="Send" title="Send" disabled={text.trim() === ''}>
          <Icon name="arrow" size={22} />
        </button>
      </div>
      <div className="ctx">
        <span className="eyebrow mute">USING</span>
        {/* Facts, not controls: plain labels, so nothing here looks pressable and does nothing. */}
        <span className="quick-fact">
          <Icon name="bolt" size={14} />
          {settings?.model.trim() || 'Your AI'}
        </span>
        <span className="quick-fact">
          <Icon name="monitor" size={14} />
          This computer
        </span>
        <span className="quick-keys">
          <Kbd>Enter</Kbd> send <span aria-hidden="true">·</span> <Kbd>Esc</Kbd> close
        </span>
      </div>
    </Dialog>
  )
}
