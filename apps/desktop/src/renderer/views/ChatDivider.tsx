import type { ChatItem } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { parseMeta } from '../lib/meta'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Icon } from '../ui/Icon'

interface Note {
  status: 'saving' | 'done' | 'failed'
  saved: string[]
  error: string
}

/** The filing note a New chat divider carries (main/memory/service.ts), or null for a plain divider. */
export function dividerNote(item: ChatItem): Note | null {
  const value = parseMeta(item.meta)['memory']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const note = value as Record<string, unknown>
  const status = note['status']
  if (status !== 'saving' && status !== 'done' && status !== 'failed') return null
  return {
    status,
    saved: Array.isArray(note['saved']) ? note['saved'].filter((id): id is string => typeof id === 'string') : [],
    error: typeof note['error'] === 'string' ? note['error'] : '',
  }
}

/** The words on the note. Exported for tests. */
export function noteLine(note: Note): string {
  if (note.status === 'saving') return 'Saving the last chat to memory'
  if (note.status === 'failed') return 'Could not save the last chat to memory'
  const count = note.saved.length
  if (count === 0) return 'Nothing in the last chat needed remembering'
  return `Saved ${count} ${count === 1 ? 'memory' : 'memories'} from the last chat`
}

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
