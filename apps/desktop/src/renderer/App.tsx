import { Suspense, lazy, useEffect, useState, type ReactNode } from 'react'

import { useGlobalKeys } from './state/keys'
import { useHotkeyNotice } from './state/useHotkeyNotice'
import { lastView, parseHash, type Route } from './state/route'
import { useSettings } from './state/useSettings'
import { useRoute, useUi } from './state/useUi'
import { Chat } from './views/Chat'
import { Skeleton } from './ui/Skeleton'
import { Mascot } from './ui/Mascot'
import { readBootHint, writeBootHint } from './lib/boot-hint'
import { applyAccent, applyTheme } from './state/theme'
import { useData } from './state/useData'

// Screens off the chat load when first opened, so the chat is on screen sooner; each is one small file on disk.
const Onboarding = lazy(() => import('./onboarding/Onboarding').then((m) => ({ default: m.Onboarding })))
const Connections = lazy(() => import('./views/Connections').then((m) => ({ default: m.Connections })))
const Memory = lazy(() => import('./views/Memory').then((m) => ({ default: m.Memory })))
const Routines = lazy(() => import('./views/Routines').then((m) => ({ default: m.Routines })))
const Settings = lazy(() => import('./views/Settings').then((m) => ({ default: m.Settings })))
const Tasks = lazy(() => import('./views/Tasks').then((m) => ({ default: m.Tasks })))

/** A screen still loading from disk shows its bones, never a blank sheet. */
function Loading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Suspense
      fallback={
        <div className="sheet-wait">
          <Skeleton rows={6} />
        </div>
      }
    >
      {children}
    </Suspense>
  )
}
import { Home } from './views/Home'
import { Project } from './views/Project'
import { BrowserStage, ChatPanel, HelperFloat } from './shell/Panel'
import { Palette } from './shell/Palette'
import { QuickAsk } from './shell/QuickAsk'
import { QuickWindow } from './shell/QuickWindow'
import { DictationPill } from './dictation/DictationPill'
import { Shell } from './shell/Shell'
import { TitleBar } from './shell/TitleBar'
import { TipLayer } from './ui/TipLayer'
import { Toasts } from './ui/Toasts'

function Page(): JSX.Element {
  const route = useRoute()
  switch (route.page) {
    case 'chat':
      return (
        <Shell panel={<ChatPanel />} ownScroll>
          <Chat />
        </Shell>
      )
    case 'tasks':
      return (
        <Shell>
          <Loading>
            <Tasks />
          </Loading>
        </Shell>
      )
    case 'memory':
      return (
        <Shell>
          <Loading>
            <Memory />
          </Loading>
        </Shell>
      )
    case 'routines':
      return (
        <Shell>
          <Loading>
            <Routines />
          </Loading>
        </Shell>
      )
    case 'connections':
      return (
        <Shell>
          <Loading>
            <Connections />
          </Loading>
        </Shell>
      )
    case 'settings':
      return (
        <Shell>
          <Loading>
            <Settings />
          </Loading>
        </Shell>
      )
    case 'project':
      // The side panel stays on a project's page: what needs the person, its helpers and the browser.
      return (
        <Shell panel={<ChatPanel />}>
          <Project id={route.id} />
        </Shell>
      )
    case 'quick-window':
      return <QuickWindow />
    case 'home':
    default:
      return (
        <Shell>
          <Home />
        </Shell>
      )
  }
}

/** The main window: title bar, shell, overlays and the keyboard shortcuts that belong to it. */
function Main({ route }: { route: Route }): JSX.Element {
  useGlobalKeys()
  useHotkeyNotice()
  const onboarding = route.page === 'onboarding'

  return (
    <div className="win">
      <TitleBar onboarding={onboarding} />
      <div className="stage">{onboarding ? <Loading><Onboarding step={route.step} /></Loading> : <Page />}</div>
      {onboarding ? null : <BrowserStage />}
      {onboarding ? null : <HelperFloat />}
      <div className="overlay">
        <Palette />
        <QuickAsk />
      </div>
      <Toasts />
      <TipLayer />
    </div>
  )
}

export function App(): JSX.Element {
  const settingsReady = useSettings((state) => state.ready)
  const rowsReady = useData((state) => state.loaded.chat_item)
  const load = useSettings((state) => state.load)
  const route = useRoute()
  // Settings and the chat rows are asked for together at boot, so the first screen is drawn once, with both.
  const ready = settingsReady && rowsReady
  // The last run's look, so the first frame is already the person's: their theme, accent, mascot and agent name.
  const [hint] = useState(() => {
    const found = readBootHint()
    if (found !== null) {
      applyTheme(found.theme)
      applyAccent(found.accent)
    }
    return found
  })
  useEffect(() => {
    if (!settingsReady) return
    const settings = useSettings.getState().settings
    if (settings !== null) writeBootHint(settings)
  }, [settingsReady])

  useEffect(() => {
    void load()
    void useData.getState().load('chat_item')
  }, [load])

  useEffect(() => {
    const onHash = (): void => useUi.getState().applyHash(window.location.hash)
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!ready) return
    const settings = useSettings.getState().settings
    const parsed = parseHash(window.location.hash)
    if (parsed?.page === 'quick-window' || parsed?.page === 'dictation') {
      useUi.getState().applyHash(window.location.hash)
      return
    }
    if (!settings?.onboarded) {
      const step = parsed?.page === 'onboarding' ? parsed.step : 'signin'
      useUi.getState().navigate({ page: 'onboarding', step }, { replace: true })
      return
    }
    if (parsed && parsed.page !== 'onboarding') {
      useUi.getState().navigate(parsed, { replace: true })
      return
    }
    useUi.getState().navigate({ page: lastView() }, { replace: true })
  }, [ready])

  // The small windows know what they are from their address, before settings have loaded.
  const own = parseHash(window.location.hash)?.page
  if (route.page === 'dictation' || own === 'dictation') {
    return <DictationPill />
  }
  if (route.page === 'quick-window' || own === 'quick-window') {
    return <QuickWindow />
  }

  if (!ready) {
    return (
      <div className="win">
        <TitleBar onboarding />
        <div className="stage">
          <div className="boot">
            {hint === null ? (
              <div className="boot-wordmark">Agent</div>
            ) : (
              <div className="boot-card">
                <Mascot id={hint.mascot} size={72} busy />
                <div className="boot-name">{hint.agentName.trim() || 'Agent'}</div>
                <div className="boot-line">Starting</div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return <Main route={route} />
}
