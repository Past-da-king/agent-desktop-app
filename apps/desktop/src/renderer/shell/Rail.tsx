import { MAIN_CHAT } from '@agent/core'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { isOpenCard } from '../lib/cards'
import { openChat, startNewChat } from '../lib/chat-actions'
import { chatOf } from '../lib/chats'
import { short } from '../lib/format'
import { fitRail, RAIL_PAD_SMALL, RAIL_TILE, RAIL_TILE_SMALL, railProjects, type RailRoom } from '../lib/projects'
import { useDevicesSummary } from '../state/useDevices'
import { startChatTracking, useAnyRunning, useChats } from '../state/useChats'
import { ProjectDialog } from '../views/ProjectDialog'
import { AllProjects } from './AllProjects'
import { ProjectTile } from '../ui/ProjectTile'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useRoute, useUi } from '../state/useUi'
import { Avatar } from '../ui/bits'
import { Icon, type IconName } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { PinnedApps } from './PinnedApps'

const NAV: Array<{ page: 'home' | 'chat' | 'tasks' | 'memory' | 'routines' | 'apps' | 'connections'; icon: IconName; label: string }> = [
  { page: 'home', icon: 'home', label: 'Home' },
  { page: 'chat', icon: 'chat', label: 'Chat' },
  { page: 'tasks', icon: 'tasks', label: 'Tasks' },
  { page: 'memory', icon: 'memory', label: 'Memory' },
  { page: 'routines', icon: 'clock', label: 'Routines' },
  { page: 'apps', icon: 'grid', label: 'Apps' },
  { page: 'connections', icon: 'apps', label: 'Connections' },
]

export function Rail({ needs }: { needs: number }): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const route = useRoute()
  const navigate = useUi((state) => state.navigate)
  const railCollapsed = useUi((state) => state.railCollapsed)
  const toggleRail = useUi((state) => state.toggleRail)
  const items = useEntity('chat_item')
  const goals = useEntity('goal')
  const projects = useEntity('project')
  const open = useChats((state) => state.open)
  const runs = useChats((state) => state.runs)
  const [creating, setCreating] = useState(false)
  useEffect(() => startChatTracking(), [])
  const cardsByChat = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) if (isOpenCard(item)) counts.set(chatOf(item), (counts.get(chatOf(item)) ?? 0) + 1)
    return counts
  }, [items])
  const pinned = railProjects(projects)
  // The navigation never gives up room: the projects area is measured and shows what fits in what is left.
  const pjRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState<RailRoom | null>(null)
  // The expanded rail has an All link in its header, so its projects area may shrink to nothing; collapsed keeps one tile.
  const [header, setHeader] = useState(false)
  useLayoutEffect(() => {
    const box = pjRef.current
    if (box === null) return undefined
    const measure = (): void => {
      const style = getComputedStyle(box)
      const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const cols = style.gridTemplateColumns.split(' ').filter(Boolean).length || 1
      const gap = parseFloat(style.rowGap) || 0
      const app = box.querySelector<HTMLElement>('.pj-app')
      const tile = app?.querySelector<HTMLElement>('.pj-tile')
      setHeader(headRef.current !== null && headRef.current.offsetParent !== null)
      setRoom((prev) => {
        let extra = prev?.extra ?? 0
        if (app && tile) {
          const own = getComputedStyle(app)
          extra = Math.max(0, app.offsetHeight - tile.offsetHeight - parseFloat(own.paddingTop) - parseFloat(own.paddingBottom))
        }
        const next = { room: Math.max(0, box.clientHeight - pad), cols, gap, extra }
        return prev !== null && prev.room === next.room && prev.cols === next.cols && prev.gap === next.gap && prev.extra === next.extra ? prev : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [railCollapsed])
  const fit = room === null ? { small: false, show: pinned.length, none: false } : fitRail(room, pinned.length)
  const shown = pinned.slice(0, fit.show)
  const tileSize = fit.small ? RAIL_TILE_SMALL : RAIL_TILE
  const more = projects.length - shown.length
  const linked = useDevicesSummary()
  const [allOpen, setAllOpen] = useState(false)
  // A project needs you when one of its chats waits on a card; it is working when one of its chats runs.
  const statusOf = (chats: string[]): 'waiting' | 'working' | null =>
    chats.some((chat) => (cardsByChat.get(chat) ?? 0) > 0 || (runs[chat]?.waiting.length ?? 0) > 0)
      ? 'waiting'
      : chats.some((chat) => runs[chat]?.running === true || (runs[chat]?.alongside ?? 0) > 0)
        ? 'working'
        : null
  const openGoal = goals.find((goal) => goal.status === 'open')
  const agentName = settings?.agentName.trim() || 'Your agent'
  const userName = settings?.userName.trim() || 'You'
  const email = settings?.syncEmail ?? ''

  const anyRunning = useAnyRunning()
  const statusText = needs > 0 ? 'Waiting for you' : openGoal ? `Working on ${openGoal.title}` : anyRunning ? 'Working' : 'Ready'

  return (
    <nav className="rail" aria-label="Main">
      <div className="me-row">
        <button
          type="button"
          className="me"
          onClick={() => navigate({ page: 'home' })}
          aria-label={`${agentName}, your agent`}
        >
          <Mascot id={settings?.mascot ?? 'scout'} size={48} busy={needs === 0} needsYou={needs > 0} />
          <div className="who">
            <div className="nm">{agentName}</div>
            <div className={`st${needs > 0 ? ' warn' : ''}`}>{short(statusText, 44)}</div>
          </div>
        </button>
        <button
          type="button"
          className="rail-fold hide-m"
          aria-label={railCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          aria-pressed={railCollapsed}
          title={railCollapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          onClick={toggleRail}
        >
          <Icon name="chev" size={16} />
        </button>
      </div>

      <button
        type="button"
        className="btn fill newchat lg"
        aria-label="New chat"
        onClick={() => {
          void startNewChat()
        }}
      >
        <Icon name="plus" size={22} />
        <span>New chat</span>
      </button>

      {NAV.map((item) => {
        const active = route.page === item.page && (item.page !== 'chat' || open === MAIN_CHAT)
        return (
          <button
            key={item.page}
            type="button"
            className={`nav${active ? ' on' : ''}`}
            onClick={() => (item.page === 'chat' ? openChat(MAIN_CHAT) : navigate({ page: item.page }))}
            aria-current={active ? 'page' : undefined}
            title={item.page === 'chat' ? agentName : item.label}
          >
            {/* The main chat is your agent: its name and its own picture. */}
            {item.page === 'chat' ? (
              <span className="nav-av" aria-hidden="true">
                <Mascot id={settings?.mascot ?? 'scout'} size={24} />
              </span>
            ) : (
              <Icon name={item.icon} size={22} />
            )}
            <span className="lbl">{item.page === 'chat' ? agentName : item.label}</span>
            {item.page === 'chat' && needs > 0 ? (
              <>
                <span className="badge inline">{needs}</span>
                <span className="badge pos">{needs}</span>
              </>
            ) : null}
          </button>
        )
      })}

      <PinnedApps collapsed={railCollapsed} />

      <div className="eyebrow mute grp chats-h" ref={headRef}>
        <span>PROJECTS</span>
        {projects.length > 0 ? (
          <button type="button" className="pj-hidden-link" onClick={() => setAllOpen(true)}>
            All {projects.length}
          </button>
        ) : null}
      </div>
      <div
        ref={pjRef}
        className={`pj-rail${fit.small ? ' small' : ''}`}
        aria-label="Projects"
        // The header's All link stands in for the tile only when there are projects to list; with none the + tile stays.
        style={{ minHeight: header && projects.length > 0 ? 0 : RAIL_PAD_SMALL + RAIL_TILE_SMALL + 4 }}
      >
        {shown.map((project) => {
          const on = (route.page === 'project' && route.id === project.id) || (route.page === 'chat' && project.chats.includes(open))
          const status = statusOf(project.chats)
          return (
            <button
              key={project.id}
              type="button"
              className={`pj-app${on ? ' on' : ''}`}
              title={status === 'waiting' ? `${project.name}. Needs you` : status === 'working' ? `${project.name}. Working` : project.name}
              aria-current={on ? 'true' : undefined}
              onClick={() => navigate({ page: 'project', id: project.id })}
            >
              <ProjectTile icon={project.icon} size={tileSize} status={status} />
              <span className="pj-app-name">{project.name}</span>
            </button>
          )
        })}
        {/* With no projects yet the + makes one; after that it opens all of them (with New project inside).
            With no room at all the expanded rail drops it: the header's All link does the same. */}
        {fit.none && header && projects.length > 0 ? null : (
          <button
            type="button"
            className="pj-app add"
            title={projects.length === 0 ? 'New project' : 'All projects'}
            aria-label={projects.length === 0 ? 'New project' : `All projects, ${projects.length}`}
            onClick={() => (projects.length === 0 ? setCreating(true) : setAllOpen(true))}
          >
            <span className="pj-tile pj-add" aria-hidden="true">
              {/* A small tile has room for the count or the +, not both. */}
              {fit.small && more > 0 ? null : <Icon name="plus" size={22} />}
              {more > 0 ? <span className="pj-more">+{more}</span> : null}
            </span>
            <span className="pj-app-name">{projects.length === 0 ? 'New' : 'All'}</span>
          </button>
        )}
      </div>
      {allOpen ? (
        <AllProjects
          projects={projects}
          statusOf={(project) => statusOf(project.chats)}
          onNew={() => setCreating(true)}
          onClose={() => setAllOpen(false)}
        />
      ) : null}
      {creating ? (
        <ProjectDialog
          onClose={(made) => {
            setCreating(false)
            if (made !== null) navigate({ page: 'project', id: made })
          }}
        />
      ) : null}

      <button
        type="button"
        className={`nav${route.page === 'settings' ? ' on' : ''}`}
        onClick={() => navigate({ page: 'settings' })}
        title="Settings"
      >
        <Icon name="sliders" size={22} />
        <span className="lbl">Settings</span>
      </button>
      <button
        type="button"
        className="acct"
        onClick={() => navigate({ page: 'settings' })}
        aria-label="Account settings"
      >
        <Avatar name={userName} />
        <div className="who" style={{ minWidth: 0, textAlign: 'left' }}>
          <div style={{ font: '500 14px/1.2 var(--font)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {userName}
          </div>
          <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {linked.count > 0 ? linked.line : email || linked.line}
          </div>
        </div>
      </button>
    </nav>
  )
}
