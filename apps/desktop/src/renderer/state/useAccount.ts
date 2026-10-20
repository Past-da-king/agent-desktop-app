import type { SyncStatus } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'

const EMPTY: SyncStatus = {
  signedIn: false,
  syncing: false,
  lastSyncedAt: null,
  error: null,
  pendingPush: 0,
}

export function useAccountStatus(): SyncStatus {
  const [status, setStatus] = useState<SyncStatus>(EMPTY)

  useEffect(() => {
    let live = true
    const off = agent.account.onStatus((next) => {
      if (live) setStatus(next)
    })
    void agent.account
      .status()
      .then((next) => {
        if (live) setStatus(next)
      })
      .catch(() => {
        if (live) setStatus(EMPTY)
      })
    return () => {
      live = false
      off()
    }
  }, [])

  return status
}
