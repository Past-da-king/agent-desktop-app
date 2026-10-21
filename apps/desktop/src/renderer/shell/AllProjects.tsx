import type { ProjectRow } from '@agent/core'
import { useMemo, useState } from 'react'

import { agent } from '../bridge'
import { RAIL_PROJECTS, onRail, railHasRoom, railProjects } from '../lib/projects'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { ProjectTile } from '../ui/ProjectTile'

/**
 * Every project, from the rail's + tile: open one, choose the few the rail shows (pin), find one by name, see the
 * hidden ones, or make a new one. The rail itself stays short, so it never squeezes.
 */
export function AllProjects({
  projects,
  statusOf,
  onNew,
  onClose,
}: {
  projects: ProjectRow[]
  statusOf: (project: ProjectRow) => 'waiting' | 'working' | null
  onNew: () => void
  onClose: () => void
}): JSX.Element {
  const navigate = useUi((store) => store.navigate)
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const match = (project: ProjectRow): boolean => q === '' || `${project.name} ${project.description}`.toLowerCase().includes(q)
  const chosen = projects.some(onRail)
  // Until the person pins any, the rail shows the oldest few; pinning starts from what they already see.
  const onRailNow = useMemo(() => new Set(railProjects(projects).map((project) => project.id)), [projects])
  const room = chosen ? railHasRoom(projects) : true
  // The rail's five first, in rail order, then the rest by name.
  const railed = railProjects(projects).filter(match)
  const visible = projects.filter((project) => !project.hidden && !onRailNow.has(project.id) && match(project)).sort((a, b) => a.name.localeCompare(b.name))
  const hidden = projects.filter((project) => project.hidden && match(project)).sort((a, b) => a.name.localeCompare(b.name))

  const togglePin = async (project: ProjectRow): Promise<void> => {
    const now = Date.now()
    if (!chosen) {
      // The first choice: what the rail already shows becomes the person's own list, then this change applies.
      const current = railProjects(projects)
      await Promise.all(current.map((each, index) => agent.data.upsert('project', { id: each.id, railAt: now - (current.length - index) })))
      if (onRailNow.has(project.id)) await agent.data.upsert('project', { id: project.id, railAt: null })
      else if (current.length < RAIL_PROJECTS) await agent.data.upsert('project', { id: project.id, railAt: now })
      return
    }
    await agent.data.upsert('project', { id: project.id, railAt: onRail(project) ? null : now })
  }

  const open = (project: ProjectRow): void => {
    onClose()
    navigate({ page: 'project', id: project.id })
  }

  const tile = (project: ProjectRow): JSX.Element => {
    const pinned = onRailNow.has(project.id)
    const canPin = pinned || room
    const status = statusOf(project)
    return (
      <li key={project.id} className={`ap-item${pinned ? ' pinned' : ''}`}>
        <button type="button" className="ap-open" onClick={() => open(project)} title={project.description === '' ? project.name : `${project.name}: ${project.description}`}>
          <ProjectTile icon={project.icon} size={48} status={status} />
          <span className="ap-name">{project.name}</span>
        </button>
        {project.hidden ? null : (
          <button
            type="button"
            className={`ap-pin${pinned ? ' on' : ''}`}
            aria-pressed={pinned}
            disabled={!canPin}
            aria-label={pinned ? `Take ${project.name} off the rail` : canPin ? `Put ${project.name} on the rail` : `The rail holds ${RAIL_PROJECTS}. Take one off first`}
            title={pinned ? 'On the rail. Tap to take it off' : canPin ? 'Put it on the rail' : `The rail holds ${RAIL_PROJECTS}. Take one off first`}
            onClick={() => {
              void togglePin(project)
            }}
          >
            <Icon name="pin" size={15} />
          </button>
        )}
      </li>
    )
  }

  return (
    <Dialog label="All projects" onClose={onClose} className="ap-dialog">
      <div className="ap-head">
        <div>
          <span className="eyebrow">PROJECTS</span>
          <h2 className="h2">All projects</h2>
          <p className="small muted ap-lead">Pin up to {RAIL_PROJECTS} to keep them on the rail; the rest live here.</p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            onClose()
            onNew()
          }}
        >
          <Icon name="plus" size={18} />
          New project
        </Button>
      </div>
      <label className="mlist-search ap-search">
        <Icon name="search" size={18} />
        <input value={query} autoFocus placeholder={`Search ${projects.length} projects`} aria-label="Search projects" onChange={(event) => setQuery(event.target.value)} />
      </label>
      {railed.length === 0 && visible.length === 0 && hidden.length === 0 ? (
        <p className="small muted ap-empty">{q === '' ? 'No projects yet. Make one to give a piece of work its own chats, memory and folder.' : `No project called "${query.trim()}".`}</p>
      ) : null}
      {railed.length > 0 ? (
        <>
          <div className="eyebrow mute ap-sub">
            ON THE RAIL <span className="ap-count">{onRailNow.size} of {RAIL_PROJECTS}</span>
          </div>
          <ul className="ap-grid">{railed.map(tile)}</ul>
        </>
      ) : null}
      {visible.length > 0 ? (
        <>
          <div className="eyebrow mute ap-sub">ALL PROJECTS</div>
          <ul className="ap-grid">{visible.map(tile)}</ul>
        </>
      ) : null}
      {hidden.length > 0 ? (
        <>
          <div className="eyebrow mute ap-sub">HIDDEN</div>
          <ul className="ap-grid">{hidden.map(tile)}</ul>
        </>
      ) : null}
    </Dialog>
  )
}
