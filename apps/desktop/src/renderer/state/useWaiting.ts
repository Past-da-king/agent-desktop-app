import type { ChatItem } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { chat } from '../bridge'
import { cardsForIds, openCards } from '../lib/cards'
import { useEntity } from './useData'

/**
 * The cards that are genuinely waiting, straight from `chat.state()`, so a card re-armed after a
 * restart still shows and an answered one disappears at once. Falls back to the rows themselves if
 * the main process cannot answer.
 */
export function useWaiting(forChat = false): ChatItem[] {
  const items = useEntity('chat_item')
  const [ids, setIds] = useState<string[] | null>(null)

  useEffect(() => {
    let alive = true
    const sync = (): void => {
      void chat
        .state()
        .then((state) => {
          if (alive) setIds(state.waiting)
        })
        .catch(() => {
          if (alive) setIds(null)
        })
    }
    sync()
    const off = chat.onEvent((event) => {
      if (
        event.type === 'needs_you' ||
        event.type === 'chat_changed' ||
        event.type === 'run_started' ||
        event.type === 'run_finished'
      ) {
        sync()
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return useMemo(
    () => (ids === null ? openCards(items, forChat) : cardsForIds(items, ids, forChat)),
    [items, ids, forChat],
  )
}
