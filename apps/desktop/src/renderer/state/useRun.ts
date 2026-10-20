import type { ChatEvent, ChatItem } from '@agent/core'
import { useEffect, useState } from 'react'

import { chat } from '../bridge'
import { metaText, parseMeta } from '../lib/meta'

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
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let alive = true
    void chat.state().then((state) => {
      if (alive) setRunning(state.running)
    })
    const off = chat.onEvent((event: ChatEvent) => {
      if (event.type === 'run_started') setRunning(true)
      if (event.type === 'run_finished') setRunning(false)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

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
