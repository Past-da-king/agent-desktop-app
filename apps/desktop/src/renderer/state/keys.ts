import { useEffect } from 'react'

import { agent } from '../bridge'
import { startNewChat } from '../lib/chat-actions'
import { useUi } from './useUi'

/** Ctrl/Cmd+K, Ctrl/Cmd+N, Ctrl/Cmd+, and the browser stand-in for the Quick Ask hotkey. */
export function useGlobalKeys(): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const state = useUi.getState()
      const onboarding = state.route.page === 'onboarding'
      const mod = event.ctrlKey || event.metaKey

      if (mod && event.key.toLowerCase() === 'k' && !onboarding) {
        event.preventDefault()
        state.openPalette()
        return
      }
      if (mod && event.key.toLowerCase() === 'n' && !onboarding) {
        event.preventDefault()
        void startNewChat()
        return
      }
      if (mod && event.key === ',' && !onboarding) {
        event.preventDefault()
        state.navigate({ page: 'settings' })
        return
      }
      if (event.code === 'Space' && event.ctrlKey && event.shiftKey && !onboarding && agent.platform === 'web') {
        event.preventDefault()
        state.openQuick()
        return
      }
      if (event.key === 'Escape' && state.overlay !== null) {
        state.closeOverlay()
      }
    }

    document.addEventListener('keydown', onKey)
    const offQuick = agent.window.onQuickAsk(() => {
      if (useUi.getState().route.page !== 'onboarding') useUi.getState().openQuick()
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      offQuick()
    }
  }, [])
}
