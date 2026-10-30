import { agent } from '../bridge'
import { copyText } from '../lib/copy'
import { useDrafts } from '../state/useDrafts'
import { toast } from '../state/useToast'
import { Icon } from '../ui/Icon'
import { refreshUndelivered, useDictationStore } from './dictationBox'

const SHOWN = 3

/**
 * A finished recording that never reached a message box stays here, by the box, until it is put in or put away, also
 * after a restart. Insert adds it to this chat's box.
 */
export function RecoverChips({ chat }: { chat: string }): JSX.Element | null {
  const list = useDictationStore((state) => state.undelivered)
  if (list.length === 0) return null
  const keepFocus = (event: { preventDefault: () => void }): void => event.preventDefault()
  const settle = (id: string, how: 'confirmed' | 'dismissed'): void => {
    void agent.dictation
      .settle(id, how)
      .catch(() => undefined)
      .finally(() => void refreshUndelivered())
  }
  // This chat's own first, then the newest.
  const sorted = [...list].sort((a, b) => Number(b.chat === chat) - Number(a.chat === chat) || b.startedAt - a.startedAt)
  return (
    <>
      {sorted.slice(0, SHOWN).map((item) => (
        <div key={item.id} className="dictation-draft recover-chip" role="status" data-testid="recover-chip" data-recording={item.id}>
          <span className="dd-words">
            <strong>Recording not added</strong>
            {item.chat !== chat && item.chat !== null ? ' (from another chat)' : ''}: <span className="dd-guess">{item.text.length > 90 ? `${item.text.slice(0, 87)}...` : item.text}</span>
          </span>
          <button
            type="button"
            className="dd-btn primary"
            onMouseDown={keepFocus}
            onClick={() => {
              if (useDrafts.getState().addWords(chat, item.text, item.id)) settle(item.id, 'confirmed')
              else toast('Could not add it. Copy it instead.')
            }}
          >
            Insert
          </button>
          <button
            type="button"
            className="dd-btn"
            onMouseDown={keepFocus}
            onClick={() => {
              void copyText(item.text).then((ok) => toast(ok ? 'Copied.' : 'Could not copy it.'))
            }}
          >
            Copy
          </button>
          <button type="button" className="dd-btn" aria-label="Put this recording away (it stays in Recordings)" title="Put away (it stays in Recordings)" onMouseDown={keepFocus} onClick={() => settle(item.id, 'dismissed')}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </>
  )
}
