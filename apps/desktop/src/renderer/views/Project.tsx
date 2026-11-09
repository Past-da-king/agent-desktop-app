import type { MemoryKind, MemoryRow, ProjectRow } from '@agent/core'
import { useMemo, useState } from 'react'

import { agent } from '../bridge'
import { isOpenCard } from '../lib/cards'
import { openChat, startProjectChat } from '../lib/chat-actions'
import { chatPlaces } from '../lib/chat-place'
import { PlaceChip } from '../ui/PlaceChip'
import { chatList, chatOf, chatStatus, STATUS_LABEL } from '../lib/chats'
import { short, timeAgo } from '../lib/format'
import { useChats } from '../state/useChats'
import { useCalmEntity, useEntity, useEntityLoaded } from '../state/useData'
import { useUi } from '../state/useUi'
import { toast } from '../state/useToast'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field } from '../ui/Field'
import { Icon } from '../ui/Icon'
import { ProjectTile } from '../ui/ProjectTile'
import { Skeleton } from '../ui/Skeleton'
import { ProjectDialog } from './ProjectDialog'
import { ProjectWork } from '../shell/HelpersPanel'
import { useProfiles } from './Profiles'
import { hasAccounts, pickLine, pickOfChat } from '../lib/ai'
import { useSettings } from '../state/useSettings'

/** The route id of the Hidden projects list. */
export const HIDDEN_PROJECTS = '_hidden'

const NOTE_KINDS: Array<{ kind: MemoryKind; label: string }> = [
  { kind: 'decision', label: 'Decision' },
  { kind: 'fact', label: 'Fact' },
  { kind: 'how-to', label: 'How-to' },
  { kind: 'project', label: 'Project info' },
]

function kindLabel(kind: MemoryKind): string {
  return NOTE_KINDS.find((each) => each.kind === kind)?.label ?? kind.charAt(0).toUpperCase() + kind.slice(1)
}

/** A note in the project's memory, written by the person. The project's agents read it and add their own. */
function NoteDialog({ project, onClose }: { project: ProjectRow; onClose: () => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<MemoryKind>('decision')
  const [error, setError] = useState('')
  const save = async (): Promise<void> => {
    if (title.trim() === '') {
      setError('Give it a title.')
      return
    }
    await agent.data.upsert('memory', { title: title.trim(), body: body.trim(), kind, topics: project.name.toLowerCase(), pinned: false, source: 'user', project: project.id })
    toast(`Added to ${project.name}'s memory`)
    onClose()
  }
  return (
    <Dialog label="Add to project memory" onClose={onClose} labelledBy="note-dialog-title">
      <div>
        <span className="eyebrow">{project.name.toUpperCase()} MEMORY</span>
        <h2 className="h2" id="note-dialog-title" style={{ marginTop: 6 }}>
          Something its agents should know
        </h2>
      </div>
      <div className="pj-kinds" role="radiogroup" aria-label="What it is">
        {NOTE_KINDS.map((each) => (
          <button key={each.kind} type="button" role="radio" aria-checked={kind === each.kind} className={`chip${kind === each.kind ? ' on' : ''}`} onClick={() => setKind(each.kind)}>
            <span className="chip-t">{each.label}</span>
          </button>
        ))}
      </div>
      <Field
        label="Title"
        value={title}
        onChange={(value) => {
          setTitle(value)
          setError('')
        }}
        placeholder="Launch date moved to 14 November"
        error={error === '' ? undefined : error}
      />
      <div className="field">
        <label htmlFor="note-body">Details</label>
        <textarea id="note-body" className="textarea" value={body} onChange={(event) => setBody(event.target.value)} placeholder="What, why, and who decided." />
      </div>
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            void save()
          }}
        >
          Add to memory
        </Button>
      </div>
    </Dialog>
  )
}

function HiddenProjects({ projects }: { projects: ProjectRow[] }): JSX.Element {
  const navigate = useUi((state) => state.navigate)
  const hidden = projects.filter((project) => project.hidden)
  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">HIDDEN PROJECTS</span>
          <h1 className="h1">{hidden.length === 0 ? 'Nothing hidden' : `${hidden.length} kept off the rail`}</h1>
          <p className="lead">Hidden projects keep their chats and memory. Open one, or put it back on the rail.</p>
        </div>
      </div>
      <div className="pj-list">
        {hidden.map((project) => (
          <div key={project.id} className="pj-row">
            <ProjectTile icon={project.icon} size={40} />
            <button type="button" className="pj-row-t" onClick={() => navigate({ page: 'project', id: project.id })}>
              <b>{project.name}</b>
              <span>{project.description === '' ? `${project.chats.length} ${project.chats.length === 1 ? 'chat' : 'chats'}` : short(project.description, 90)}</span>
            </button>
            <Button
              variant="tonal"
              size="sm"
              onClick={() => {
                void agent.data.upsert('project', { id: project.id, hidden: false })
              }}
            >
              Show on the rail
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * One project: what it is for, its folder and profile, its chats (each its own agent and context, branch allowed),
 * and its own memory (decisions, facts and how-tos its agents read and write).
 */
export function Project({ id }: { id: string }): JSX.Element {
  const projects = useEntity('project')
  const loaded = useEntityLoaded('project')
  const items = useCalmEntity('chat_item')
  const jobs = useEntity('job')
  const devices = useEntity('device')
  const places = useMemo(() => chatPlaces(jobs, devices), [jobs, devices])
  const memories = useEntity('memory')
  const profiles = useProfiles() ?? []
  const settings = useSettings((state) => state.settings)
  const runs = useChats((state) => state.runs)
  const seen = useChats((state) => state.seen)
  const since = useChats((state) => state.since)
  const navigate = useUi((state) => state.navigate)
  const selectMemory = useUi((state) => state.selectMemory)
  const [editing, setEditing] = useState(false)
  const [noting, setNoting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const project = projects.find((each) => each.id === id)

  const chats = useMemo(() => {
    if (project === undefined) return []
    const own = items.filter((item) => project.chats.includes(chatOf(item)))
    const cards = new Map<string, number>()
    for (const item of own) if (isOpenCard(item)) cards.set(chatOf(item), (cards.get(chatOf(item)) ?? 0) + 1)
    const listed = chatList(own)
    // A chat the agent just started on another device has no rows here until that device writes them back: list it
    // at once, so it is there to open and message.
    for (const chat of project.chats) {
      if (!listed.some((entry) => entry.id === chat)) listed.push({ id: chat, title: 'New chat', at: Number.MAX_SAFE_INTEGER, lastReplyAt: 0, branch: false, device: 'desk' })
    }
    return listed.sort((a, b) => b.at - a.at).map((entry) => ({ entry, status: chatStatus(entry, runs[entry.id], seen[entry.id] ?? since, false, cards.get(entry.id) ?? 0) }))
  }, [project, items, runs, seen, since])
  const notes = useMemo(() => (project === undefined ? [] : memories.filter((memory) => memory.project === project.id).sort((a, b) => b.updatedAt - a.updatedAt)), [project, memories])

  if (id === HIDDEN_PROJECTS) return <HiddenProjects projects={projects} />
  if (project === undefined) {
    return <div className="page">{loaded ? <p className="lead">This project is gone.</p> : <Skeleton rows={4} />}</div>
  }
  const profile = profiles.find((each) => each.id === project.profile)

  return (
    <div className="page pj-page">
      <div className="ph">
        <div className="pj-head">
          <ProjectTile icon={project.icon} size={64} />
          <div style={{ minWidth: 0 }}>
            <span className="eyebrow">PROJECT{project.hidden ? ' · HIDDEN' : ''}</span>
            <h1 className="h1">{project.name}</h1>
            {project.description === '' ? null : <p className="lead">{project.description}</p>}
            <div className="pj-facts">
              <span className="pj-fact" title={project.path === '' ? undefined : project.path}>
                <Icon name="folder" size={15} />
                {project.path === '' ? 'No folder' : short(project.path, 60)}
              </span>
              <span className="pj-fact">
                <Icon name="person" size={15} />
                {profile === undefined ? 'General profile' : `${profile.name} profile`}
              </span>
              {settings !== null && hasAccounts(settings) ? (
                <span className="pj-fact" title={`Helpers: ${pickLine(settings, pickOfChat(settings, project, 'helpers'))}`}>
                  <Icon name="bolt" size={15} />
                  {pickLine(settings, pickOfChat(settings, project, 'main'))}
                </span>
              ) : null}
              {(project.aliases ?? []).length > 0 ? (
                <span className="pj-fact" title="Other names search finds it by. Edit to change them.">
                  <Icon name="search" size={15} />
                  {short(`Also: ${(project.aliases ?? []).join(', ')}`, 60)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="ph-actions">
          <Button variant="tonal" onClick={() => setEditing(true)}>
            <Icon name="edit" size={18} />
            Edit
          </Button>
          <Button
            onClick={() => {
              void startProjectChat(project).then(() => navigate({ page: 'chat' }))
            }}
          >
            <Icon name="plus" size={18} />
            New chat
          </Button>
        </div>
      </div>

      <ProjectWork project={project} />

      <section className="pj-sec">
        <div className="sec">
          <span className="eyebrow">CHATS</span>
          <span className="sec-line">Each chat is its own agent with its own context, working in this project.</span>
        </div>
        {chats.length === 0 ? (
          <div className="pj-empty">
            <p>No chats yet. Start one and give it a job, or ask the main agent to start one here.</p>
            <Button
              variant="tonal"
              size="sm"
              onClick={() => {
                void startProjectChat(project).then(() => navigate({ page: 'chat' }))
              }}
            >
              Start a chat
            </Button>
          </div>
        ) : (
          <div className="pj-list">
            {chats.map(({ entry, status }) => (
              <button
                key={entry.id}
                type="button"
               
                className={`pj-row tap st-${status}`}
                onClick={() => {
                  openChat(entry.id)
                }}
              >
                <span className={`cstat ${status}`} aria-hidden="true">
                  {status === 'idle' ? <Icon name={entry.branch ? 'branch' : 'chat'} size={16} /> : <i />}
                </span>
                <span className="pj-row-t">
                  <b>{entry.title}<PlaceChip name={places.get(entry.id) ?? ''} /></b>
                  <span>{STATUS_LABEL[status] === '' ? timeAgo(entry.at) : STATUS_LABEL[status]}</span>
                </span>
                <Icon name="chev" size={18} />
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="pj-sec">
        <div className="sec pj-sec-h">
          <div>
            <span className="eyebrow">PROJECT MEMORY</span>
            <span className="sec-line">Decisions, facts and how-tos for this project. Its agents read these and add their own.</span>
          </div>
          <Button variant="tonal" size="sm" onClick={() => setNoting(true)}>
            <Icon name="plus" size={16} />
            Add
          </Button>
        </div>
        {notes.length === 0 ? (
          <div className="pj-empty">
            <p>Nothing yet. What its agents learn here lands in this list, and you can add a decision or a fact yourself.</p>
          </div>
        ) : (
          <div className="pj-notes">
            {notes.map((note: MemoryRow) => (
              <button
                key={note.id}
                type="button"
                className="pj-note"
                onClick={() => {
                  selectMemory(note.id)
                  navigate({ page: 'memory' })
                }}
              >
                <span className="pj-note-top">
                  <span className="pill">{kindLabel(note.kind)}</span>
                  <span className="small muted">{timeAgo(note.updatedAt)}</span>
                </span>
                <b>{note.title}</b>
                <span className="pj-note-body">{short(note.body.replace(/\s+/g, ' '), 160)}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      <div className="pj-danger">
        {deleting ? (
          <>
            <span>Delete {project.name}? Its chats and memory stay in your history and search.</span>
            <Button variant="text" size="sm" onClick={() => setDeleting(false)}>
              Keep it
            </Button>
            <Button
              size="sm"
              onClick={() => {
                void agent.data.remove('project', project.id).then(() => navigate({ page: 'home' }))
              }}
            >
              Delete
            </Button>
          </>
        ) : (
          <Button variant="text" size="sm" onClick={() => setDeleting(true)}>
            Delete project
          </Button>
        )}
      </div>

      {editing ? <ProjectDialog project={project} onClose={() => setEditing(false)} /> : null}
      {noting ? <NoteDialog project={project} onClose={() => setNoting(false)} /> : null}
    </div>
  )
}
