/**
 * Apps: every mini-app his agents made for him (docs/plans/mini-apps.md). Open one, pin it to the sidebar (drag to
 * order the pinned ones), change it by asking, go back a version, choose what it may change without asking, delete it.
 * New apps come from asking his agent; the box at the top hands his words to it.
 */
import { MAIN_CHAT, type MiniAppRow } from '@agent/core'
import { useMemo, useState } from 'react'

import { agent } from '../bridge'
import { openedLine } from '../lib/miniapps'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { MiniAppTile } from '../ui/MiniAppIcon'
import { Switch } from '../ui/Switch'
import { checkCall, pinnedApps, toolOf } from '../../shared/miniapps'


export function MiniApps(): JSX.Element {
  return <MiniAppsSection />
}

/**
 * Every mini-app he has: the Apps page, and (bare, with no page header) the Mini apps tab in Connections next to
 * Connected apps and Learned apps.
 */
export function MiniAppsSection({ bare = false }: { bare?: boolean }): JSX.Element {
  const apps = useEntity('miniapp')
  const loaded = useEntityLoaded('miniapp')
  const settings = useSettings((state) => state.settings)
  const navigate = useUi((state) => state.navigate)
  const [idea, setIdea] = useState('')
  const pinned = useMemo(() => pinnedApps(apps), [apps])
  const rest = useMemo(() => apps.filter((app) => app.pinned === 0).sort((a, b) => (b.openedAt || b.updatedAt) - (a.openedAt || a.updatedAt)), [apps])
  const [drag, setDrag] = useState<string | null>(null)

  const ask = (): void => {
    const text = idea.trim()
    if (text === '') return
    void agent.chat.send(`Make me a mini-app: ${text}`, [], MAIN_CHAT).then(() => {
      setIdea('')
      toast('Your agent is making it. It shows here when it is ready.')
    })
  }

  const drop = (target: string): void => {
    if (drag === null || drag === target) return
    const ids = pinned.map((app) => app.id).filter((id) => id !== drag)
    ids.splice(ids.indexOf(target), 0, drag)
    setDrag(null)
    void agent.miniapps.order(ids)
  }

  return (
    <div className={bare ? 'ma-bare' : 'page'} data-section="mini-apps">
      {bare ? (
        <p className="small muted ma-bare-line">
          {apps.length === 0 ? 'No mini-apps yet.' : `${apps.length} mini-app${apps.length === 1 ? '' : 's'} made for you.`} Dashboards, trackers and views your agent makes when you ask.
        </p>
      ) : (
        <div className="ph">
          <div>
            <span className="eyebrow">APPS</span>
            <h1 className="h1">{apps.length === 0 ? 'No apps yet' : `${apps.length} app${apps.length === 1 ? '' : 's'} made for you`}</h1>
            <p className="lead">Dashboards, trackers and views your agent makes when you ask. Pin the ones you use most.</p>
          </div>
        </div>
      )}

      <form
        className="ma-ask"
        onSubmit={(event) => {
          event.preventDefault()
          ask()
        }}
      >
        <Icon name="grid" size={20} />
        <input
          className="ma-ask-input"
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          placeholder="Describe an app: a week view of all my calendars, a tracker for my plan..."
          aria-label="Describe an app for your agent to make"
        />
        <Button size="sm" type="submit" disabled={idea.trim() === ''}>
          Make it
        </Button>
      </form>

      {loaded && apps.length === 0 ? (
        <EmptyState
          mascot={settings?.mascot ?? 'scout'}
          title="Ask for your first app"
          line="Tell your agent what you want to see: a dashboard of anything, a tracker for a plan, a view across your calendars. It builds it, checks it in light and dark, and it shows up here."
        />
      ) : null}

      {pinned.length > 0 ? (
        <section className="ma-sec">
          <div className="eyebrow mute">ON THE SIDEBAR</div>
          <div className="ma-grid">
            {pinned.map((app, index) => (
              <AppCard
                key={app.id}
                app={app}
                place={index + 1}
                count={pinned.length}
                dragging={drag === app.id}
                onDragStart={() => setDrag(app.id)}
                onDrop={() => drop(app.id)}
                onOpen={() => navigate({ page: 'miniapp', id: app.id })}
              />
            ))}
          </div>
        </section>
      ) : null}

      {rest.length > 0 ? (
        <section className="ma-sec">
          {pinned.length > 0 ? <div className="eyebrow mute">ALL APPS</div> : null}
          <div className="ma-grid">
            {rest.map((app) => (
              <AppCard key={app.id} app={app} onOpen={() => navigate({ page: 'miniapp', id: app.id })} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function AppCard({
  app,
  place,
  count,
  dragging,
  onDragStart,
  onDrop,
  onOpen,
}: {
  app: MiniAppRow
  place?: number
  count?: number
  dragging?: boolean
  onDragStart?: () => void
  onDrop?: () => void
  onOpen: () => void
}): JSX.Element {
  const [menu, setMenu] = useState(false)
  const [asking, setAsking] = useState(false)
  const [rights, setRights] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const pinned = app.pinned > 0
  const look = app.check.version !== app.version ? 'Checking' : app.check.ok ? null : 'Needs a fix'
  return (
    <div
      className={`ma-card${dragging === true ? ' dragging' : ''}`}
      draggable={pinned}
      onDragStart={pinned ? onDragStart : undefined}
      onDragOver={pinned ? (event) => event.preventDefault() : undefined}
      onDrop={pinned ? onDrop : undefined}
    >
      <button type="button" className="ma-card-main" onClick={onOpen} aria-label={`Open ${app.name}`}>
        <MiniAppTile icon={app.icon} size={44} />
        <span className="ma-card-text">
          <b>{app.name}</b>
          <span className="muted">{app.description || 'No description'}</span>
          <span className="small muted">
            {openedLine(app.openedAt)} · v{app.version}
            {look !== null ? <span className={`pill ${look === 'Checking' ? 'mute' : 'warn'} ma-look`}>{look}</span> : null}
          </span>
        </span>
      </button>
      <div className="ma-card-actions">
        {pinned && place !== undefined && count !== undefined && count > 1 ? (
          <>
            <button type="button" className="ib flip" title="Move up" aria-label={`Move ${app.name} up`} disabled={place === 1} onClick={() => void agent.miniapps.pin(app.id, place - 1)}>
              <Icon name="chevd" size={16} />
            </button>
            <button type="button" className="ib" title="Move down" aria-label={`Move ${app.name} down`} disabled={place === count} onClick={() => void agent.miniapps.pin(app.id, place + 1)}>
              <Icon name="chevd" size={16} />
            </button>
          </>
        ) : null}
        <button
          type="button"
          className={`chip${pinned ? ' on' : ''}`}
          aria-pressed={pinned}
          title={pinned ? 'Take it off the sidebar' : 'Pin it to the sidebar'}
          onClick={() => void (pinned ? agent.miniapps.unpin(app.id) : agent.miniapps.pin(app.id))}
        >
          <Icon name="pin" size={16} />
          {pinned ? 'Pinned' : 'Pin'}
        </button>
        <div className="ma-menu-wrap">
          <button type="button" className="ib" aria-label={`More for ${app.name}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="sliders" size={18} />
          </button>
          {menu ? (
            <div className="ma-menu" role="menu" onMouseLeave={() => setMenu(false)}>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); onOpen() }}>
                <Icon name="play" size={16} /> Open
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setAsking(true) }}>
                <Icon name="edit" size={16} /> Edit by asking
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={app.history.length === 0}
                onClick={() => {
                  setMenu(false)
                  void agent.miniapps.undo(app.id).then((line) => toast(line))
                }}
              >
                <Icon name="sync" size={16} /> Undo the last change
              </button>
              <button type="button" role="menuitem" onClick={() => { setMenu(false); setRights(true) }}>
                <Icon name="shield" size={16} /> What it may do
              </button>
              <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); setDeleting(true) }}>
                <Icon name="trash" size={16} /> Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>
      {asking ? <AskChange app={app} onClose={() => setAsking(false)} /> : null}
      {rights ? <Rights app={app} onClose={() => setRights(false)} /> : null}
      {deleting ? <DeleteApp app={app} onClose={() => setDeleting(false)} /> : null}
    </div>
  )
}

/** "Edit by asking": his words go to his agent, naming the app. */
export function AskChange({ app, onClose }: { app: MiniAppRow; onClose: () => void }): JSX.Element {
  const [text, setText] = useState('')
  return (
    <Dialog label={`Change ${app.name}`} onClose={onClose}>
      <form
        className="ma-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (text.trim() === '') return
          void agent.miniapps.askChange(app.id, text).then(() => {
            toast('Your agent is changing it.')
            onClose()
          })
        }}
      >
        <div className="h3">Change {app.name}</div>
        <p className="muted">Say what you want different. Your agent changes it, checks it again in light and dark, and keeps the old version so you can go back.</p>
        <textarea className="ma-textarea" rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder="Show only this week, and put the next meeting at the top" aria-label="What to change" />
        <div className="ma-dialog-actions">
          <Button variant="text" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" type="submit" disabled={text.trim() === ''}>
            Ask
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** What the app may read, and which changes it may make without asking each time (only he sets this). */
function Rights({ app, onClose }: { app: MiniAppRow; onClose: () => void }): JSX.Element {
  const rows = app.permissions.map((permission) => {
    const tool = toolOf(permission)
    const args = tool === 'apps_run' ? { slug: permission.slice(permission.indexOf(':') + 1) } : tool === 'webapp_run' ? { app: permission.slice(permission.indexOf(':') + 1).split('/')[0], tool: permission.split('/')[1] } : {}
    const verdict = checkCall(app, tool, args)
    return { permission, reads: verdict.ok && verdict.reads, key: verdict.ok ? verdict.key : permission }
  })
  return (
    <Dialog label={`What ${app.name} may do`} onClose={onClose}>
      <div className="ma-dialog">
        <div className="h3">What {app.name} may do</div>
        <p className="muted">It has no network and sees nothing else of the app. It reads only what is listed; anything that changes something asks you first, unless you allow it here.</p>
        <ul className="ma-rights">
          {rows.length === 0 ? <li className="muted">Nothing: it only shows what it has.</li> : null}
          {rows.map((row) => (
            <li key={row.permission}>
              <span className="ma-right-name">
                <code>{row.permission}</code>
                <span className="small muted">{row.reads ? 'Reads' : 'Changes something'}</span>
              </span>
              {row.reads ? (
                <span className="pill ok">Allowed</span>
              ) : (
                <Switch label="Without asking" on={app.allowed.includes(row.key)} onToggle={(on) => void agent.miniapps.allow(app.id, row.key, on)} />
              )}
            </li>
          ))}
        </ul>
        <div className="ma-dialog-actions">
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function DeleteApp({ app, onClose }: { app: MiniAppRow; onClose: (deleted: boolean) => void }): JSX.Element {
  return (
    <Dialog label={`Delete ${app.name}`} onClose={() => onClose(false)}>
      <div className="ma-dialog">
        <div className="h3">Delete {app.name}?</div>
        <p className="muted">It leaves the Apps page{app.pinned > 0 ? ' and the sidebar' : ''} on every device, with its {app.history.length} kept version{app.history.length === 1 ? '' : 's'}.</p>
        <div className="ma-dialog-actions">
          <Button variant="text" size="sm" onClick={() => onClose(false)}>
            Keep it
          </Button>
          <Button
            size="sm"
            className="danger"
            onClick={() =>
              void agent.miniapps.remove(app.id).then(() => {
                toast(`${app.name} is deleted.`)
                onClose(true)
              })
            }
          >
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
