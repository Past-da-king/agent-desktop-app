import { useEffect } from 'react'

import { Onboarding } from './onboarding/Onboarding'
import { useGlobalKeys } from './state/keys'
import { savedStep } from './state/onboarding'
import { lastView, parseHash } from './state/route'
import { useSettings } from './state/useSettings'
import { useRoute, useUi } from './state/useUi'
import { Chat, ChatPanel } from './views/Chat'
import { Connections } from './views/Connections'
import { Home } from './views/Home'
import { Memory } from './views/Memory'
import { Routines } from './views/Routines'
import { Settings } from './views/Settings'
import { Tasks } from './views/Tasks'
import { Palette } from './shell/Palette'
import { QuickAsk } from './shell/QuickAsk'
import { Shell } from './shell/Shell'
import { TitleBar } from './shell/TitleBar'

function Page(): JSX.Element {
  const route = useRoute()
  switch (route.page) {
    case 'chat':
      return (
        <Shell panel={<ChatPanel />}>
          <Chat />
        </Shell>
      )
    case 'tasks':
      return (
        <Shell>
          <Tasks />
        </Shell>
      )
    case 'memory':
      return (
        <Shell>
          <Memory />
        </Shell>
      )
    case 'routines':
      return (
        <Shell>
          <Routines />
        </Shell>
      )
    case 'connections':
      return (
        <Shell>
          <Connections />
        </Shell>
      )
    case 'settings':
      return (
        <Shell>
          <Settings />
        </Shell>
      )
    case 'home':
    default:
      return (
        <Shell>
          <Home />
        </Shell>
      )
  }
}

export function App(): JSX.Element {
  const ready = useSettings((state) => state.ready)
  const load = useSettings((state) => state.load)
  const route = useRoute()

  useGlobalKeys()

  useEffect(() => {
    void load()
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
    if (!settings?.onboarded) {
      const step = parsed?.page === 'onboarding' ? parsed.step : (savedStep() ?? 'signin')
      useUi.getState().navigate({ page: 'onboarding', step })
      return
    }
    if (parsed && parsed.page !== 'onboarding') {
      useUi.getState().navigate(parsed)
      return
    }
    useUi.getState().navigate({ page: lastView() })
  }, [ready])

  if (!ready) {
    return (
      <div className="win">
        <TitleBar onboarding />
        <div className="stage">
          <div className="boot">
            <div className="boot-wordmark">Agent</div>
          </div>
        </div>
      </div>
    )
  }

  const onboarding = route.page === 'onboarding'

  return (
    <div className="win">
      <TitleBar onboarding={onboarding} />
      <div className="stage">{onboarding ? <Onboarding step={route.step} /> : <Page />}</div>
      <div className="overlay">
        <Palette />
        <QuickAsk />
      </div>
    </div>
  )
}
