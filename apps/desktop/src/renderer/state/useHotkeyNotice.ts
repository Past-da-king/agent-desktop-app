import { useEffect } from 'react'

import { agent } from '../bridge'
import { toast } from './useToast'
import { useUi } from './useUi'

let shown = false

/** Opens Settings and brings the shortcut rows into view. */
export function openShortcutSettings(): void {
  useUi.getState().navigate({ page: 'settings' })
  window.setTimeout(() => document.getElementById('shortcuts')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 350)
}

/**
 * Once per launch, a quiet note when a dictation shortcut is held by another app, with a way to the rows that
 * explain it. It waits a moment so the main process can name the app that holds it.
 */
export function useHotkeyNotice(delayMs = 3000): void {
  useEffect(() => {
    if (shown) return
    const timer = window.setTimeout(() => {
      void agent.hotkeys
        .status()
        .then((statuses) => {
          if (shown) return
          const blocked = statuses.find(
            (status) => !status.ok && (status.action === 'dictate' || status.action === 'dictateClean') && status.accelerator !== '' && !/already your/.test(status.message),
          )
          if (blocked === undefined) return
          shown = true
          // The first sentence says who has the keys; Settings has the rest.
          const first = blocked.message.split('. ')[0] ?? blocked.message
          toast(`Dictation is not on yet. ${first.replace(/\.$/, '')}.`, { actionLabel: 'Open Settings', onAction: openShortcutSettings })
        })
        .catch(() => undefined)
    }, delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs])
}
