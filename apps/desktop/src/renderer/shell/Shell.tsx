import type { ReactNode } from 'react'

import { openCards } from '../lib/cards'
import { useEntity } from '../state/useData'
import { useRoute, useUi } from '../state/useUi'
import { Icon, type IconName } from '../ui/Icon'
import { Rail } from './Rail'

export function useNeeds(): number {
  const items = useEntity('chat_item')
  return openCards(items).length
}

const MOBILE: Array<{ page: 'home' | 'tasks' | 'memory' | 'routines' | 'connections'; icon: IconName; label: string }> = [
  { page: 'home', icon: 'home', label: 'Home' },
  { page: 'tasks', icon: 'tasks', label: 'Tasks' },
  { page: 'memory', icon: 'memory', label: 'Memory' },
  { page: 'routines', icon: 'clock', label: 'Routines' },
  { page: 'connections', icon: 'apps', label: 'Connections' },
]

function MobileNav(): JSX.Element {
  const route = useRoute()
  const navigate = useUi((state) => state.navigate)
  return (
    <div className="mnav">
      <div className="bar">
        {MOBILE.map((item) => (
          <button
            key={item.page}
            type="button"
            className={route.page === item.page ? 'on' : ''}
            onClick={() => navigate({ page: item.page })}
            aria-label={item.label}
          >
            <Icon name={item.icon} size={22} />
          </button>
        ))}
      </div>
      <button type="button" className="talk" onClick={() => navigate({ page: 'chat' })} aria-label="Chat">
        <Icon name="chat" size={24} />
      </button>
    </div>
  )
}

export function Shell({ children, panel }: { children: ReactNode; panel?: ReactNode }): JSX.Element {
  const collapsed = useUi((state) => state.railCollapsed)
  const needs = useNeeds()
  const classes = ['shell', collapsed ? 'col' : '', panel ? 'panel' : ''].filter(Boolean).join(' ')

  return (
    <>
      <div className={classes}>
        <Rail needs={needs} />
        <main className="sheet" style={panel ? { overflow: 'hidden' } : undefined}>
          {children}
        </main>
        {panel}
      </div>
      <MobileNav />
    </>
  )
}
