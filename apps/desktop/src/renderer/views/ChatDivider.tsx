import type { ChatItem } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { dividerNote, noteLine } from '../lib/chat-memory'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { parseMeta } from '../lib/meta'
import { Icon } from '../ui/Icon'
import { Markdown } from '../ui/Markdown'

/**
 * A New chat divider, with a small quiet note under it while the chat before it is saved into memory: it opens the
 * saved pages, or offers Retry when saving failed.
 */
export function ChatDivider({ item }: { item: ChatItem }): JSX.Element {
  const note = dividerNote(item)
  const meta = parseMeta(item.meta)
  // The main thread's New chat: the conversation carried on with a summary of itself (memory/service.ts).
  const compress = typeof meta['compress'] === 'string' ? meta['compress'] : ''
  const carry = typeof meta['carry'] === 'string' ? meta['carry'] : ''
  const [showCarry, setShowCarry] = useState(false)
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
        <span>{compress === '' ? item.text || 'New chat' : 'Fresh start'}</span>
      </div>
      {compress === '' ? null : compress === 'pending' ? (
        <div className="mem-note quiet" aria-live="polite">
          <Icon name="doc" size={14} />
          <span>Summing up the conversation so far...</span>
        </div>
      ) : (
        <button type="button" className="mem-note" aria-expanded={showCarry} onClick={() => setShowCarry(!showCarry)} disabled={carry === ''}>
          <Icon name="doc" size={14} />
          <span>{carry === '' ? 'Carried on with the last few messages' : 'Carried on with a summary of the conversation'}</span>
          {carry === '' ? null : <Icon name={showCarry ? 'chevd' : 'chev'} size={14} />}
        </button>
      )}
      {showCarry && carry !== '' ? (
        <div className="carry">
          <Markdown text={carry} />
        </div>
      ) : null}
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
