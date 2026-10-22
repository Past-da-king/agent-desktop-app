import type { CSSProperties, ReactNode } from 'react'

import { openCards } from '../lib/cards'
import { useEntity } from '../state/useData'
import { usePanel } from '../state/usePanel'
import { useRoute, useUi } from '../state/useUi'
import { Icon, type IconName } from '../ui/Icon'
import { ChatPanel } from './Panel'
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

/**
 * The sheet scrolls by default, on every page and at every width. Only a page that scrolls its own inner region (Chat:
 * a fixed header and composer around a scrolling thread) passes ownScroll. Having the side panel is not the same thing:
 * the project page has it and must still scroll.
 */
export function Shell({
  children,
  panel,
  ownScroll = false,
}: {
  children: ReactNode
  panel?: ReactNode
  ownScroll?: boolean
}): JSX.Element {
  const collapsed = useUi((state) => state.railCollapsed)
  const panelWidth = usePanel((state) => state.width)
  const panelCollapsed = usePanel((state) => state.collapsed)
  const needs = useNeeds()
  const classes = ['shell', collapsed ? 'col' : '', panel ? (panelCollapsed ? 'panel-collapsed' : 'panel') : '']
    .filter(Boolean)
    .join(' ')
  // Always set: the parked browser card keeps the panel's width, so its pages keep their size off the chat page.
  const style = { '--panel-w': `${panelWidth}px` } as CSSProperties

  return (
    <>
      <div className={classes} style={style}>
        <Rail needs={needs} />
        <main className={ownScroll ? 'sheet own-scroll' : 'sheet'}>
          {children}
        </main>
        {/* The same ChatPanel element on every page (only Chat passes one), so the browser card it holds is never
            unmounted: the agent's pages live in it. Elsewhere it is parked out of sight. */}
        {panel ?? <ChatPanel parked />}
      </div>
      <MobileNav />
    </>
  )
}
