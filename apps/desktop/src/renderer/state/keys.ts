import type { RouteTarget } from '@agent/core'
import { useEffect } from 'react'

import { agent } from '../bridge'
import { startNewChat } from '../lib/chat-actions'
import { useUi } from './useUi'

/** Opens the view the main process asked for, with its row when it named one. */
export function routeTo(target: RouteTarget): void {
  const state = useUi.getState()
  state.closeOverlay()
  if (target.view === 'project') {
    if (target.id !== '') state.navigate({ page: 'project', id: target.id })
    return
  }
  if (target.view === 'tasks' && target.id !== '') state.selectTask(target.id)
  if (target.view === 'memory' && target.id !== '') state.selectMemory(target.id)
  state.navigate({ page: target.view })
}

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
    // The main process asks for a view: the agent's project_open, or a clicked notification.
    const offRoute = agent.window.onRoute((target) => {
      const state = useUi.getState()
      const page = state.route.page
      if (page === 'onboarding' || page === 'quick-window' || page === 'dictation') return
      routeTo(target)
    })
    return () => {
      document.removeEventListener('keydown', onKey)
      offQuick()
      offRoute()
    }
  }, [])
}
