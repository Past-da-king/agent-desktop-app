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

  // One pass for the newest step: Home redraws on every row change, and a long-used install has thousands of steps.
  const step = newest(items, (item) => item.kind === 'activity')
  const activity = step === null ? '' : metaText(parseMeta(step.meta), 'summary') || step.text

  return { running, activity }
}

/** The newest row that matches (the first listed of those made at the same moment), without sorting the list. */
function newest(items: readonly ChatItem[], match: (item: ChatItem) => boolean): ChatItem | null {
  let best: ChatItem | null = null
  for (const item of items) if (match(item) && (best === null || item.createdAt > best.createdAt)) best = item
  return best
}

/** The last piece of written work the agent finished, for the idle Home hero. */
export function lastAgentWork(items: ChatItem[]): ChatItem | null {
  return newest(items, (item) => item.kind === 'agent' || item.kind === 'report')
}
