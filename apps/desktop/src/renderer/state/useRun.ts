import type { ChatItem } from '@agent/core'
import { useEffect } from 'react'

import { metaText, parseMeta } from '../lib/meta'
import { startChatTracking, useAnyRunning } from './useChats'

export interface RunInfo {
  running: boolean
  /** The latest tool step while a run is active. */
  activity: string
}

/**
 * Whether the agent is working right now, and what it is doing. Chat owns its own copy of this for
 * the thread; Home needs the same truth to say "working now" instead of the last completed thing.
 */
export function useRunInfo(items: ChatItem[]): RunInfo {
  // Any chat working counts: several chats run at once now (state/useChats.ts tracks them all).
  useEffect(() => startChatTracking(), [])
  const running = useAnyRunning()

  const activity =
    [...items]
      .filter((item) => item.kind === 'activity')
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((item) => metaText(parseMeta(item.meta), 'summary') || item.text)[0] ?? ''

  return { running, activity }
}

/** The last piece of written work the agent finished, for the idle Home hero. */
export function lastAgentWork(items: ChatItem[]): ChatItem | null {
  const written = items
    .filter((item) => item.kind === 'agent' || item.kind === 'report')
    .sort((a, b) => b.createdAt - a.createdAt)
  return written[0] ?? null
}
