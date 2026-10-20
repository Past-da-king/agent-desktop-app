import type { ChatItem } from '@agent/core'

import { metaText, parseMeta } from '../lib/meta'
import { startNewChat } from '../lib/chat-actions'
import { short, timeAgo } from '../lib/format'
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

interface Recent {
  id: string
  title: string
  device: string
  at: number
  active: boolean
}

function recentChats(items: ChatItem[]): Recent[] {
  const branches = items
    .filter((item) => item.kind === 'branch')
    .map((item) => {
      const meta = parseMeta(item.meta)
      return {
        id: item.id,
        title: metaText(meta, 'title') || item.text,
        device: metaText(meta, 'device') || 'desk',
        at: typeof meta['at'] === 'number' ? meta['at'] : item.createdAt,
        active: meta['active'] === true,
      }
    })
    .sort((a, b) => b.at - a.at)
  if (branches.length > 0) return branches.slice(0, 5)
  const first = items.find((item) => item.kind === 'user')
  if (!first) return []
  return [
    {
      id: first.id,
      title: short(first.text, 34),
      device: 'desk',
      at: first.createdAt,
      active: true,
    },
  ]
}

export function Rail({ needs }: { needs: number }): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const route = useRoute()
  const navigate = useUi((state) => state.navigate)
  const items = useEntity('chat_item')
  const goals = useEntity('goal')
  const chats = recentChats(items)
  const openGoal = goals.find((goal) => goal.status === 'open')
  const agentName = settings?.agentName.trim() || 'Your agent'
  const userName = settings?.userName.trim() || 'You'
  const email = settings?.syncEmail ?? ''

  const statusText = needs > 0 ? 'Waiting for you' : openGoal ? `Working on ${openGoal.title}` : 'Ready'

  return (
    <nav className="rail" aria-label="Main">
      <button
        type="button"
        className="me"
        onClick={() => navigate({ page: 'home' })}
        aria-label={`${agentName}, your agent`}
      >
        <Mascot id={settings?.mascot ?? 'scout'} size={48} busy={needs === 0} />
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

      <div className="eyebrow mute grp">RECENT CHATS</div>
      <div className="chatlist">
        {chats.map((chat) => (
          <button
            key={chat.id}
            type="button"
            className={`chatrow${chat.active && route.page === 'chat' ? ' on' : ''}`}
            onClick={() => navigate({ page: 'chat' })}
            title={chat.title}
          >
            <Icon name={chat.device === 'phone' ? 'phone' : 'monitor'} size={16} />
            <span className="ct">{chat.title}</span>
            <span className="tm">{timeAgo(chat.at)}</span>
          </button>
        ))}
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
          <div style={{ font: "500 14px/1.2 'Roboto',sans-serif", overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
