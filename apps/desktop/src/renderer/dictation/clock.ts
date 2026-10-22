import type { DictationView } from '@agent/core'
import { useEffect, useState } from 'react'

/** A running clock: "0:07" while listening, "7s" while the words are worked out. */
export function clock(ms: number, phase: DictationView['phase']): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (phase === 'listening' || phase === 'starting') return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return `${seconds}s`
}

/** Ticks while a phase with a counter is showing, so the seconds move. */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [active])
  return now
}
