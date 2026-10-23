import { MAIN_CHAT, type RouteTarget } from '@agent/core'
import { useEffect } from 'react'

import { agent } from '../bridge'
import { openChat, openHelper, startNewChat } from '../lib/chat-actions'
import { chatOf } from '../lib/chats'
import { useData } from './useData'
import { useUi } from './useUi'

/**
 * Opens the view the main process asked for (a notification, project_open, the agent's window.show), with its row
 * when it named one: the same moves the window's own taps make.
 */
export function routeTo(target: RouteTarget): void {
  const state = useUi.getState()
  state.closeOverlay()
  if (target.view === 'project') {
    if (target.id !== '') state.navigate({ page: 'project', id: target.id })
    return
  }
  if (target.view === 'chat') {
    // The id is a chat, or (a clicked "needs you" notification) a card in one: that card's chat opens.
    const row = target.id === '' ? undefined : useData.getState().rows.chat_item.find((item) => item.id === target.id)
    openChat(row !== undefined ? chatOf(row) : target.id === '' ? MAIN_CHAT : target.id)
    return
  }
  if (target.view === 'helper') {
    if (target.id !== '') openHelper(target.id)
    return
  }
  if (target.view === 'back') {
    state.goBack()
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
      if (event.code === 'Space' && event.ctrlKey && event.shiftKey && !onboarding && agent.platform === 'web' && agent.remote === undefined) {
        event.preventDefault()
        state.openQuick()
        return
      }
      // Alt+Left, as in every browser: back to where the person was (the title bar's Back).
      if (event.altKey && !mod && event.key === 'ArrowLeft' && !onboarding) {
        if (state.goBack()) event.preventDefault()
        return
      }
      if (event.key === 'Escape' && state.overlay !== null) {
        state.closeOverlay()
      }
    }
    // The mouse's own back button.
    const onMouse = (event: MouseEvent): void => {
      if (event.button !== 3 || useUi.getState().route.page === 'onboarding') return
      if (useUi.getState().goBack()) event.preventDefault()
    }

    document.addEventListener('keydown', onKey)
    document.addEventListener('mouseup', onMouse)
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
      document.removeEventListener('mouseup', onMouse)
      offQuick()
      offRoute()
    }
  }, [])
}
