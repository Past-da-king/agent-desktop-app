import { MAIN_CHAT, findMatches, projectFields, type FindField } from '@agent/core'
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'

import { agent, chat } from '../bridge'
import { openChat, startNewChat } from '../lib/chat-actions'
import { formatAccelerator } from '../lib/hotkey'
import { orTell } from '../lib/tell'
import { isDarkNow } from '../state/theme'
import { useEntity } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Dialog } from '../ui/Dialog'
import { Icon, type IconName } from '../ui/Icon'
import { MiniAppIcon } from '../ui/MiniAppIcon'
import { miniAppFields } from '../../shared/miniapps'
import { TaskDialog } from '../views/TaskDialog'

interface Action {
  id: string
  label: string
  icon: IconName
  /** Drawn instead of `icon`: a mini-app's own icon. */
  glyph?: ReactNode
  shortcut?: string
  run: () => void
  /** What search matches it by; the label when absent. A project adds its other names, description and folder. */
  fields?: FindField[]
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
          {action.glyph ?? <Icon name={action.icon} size={20} />}
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
  const miniApps = useEntity('miniapp')
  const focusComposer = useUi((state) => state.focusComposer)
  const openQuick = useUi((state) => state.openQuick)
  const settings = useSettings((state) => state.settings)
  const save = useSettings((state) => state.save)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  // "Add a to-do" opens the real to-do form once the palette has closed.
  const [adding, setAdding] = useState(false)
  const goals = useEntity('goal')
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

  if (!open) {
    if (!adding) return null
    return (
      <TaskDialog
        task={null}
        owner="user"
        goals={goals}
        onClose={() => setAdding(false)}
        onSaved={(saved) => {
          const state = useUi.getState()
          state.selectTask(saved.id)
          state.setTaskTab('todos')
          state.navigate({ page: 'tasks' })
        }}
      />
    )
  }

  const agentName = settings?.agentName.trim() || 'your agent'

  const closeAnd = (run: () => void) => () => {
    run()
    close()
  }

  const addTodo = (): void => {
    setAdding(true)
    close()
  }
  // The shortcut he set (Settings, Shortcuts), not a fixed one.
  const quickKeys = formatAccelerator(settings?.quickAskHotkey || 'CommandOrControl+Shift+Space', agent.platform).join(' ')

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
      // The label last and light, so "project" or "hidden" alone still lists them.
      fields: [...projectFields(project), { text: project.hidden ? 'hidden project' : 'project', weight: 0.3, fuzzy: false }],
      run: closeAnd(() => navigate({ page: 'project', id: project.id })),
    })),
    // Every mini-app he has: "calendar" then Enter opens his Calendar app straight away.
    ...[...miniApps]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((app): Action => ({
        id: `jump-miniapp-${app.id}`,
        label: `${app.name} (app)`,
        icon: 'apps',
        glyph: <MiniAppIcon icon={app.icon} size={20} />,
        fields: miniAppFields(app),
        run: closeAnd(() => navigate({ page: 'miniapp', id: app.id })),
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
        void orTell(agent.helpers.stopAll().then(() => true), 'The helpers could not be stopped.').then((done) => {
          if (done === true) toast('Helpers stopped.')
        })
      },
    },
    {
      id: 'do-quick',
      label: 'Quick ask',
      icon: 'bolt',
      shortcut: quickKeys,
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
        void orTell(save({ theme: isDarkNow() ? 'light' : 'dark' }), 'The theme could not be changed.')
      },
    },
  ]

  const q = query.trim().toLowerCase()
  // The same forgiving matcher the agent's project_open uses (@agent/core find.ts): filler words dropped, every
  // other word matched by prefix or a small typo, best hit first so Enter opens it.
  const shown = (actions: Action[]): { actions: Action[]; best: number } => {
    if (q === '') return { actions, best: 0 }
    const hits = findMatches(
      query,
      actions.map((action) => ({ item: action, fields: action.fields ?? [{ text: action.label, weight: 1 }] })),
    )
    return { actions: hits.map((hit) => hit.item), best: hits[0]?.score ?? 0 }
  }
  const jumpShown = shown(jump)
  const doShown = shown(doItems)
  // The group holding the best hit comes first, so the first row, the one Enter opens, is the best hit.
  const doFirst = doShown.best > jumpShown.best
  const entries: Entry[] = []
  const place = (actions: Action[]): Entry[] =>
    actions.map((action) => {
      const entry = { action, index: entries.length }
      entries.push(entry)
      return entry
    })
  let jumpEntries: Entry[]
  let doEntries: Entry[]
  if (doFirst) {
    doEntries = place(doShown.actions)
    jumpEntries = place(jumpShown.actions)
  } else {
    jumpEntries = place(jumpShown.actions)
    doEntries = place(doShown.actions)
  }

  if (q !== '') {
    entries.push({
      action: {
        id: 'ask',
        label: `Ask ${agentName}: "${query.trim()}"`,
        icon: 'chat',
        run: () => {
          close()
          void orTell(chat.send(query.trim()), 'Your message could not be sent. Try again.')
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
    const jumpGroup = jumpEntries.length > 0 ? <Group label="Jump to" entries={jumpEntries} selected={selected} onHover={setSelected} /> : null
    const doGroup = doEntries.length > 0 ? <Group label="Do something" entries={doEntries} selected={selected} onHover={setSelected} /> : null
    body = (
      <>
        {doFirst ? doGroup : jumpGroup}
        {doFirst ? jumpGroup : doGroup}
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
