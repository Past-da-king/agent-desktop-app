import { MAIN_CHAT } from '@agent/core'
import { useEffect, useMemo, useState } from 'react'

import { isOpenCard } from '../lib/cards'
import { openChat, startNewChat } from '../lib/chat-actions'
import { chatOf } from '../lib/chats'
import { short } from '../lib/format'
import { railProjects } from '../lib/projects'
import { startChatTracking, useAnyRunning, useChats } from '../state/useChats'
import { HIDDEN_PROJECTS } from '../views/Project'
import { ProjectDialog } from '../views/ProjectDialog'
import { ProjectTile } from '../ui/ProjectTile'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useRoute, useUi } from '../state/useUi'
import { Avatar } from '../ui/bits'
import { Icon, type IconName } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'

const NAV: Array<{ page: 'home' | 'chat' | 'tasks' | 'memory' | 'routines' | 'connections'; icon: IconName; label: string }> = [
  { page: 'home', icon: 'home', label: 'Home' },
  { page: 'chat', icon: 'chat', label: 'Chat' },
  { page: 'tasks', icon: 'tasks', label: 'Tasks' },
  { page: 'memory', icon: 'memory', label: 'Memory' },
  { page: 'routines', icon: 'clock', label: 'Routines' },
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
  const shown = railProjects(projects)
  const hiddenCount = projects.length - shown.length
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

      <div className="eyebrow mute grp chats-h">
        <span>PROJECTS</span>
        {hiddenCount > 0 ? (
          <button type="button" className="pj-hidden-link" onClick={() => navigate({ page: 'project', id: HIDDEN_PROJECTS })}>
            {hiddenCount} hidden
          </button>
        ) : null}
      </div>
      <div className="pj-rail" aria-label="Projects">
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
              <ProjectTile icon={project.icon} size={44} status={status} />
              <span className="pj-app-name">{project.name}</span>
            </button>
          )
        })}
        <button type="button" className="pj-app add" title="New project" aria-label="New project" onClick={() => setCreating(true)}>
          <span className="pj-tile pj-add" aria-hidden="true">
            <Icon name="plus" size={22} />
          </span>
          <span className="pj-app-name">New</span>
        </button>
      </div>
      {creating ? (
        <ProjectDialog
          onClose={(made) => {
            setCreating(false)
            if (made !== null) navigate({ page: 'project', id: made })
          }}
        />
      ) : null}

      <div className="spacer" />

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
            {email || 'This computer only'}
          </div>
        </div>
      </button>
    </nav>
  )
}
