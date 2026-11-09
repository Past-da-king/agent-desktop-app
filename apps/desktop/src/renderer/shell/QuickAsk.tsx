import { useEffect, useState } from 'react'

import { chat } from '../bridge'
import { currentChat } from '../lib/current-chat'
import { useDrafts } from '../state/useDrafts'
import { toast } from '../state/useToast'
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
    close()
    if (value === '') return
    const sentTo = currentChat()
    chat.send(value, [], sentTo).catch(() => {
      // It did not go: the words wait in that chat's box instead of vanishing.
      useDrafts.getState().addWords(sentTo, value)
      toast('That message did not go. It is in the chat box.')
    })
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
        <button type="button" className="send" onClick={send} aria-label="Send">
          <Icon name="arrow" size={22} />
        </button>
      </div>
      <div className="ctx">
        <span className="eyebrow mute">USING</span>
        {/* Facts, not controls: plain labels, so nothing here looks pressable and does nothing. */}
        <span className="chip on ctx-fact">
          <Icon name="bolt" size={14} />
          <span className="chip-t">{settings?.model.trim() || 'Your provider'}</span>
        </span>
        <span className="chip ctx-fact">
          <Icon name="monitor" size={14} />
          <span className="chip-t">This computer</span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Kbd>Enter</Kbd> send <span aria-hidden="true">·</span> <Kbd>Esc</Kbd> close
        </span>
      </div>
    </Dialog>
  )
}
