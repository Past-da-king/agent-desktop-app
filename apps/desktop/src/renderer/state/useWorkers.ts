import type { WorkerInfo } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'

/** The background workers, read again whenever the main process says something about them changed. */
export function useWorkers(): { workers: WorkerInfo[]; loaded: boolean; reload: () => void } {
  const [workers, setWorkers] = useState<WorkerInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    const read = (): void => {
      void agent.workers
        .list()
        .then((list) => {
          if (!alive) return
          setWorkers(list)
          setLoaded(true)
        })
        .catch(() => {
          if (alive) setLoaded(true)
        })
    }
    read()
    const off = agent.workers.onChange(read)
    // Uptime and "last line" move on their own; a slow refresh keeps them honest.
    const timer = window.setInterval(read, 20_000)
    return () => {
      alive = false
      off()
      window.clearInterval(timer)
    }
  }, [tick])

  return { workers, loaded, reload: () => setTick((n) => n + 1) }
}
