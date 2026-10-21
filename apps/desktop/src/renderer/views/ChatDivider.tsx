import type { ChatItem } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { dividerNote, noteLine } from '../lib/chat-memory'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Icon } from '../ui/Icon'

/**
 * A New chat divider, with a small quiet note under it while the chat before it is saved into memory: it opens the
 * saved pages, or offers Retry when saving failed.
 */
export function ChatDivider({ item }: { item: ChatItem }): JSX.Element {
  const note = dividerNote(item)
  const showMemories = useUi((state) => state.showMemories)
  const [retrying, setRetrying] = useState(false)

  const retry = (): void => {
    setRetrying(true)
    void agent.memory
      .retrySave(item.id)
      .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not try again.'))
      .finally(() => setRetrying(false))
  }

  return (
    <div className="chat-divider">
      <div className="divider" role="separator">
        <span>{item.text || 'New chat'}</span>
      </div>
      {note === null ? null : note.status === 'done' && note.saved.length > 0 ? (
        <button type="button" className="mem-note" onClick={() => showMemories(note.saved)}>
          <Icon name="memory" size={14} />
          <span>{noteLine(note)}</span>
          <Icon name="chev" size={14} />
        </button>
      ) : note.status === 'failed' ? (
        <div className="mem-note fail" title={note.error}>
          <Icon name="memory" size={14} />
          <span>{noteLine(note)}</span>
          <button type="button" className="mem-note-act" onClick={retry} disabled={retrying}>
            {retrying ? 'Trying...' : 'Retry'}
          </button>
        </div>
      ) : (
        <div className="mem-note quiet" aria-live="polite">
          <Icon name="memory" size={14} />
          <span>
            {noteLine(note)}
            {note.status === 'saving' ? '...' : ''}
          </span>
        </div>
      )}
    </div>
  )
}

/** The small control above a fresh chat that brings the older ones back on screen. */
export function EarlierChats({ count, onShow }: { count: number; onShow: () => void }): JSX.Element | null {
  if (count === 0) return null
  return (
    <div className="earlier-chats">
      <button type="button" className="chip" onClick={onShow}>
        <Icon name="chevd" size={16} />
        Show earlier chats
      </button>
    </div>
  )
}
