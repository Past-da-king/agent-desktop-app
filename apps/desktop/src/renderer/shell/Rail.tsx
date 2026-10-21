import { useEffect, useMemo, useState } from 'react'

import { isOpenCard } from '../lib/cards'
import { openChat, startNewChat } from '../lib/chat-actions'
import { STATUS_LABEL, chatList, chatOf, chatStatus } from '../lib/chats'
import { short, timeAgo } from '../lib/format'
import { startChatTracking, useAnyRunning, useChats } from '../state/useChats'
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
  const items = useEntity('chat_item')
  const goals = useEntity('goal')
  const open = useChats((state) => state.open)
  const runs = useChats((state) => state.runs)
  const seen = useChats((state) => state.seen)
  const since = useChats((state) => state.since)
  const [showAll, setShowAll] = useState(false)
  useEffect(() => startChatTracking(), [])
  const chats = useMemo(() => chatList(items, open), [items, open])
  const cardsByChat = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) if (isOpenCard(item)) counts.set(chatOf(item), (counts.get(chatOf(item)) ?? 0) + 1)
    return counts
  }, [items])
  const rows = chats.map((entry) => ({
    entry,
    status: chatStatus(entry, runs[entry.id], seen[entry.id] ?? since, entry.id === open && route.page === 'chat', cardsByChat.get(entry.id) ?? 0),
  }))
  const busy = rows.filter((row) => row.status !== 'idle').length
  const shown = showAll ? rows : rows.filter((row, index) => index < 6 || row.status !== 'idle' || row.entry.id === open)
  const openGoal = goals.find((goal) => goal.status === 'open')
  const agentName = settings?.agentName.trim() || 'Your agent'
  const userName = settings?.userName.trim() || 'You'
  const email = settings?.syncEmail ?? ''

  const anyRunning = useAnyRunning()
  const statusText = needs > 0 ? 'Waiting for you' : openGoal ? `Working on ${openGoal.title}` : anyRunning ? 'Working' : 'Ready'

  return (
    <nav className="rail" aria-label="Main">
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
        const active = route.page === item.page
        return (
          <button
            key={item.page}
            type="button"
            className={`nav${active ? ' on' : ''}`}
            onClick={() => navigate({ page: item.page })}
            aria-current={active ? 'page' : undefined}
            title={item.label}
          >
            <Icon name={item.icon} size={22} />
            <span className="lbl">{item.label}</span>
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
        <span>CHATS</span>
        {busy > 0 ? <span className="chats-busy">{busy} active</span> : null}
      </div>
      <div className="chatlist" role="list">
        {chats.length === 0 ? <p className="chat-none">Your chats will show up here.</p> : null}
        {shown.map(({ entry, status }) => {
          const on = entry.id === open && route.page === 'chat'
          const label = STATUS_LABEL[status]
          return (
            <button
              key={entry.id}
              type="button"
              role="listitem"
              className={`chatrow${on ? ' on' : ''} st-${status}`}
              onClick={() => openChat(entry.id)}
              title={label === '' ? entry.title : `${entry.title}. ${label}`}
              aria-current={on ? 'true' : undefined}
            >
              <span className={`cstat ${status}`} aria-hidden="true">
                {status === 'idle' ? (
                  <Icon name={entry.branch ? 'branch' : entry.device === 'phone' ? 'phone' : 'chat'} size={16} />
                ) : (
                  <i />
                )}
              </span>
              <span className="ct">{entry.title}</span>
              <span className="tm">
                {status === 'working' ? 'Working' : status === 'waiting' ? 'Needs you' : entry.at === Number.MAX_SAFE_INTEGER ? 'Now' : timeAgo(entry.at)}
              </span>
              {label !== '' ? <span className="sr-only">{label}</span> : null}
            </button>
          )
        })}
        {rows.length > shown.length || showAll ? (
          <button type="button" className="chatmore" onClick={() => setShowAll((value) => !value)}>
            {showAll ? 'Show fewer' : `Show ${rows.length - shown.length} more`}
          </button>
        ) : null}
      </div>

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
