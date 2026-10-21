import { MAIN_CHAT, type TaskRow } from '@agent/core'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { agent, chat } from '../bridge'
import { openChat, startNewChat } from '../lib/chat-actions'
import { isDarkNow } from '../state/theme'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi } from '../state/useUi'
import { Dialog } from '../ui/Dialog'
import { Icon, type IconName } from '../ui/Icon'

interface Action {
  id: string
  label: string
  icon: IconName
  shortcut?: string
  run: () => void
}

interface Entry {
  action: Action
  index: number
}

function Group({ label, entries, selected, onHover }: {
  label: string
  entries: Entry[]
  selected: number
  onHover: (index: number) => void
}): JSX.Element {
  return (
    <>
      <span className="eyebrow mute">{label.toUpperCase()}</span>
      {entries.map(({ action, index }) => (
        <button
          key={action.id}
          type="button"
          className={`pi${selected === index ? ' sel' : ''}`}
          onMouseEnter={() => onHover(index)}
          onClick={action.run}
        >
          <Icon name={action.icon} size={20} />
          {action.label}
          {action.shortcut ? (
            <span className="kbds">
              <kbd>{action.shortcut}</kbd>
            </span>
          ) : null}
        </button>
      ))}
    </>
  )
}

export function Palette(): JSX.Element | null {
  const overlay = useUi((state) => state.overlay)
  const close = useUi((state) => state.closeOverlay)
  const navigate = useUi((state) => state.navigate)
  const projects = useEntity('project')
  const focusComposer = useUi((state) => state.focusComposer)
  const openQuick = useUi((state) => state.openQuick)
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const open = overlay === 'palette'

  useEffect(() => {
    if (open) {
      setQuery('')
      setSelected(0)
    }
  }, [open])

  useEffect(() => {
    const active = listRef.current?.querySelector<HTMLElement>('.pi.sel')
    active?.scrollIntoView({ block: 'nearest' })
  }, [selected, query])

  if (!open) return null

  const agentName = settings?.agentName.trim() || 'your agent'

  const closeAnd = (run: () => void) => () => {
    run()
    close()
  }

  const addTodo = (): void => {
    const now = Date.now()
    const due = new Date(now)
    due.setDate(due.getDate() + 1)
    due.setHours(9, 0, 0, 0)
    const row: TaskRow = {
      id: '',
      createdAt: now,
      goalId: null,
      title: 'Call the dentist',
      notes: 'Added just now. Book a check-up for next month.',
      status: 'todo',
      dueAt: due.getTime(),
      owner: 'user',
      blocker: '',
      updatedAt: now,
    }
    void agent.data.upsert('task', row).then((saved) => {
      const state = useUi.getState()
      state.selectTask(saved.id)
      state.setTaskTab('todos')
      state.navigate({ page: 'tasks' })
      state.closeOverlay()
    })
  }

  const jump: Action[] = [
    { id: 'jump-home', label: 'Home', icon: 'home', run: closeAnd(() => navigate({ page: 'home' })) },
    { id: 'jump-chat', label: 'Chat', icon: 'chat', run: closeAnd(() => openChat(MAIN_CHAT)) },
    { id: 'jump-tasks', label: 'Tasks', icon: 'tasks', run: closeAnd(() => navigate({ page: 'tasks' })) },
    { id: 'jump-memory', label: 'Memory', icon: 'memory', run: closeAnd(() => navigate({ page: 'memory' })) },
    { id: 'jump-routines', label: 'Routines', icon: 'clock', run: closeAnd(() => navigate({ page: 'routines' })) },
    { id: 'jump-connections', label: 'Connections', icon: 'apps', run: closeAnd(() => navigate({ page: 'connections' })) },
    { id: 'jump-settings', label: 'Settings', icon: 'sliders', run: closeAnd(() => navigate({ page: 'settings' })) },
    // Every project, hidden ones too: search is how a hidden project is found again.
    ...projects.map((project): Action => ({
      id: `jump-project-${project.id}`,
      label: project.hidden ? `${project.name} (hidden project)` : `${project.name} (project)`,
      icon: 'folder',
      run: closeAnd(() => navigate({ page: 'project', id: project.id })),
    })),
  ]
  const doItems: Action[] = [
    {
      id: 'do-newchat',
      label: 'New chat',
      icon: 'plus',
      run: () => {
        close()
        void startNewChat()
      },
    },
    { id: 'do-todo', label: 'Add a to-do', icon: 'plus', run: addTodo },
    {
      id: 'do-stop-helpers',
      label: 'Stop all helpers',
      icon: 'stop',
      run: () => {
        close()
        void agent.helpers.stopAll()
      },
    },
    {
      id: 'do-quick',
      label: 'Quick ask',
      icon: 'bolt',
      shortcut: 'Ctrl Alt Space',
      run: () => {
        close()
        openQuick()
      },
    },
    {
      id: 'do-theme',
      label: 'Switch light and dark',
      icon: 'sun',
      run: () => {
        close()
        void save({ theme: isDarkNow() ? 'light' : 'dark' })
      },
    },
  ]

  const q = query.trim().toLowerCase()
  const match = (action: Action): boolean => q === '' || action.label.toLowerCase().includes(q)
  const jumpShown = jump.filter(match)
  const doShown = doItems.filter(match)
  const entries: Entry[] = []
  const jumpEntries = jumpShown.map((action) => {
    const entry = { action, index: entries.length }
    entries.push(entry)
    return entry
  })
  const doEntries = doShown.map((action) => {
    const entry = { action, index: entries.length }
    entries.push(entry)
    return entry
  })

  if (q !== '') {
    entries.push({
      action: {
        id: 'ask',
        label: `Ask ${agentName}: "${query.trim()}"`,
        icon: 'chat',
        run: () => {
          close()
          void chat.send(query.trim())
          navigate({ page: 'chat' })
        },
      },
      index: entries.length,
    })
  }

  const flat = entries.map((entry) => entry.action)
  const askEntry = q !== '' ? entries[entries.length - 1] : undefined

  const run = (index: number): void => {
    const action = flat[index]
    if (action) action.run()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (flat.length === 0) return
      setSelected((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length)
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      run(selected)
    }
  }

  let body: ReactNode
  if (entries.length === 0) {
    body = (
      <p className="muted" style={{ padding: 20 }}>
        Nothing found.
      </p>
    )
  } else {
    body = (
      <>
        {jumpEntries.length > 0 ? (
          <Group label="Jump to" entries={jumpEntries} selected={selected} onHover={setSelected} />
        ) : null}
        {doEntries.length > 0 ? (
          <Group label="Do something" entries={doEntries} selected={selected} onHover={setSelected} />
        ) : null}
        {askEntry ? (
          <Group label="Ask" entries={[askEntry]} selected={selected} onHover={setSelected} />
        ) : null}
      </>
    )
  }

  return (
    <Dialog label="Search or jump to" surface="palette" onClose={close}>
      <div onKeyDown={onKeyDown}>
        <label className="search" htmlFor="pq">
          <Icon name="search" size={22} />
          <input
            id="pq"
            placeholder={`Search, jump to, or ask ${agentName}`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            autoComplete="off"
            aria-label="Search, jump to, or ask"
          />
        </label>
        <div className="pal-list" ref={listRef}>
          {body}
        </div>
      </div>
    </Dialog>
  )
}
