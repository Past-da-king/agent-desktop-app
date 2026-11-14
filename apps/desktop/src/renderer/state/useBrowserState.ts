import type { BrowserState } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { workspaceLayout, type WorkspaceLayout } from '../lib/workspace'
import { useWorkspace } from './useWorkspace'

/** The main process pushes a fresh BrowserState on every change it notices. */
export function useBrowserState(): BrowserState | null {
  const [state, setState] = useState<BrowserState | null>(null)

  useEffect(() => {
    let alive = true
    void agent.browser
      .state()
      .then((next) => {
        if (alive) setState(next)
      })
      .catch(() => undefined)
    const off = agent.browser.onState((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      off()
    }
  }, [])

  return state
}

/** The window's width, followed as it changes: the workspace layout depends on it. */
export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth))
  useEffect(() => {
    const change = (): void => setWidth(window.innerWidth)
    change()
    window.addEventListener('resize', change)
    return () => window.removeEventListener('resize', change)
  }, [])
  return width
}

/** The browser view's layout right now: the title bar, the docked chat and the tab strip (lib/workspace.ts). */
export function useWorkspaceLayout(state: BrowserState | null): WorkspaceLayout {
  const dockOpen = useWorkspace((store) => store.dockOpen)
  const dockWidth = useWorkspace((store) => store.dockWidth)
  const windowWidth = useWindowWidth()
  const tabs = state?.tabs.length ?? 0
  return workspaceLayout({
    expanded: state?.expanded === true,
    hasPage: tabs > 0,
    fullScreen: state?.fullScreen === true,
    dockOpen,
    dockWidth,
    windowWidth,
    tabs,
  })
}
