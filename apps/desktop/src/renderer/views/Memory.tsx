import type { MemoryKind, MemoryRow } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { kindLabel, short, timeAgo } from '../lib/format'
import {
  MEMORY_TYPES,
  findPage,
  groupByKind,
  kindCounts,
  linkedNames,
  linkTargets,
  newPage,
  plainBody,
  searchMemories,
  type MemoryKindFilter,
} from '../lib/memory'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Field } from '../ui/Field'
import { Icon, type IconName } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { Markdown } from '../ui/Markdown'
import { Skeleton } from '../ui/Skeleton'
import { MemoryHistoryDialog, useMemoryHistory, versionLine } from './MemoryHistory'
import { MemoryUpkeep } from './MemoryUpkeep'
import { Pill } from '../ui/bits'

const KIND_ORDER: MemoryKind[] = MEMORY_TYPES.map((type) => type.kind)

const KIND_ICONS: Record<MemoryKind, IconName> = {
  person: 'person',
  organisation: 'building',
  project: 'folder',
  'how-to': 'sliders',
  decision: 'bolt',
  preference: 'heart',
  fact: 'memory',
  event: 'cal',
  skill: 'apps',
}

/** Rows shown per kind before "Show all", and per step of a long filtered list. */
const SECTION_ROWS = 6
const LIST_STEP = 60

function MemoryDialog({
  memory,
  onClose,
}: {
  memory: MemoryRow | null
  onClose: () => void
}): JSX.Element {
  const selectMemory = useUi((state) => state.selectMemory)
  const [title, setTitle] = useState(memory?.title ?? '')
  const [body, setBody] = useState(memory?.body ?? '')
  const [kind, setKind] = useState<MemoryKind>(memory?.kind ?? 'fact')
  const [topics, setTopics] = useState(memory?.topics ?? '')
  const [aliases, setAliases] = useState(memory?.aliases ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async (): Promise<void> => {
    if (title.trim() === '') {
      setError('Give the page a title first.')
      return
    }
    setBusy(true)
    const now = Date.now()
    const row: MemoryRow = {
      id: memory?.id ?? '',
      createdAt: memory?.createdAt ?? now,
      title: title.trim(),
      body: body.trim(),
      kind,
      topics: topics.trim(),
      aliases: aliases
        .split(',')
        .map((alias) => alias.trim())
        .filter(Boolean)
        .join(', '),
      pinned: memory?.pinned ?? false,
      source: memory?.source ?? 'user',
      updatedAt: now,
    }
    try {
      const saved = await agent.data.upsert('memory', row)
      selectMemory(saved.id)
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save that page.')
      setBusy(false)
    }
  }

  return (
    <Dialog label={memory ? 'Edit page' : 'New page'} onClose={onClose} labelledBy="memory-dialog-title">
      <div>
        <span className="eyebrow">{memory ? 'EDIT PAGE' : 'NEW PAGE'}</span>
        <h2 className="h2" id="memory-dialog-title" style={{ marginTop: 6 }}>
          {memory ? memory.title : 'What should I remember?'}
        </h2>
      </div>
      <Field
        label="Title"
        value={title}
        onChange={(value) => {
          setTitle(value)
          setError('')
        }}
        error={error}
        placeholder="Nomsa"
      />
      <div className="field">
        <label htmlFor="memory-body">Page</label>
        <textarea
          id="memory-body"
          className="textarea"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Write it plainly. Link other pages with [[double brackets]]."
          style={{ minHeight: 160 }}
        />
      </div>
      <div className="task-grid">
        <div className="field">
          <label htmlFor="memory-kind">Kind</label>
          <select
            id="memory-kind"
            className="input"
            value={kind}
            onChange={(event) => setKind(event.target.value as MemoryKind)}
          >
            {KIND_ORDER.map((item) => (
              <option key={item} value={item}>
                {kindLabel(item)}
              </option>
            ))}
          </select>
        </div>
        <Field
          label="Topics"
          value={topics}
          onChange={setTopics}
          placeholder="work, travel"
        />
      </div>
      <Field
        label="Other names it answers to"
        value={aliases}
        onChange={setAliases}
        placeholder="How dictation mis-hears it, nicknames: Initeck, Initech Corp"
      />
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            void save()
          }}
          disabled={busy}
        >
          {busy ? 'Saving...' : memory ? 'Save page' : 'Create page'}
        </Button>
      </div>
    </Dialog>
  )
}

function CreatePageDialog({ name, onClose }: { name: string; onClose: () => void }): JSX.Element {
  const selectMemory = useUi((state) => state.selectMemory)
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await agent.data.upsert('memory', newPage(name))
      selectMemory(saved.id)
      onClose()
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not create that page.')
      setBusy(false)
    }
  }

  return (
    <Dialog label="Create page" onClose={onClose} labelledBy="create-page-title">
      <div>
        <span className="eyebrow">MISSING PAGE</span>
        <h2 className="h2" id="create-page-title" style={{ marginTop: 6 }}>
          Create {name}?
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          This page does not exist yet. Make it now and the link will point to it from here on.
        </p>
      </div>
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Not now
        </Button>
        <Button
          onClick={() => {
            void create()
          }}
          disabled={busy}
        >
          {busy ? 'Creating...' : 'Create page'}
        </Button>
      </div>
    </Dialog>
  )
}

function LinkGraph({
  memory,
  links,
  onSelect,
}: {
  memory: MemoryRow
  links: MemoryRow[]
  onSelect: (id: string) => void
}): JSX.Element {
  const spots: Array<[number, number]> = [
    [90, 48],
    [410, 48],
    [90, 168],
    [410, 168],
    [250, 22],
  ]
  const nodes = links.slice(0, 5).map((link, index) => {
    const [x, y] = spots[index] ?? [250, 22]
    return { link, x, y }
  })
  const centerWidth = Math.min(300, memory.title.length * 7 + 36)

  return (
    <div className="graph">
      <svg viewBox="0 0 500 210" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Linked pages">
        {nodes.map((node) => (
          <line
            key={`line-${node.link.id}`}
            x1="250"
            y1="105"
            x2={node.x}
            y2={node.y}
            stroke="var(--outline)"
            strokeWidth="1.5"
            strokeOpacity=".6"
          />
        ))}
        <rect x={250 - centerWidth / 2} y="85" width={centerWidth} height="40" rx="20" fill="var(--primary)" />
        <text x="250" y="110" textAnchor="middle" className="gnode" fill="var(--on-primary)">
          {short(memory.title, 34)}
        </text>
        {nodes.map((node) => {
          const width = Math.min(190, node.link.title.length * 6.8 + 30)
          return (
            <g
              key={node.link.id}
              style={{ cursor: 'pointer' }}
              onClick={() => onSelect(node.link.id)}
              role="presentation"
            >
              <rect x={node.x - width / 2} y={node.y - 16} width={width} height="32" rx="16" fill="var(--sc)" />
              <text x={node.x} y={node.y + 4} textAnchor="middle" className="gnode" fill="var(--on-sc)">
                {short(node.link.title, 22)}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export function Memory(): JSX.Element {
  const settings = useSettings((state) => state.settings)
  const memories = useEntity('memory')
  const loaded = useEntityLoaded('memory')
  const query = useUi((state) => state.memQuery)
  const setQuery = useUi((state) => state.setMemoryQuery)
  const filter = useUi((state) => state.memKind)
  const setFilter = useUi((state) => state.setMemoryKind)
  const selectedId = useUi((state) => state.memSel)
  const selectMemory = useUi((state) => state.selectMemory)
  const only = useUi((state) => state.memOnly)
  const showMemories = useUi((state) => state.showMemories)
  const [input, setInput] = useState(query)
  const [editing, setEditing] = useState<MemoryRow | 'new' | null>(null)
  const [creating, setCreating] = useState<string | null>(null)
  const [shown, setShown] = useState(LIST_STEP)
  const [historyOf, setHistoryOf] = useState<MemoryRow | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setQuery(input), 150)
    return () => clearTimeout(timer)
  }, [input, setQuery])

  useEffect(() => {
    setShown(LIST_STEP)
  }, [query, filter, only])

  const agentName = settings?.agentName.trim() || 'your agent'
  const scope = only === null ? memories : memories.filter((memory) => only.includes(memory.id))
  const filtered = searchMemories(scope, query, filter)
  const pinned = filtered.filter((memory) => memory.pinned)
  const rest = filtered.filter((memory) => !memory.pinned)
  const counts = kindCounts(scope)
  // With no search and no kind chosen, the list is organised by kind; otherwise it is one flat list.
  const sectioned = query.trim() === '' && filter === 'all' && only === null
  // Closed pages are done: out of the kind groups, together at the end, kept for the record.
  const groups = sectioned ? groupByKind(rest.filter((memory) => memory.status !== 'closed')) : []
  const closed = sectioned ? rest.filter((memory) => memory.status === 'closed') : []
  const selected = filtered.find((memory) => memory.id === selectedId) ?? filtered[0] ?? null
  const links = selected ? linkTargets(selected, memories) : []
  const topicList = selected ? selected.topics.split(',').map((topic) => topic.trim()).filter(Boolean) : []
  const aliasList = selected ? (selected.aliases ?? '').split(',').map((alias) => alias.trim()).filter(Boolean) : []
  const versions = useMemoryHistory(selected?.id ?? null, selected?.updatedAt ?? 0)

  const openLink = (name: string): void => {
    const page = findPage(memories, name)
    if (page) selectMemory(page.id)
    else setCreating(name)
  }

  const remove = (memory: MemoryRow): void => {
    selectMemory(null)
    void agent.data
      .remove('memory', memory.id)
      .then(() => {
        toast('Page deleted.', {
          actionLabel: 'Undo',
          onAction: () => {
            void agent.data.upsert('memory', memory)
          },
        })
      })
      .catch((cause: unknown) => {
        toast(cause instanceof Error ? cause.message : 'Could not delete that page.')
      })
  }

  const renderRow = (memory: MemoryRow): JSX.Element => {
    const count = linkedNames(memory.body).length
    return (
      <button
        key={memory.id}
        type="button"
        className={`mrow${selected?.id === memory.id ? ' on' : ''}${memory.status === 'closed' ? ' closed' : ''}`}
        onClick={() => selectMemory(memory.id)}
      >
        <span className={`mi2${memory.pinned ? ' pri' : ''}`}>
          <Icon name={KIND_ICONS[memory.kind]} size={22} />
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <div className="mt">
            {memory.title}
            {memory.status === 'closed' ? <Pill tone="ok">Closed</Pill> : null}
          </div>
          <div className="ms">{plainBody(memory.body)}</div>
          <div className="mm">
            {kindLabel(memory.kind)} · {count === 1 ? '1 link' : `${count} links`} · {timeAgo(memory.updatedAt)}
          </div>
        </span>
      </button>
    )
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">MEMORY</span>
          <h1 className="h1">
            {memories.length === 0
              ? 'What your agent knows about your world'
              : `${memories.length} ${memories.length === 1 ? 'page' : 'pages'} your agent keeps about your world`}
          </h1>
        </div>
        <div className="ph-actions">
          <Button onClick={() => setEditing('new')}>
            <Icon name="plus" size={18} />
            New page
          </Button>
        </div>
      </div>

      {!loaded ? (
        <Skeleton rows={6} />
      ) : memories.length === 0 ? (
        <EmptyState
          mascot={settings?.mascot ?? 'scout'}
          title="No pages yet"
          line="When you tell the agent something worth keeping, it writes a page here. You can write one too."
          action={
            <Button variant="tonal" size="sm" onClick={() => setEditing('new')}>
              Write the first page
            </Button>
          }
        />
      ) : (
        <div className="list-detail">
          <div>
            <MemoryUpkeep />
            {only !== null ? (
              <div className="mem-only" role="status">
                <Icon name="memory" size={16} />
                <span>
                  <b>From the last chat:</b> {scope.length} {scope.length === 1 ? 'page' : 'pages'} saved or updated
                </span>
                <Button variant="text" size="sm" onClick={() => showMemories(null)}>
                  Show everything
                </Button>
              </div>
            ) : null}
            <label className="search" htmlFor="memory-search">
              <Icon name="search" size={22} />
              <input
                id="memory-search"
                placeholder="Search people, places, anything"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                autoComplete="off"
              />
            </label>

            <div style={{ display: 'flex', gap: 8, margin: '14px 0 18px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`chip${filter === 'all' ? ' on' : ''}`}
                onClick={() => setFilter('all')}
              >
                All
              </button>
              {MEMORY_TYPES.filter((type) => (counts[type.kind] ?? 0) > 0 || filter === type.kind).map((type) => (
                <button
                  key={type.kind}
                  type="button"
                  className={`chip${filter === type.kind ? ' on' : ''}`}
                  onClick={() => setFilter(type.kind as MemoryKindFilter)}
                >
                  <Icon name={KIND_ICONS[type.kind]} size={16} />
                  {type.label}
                  <span className="chip-n">{(counts[type.kind] ?? 0).toLocaleString('en')}</span>
                </button>
              ))}
            </div>

            {filtered.length === 0 ? (
              <div className="card" style={{ textAlign: 'center', padding: '36px 20px' }}>
                <div className="h3">{query ? `Nothing matches "${query}"` : 'Nothing in this kind yet'}</div>
                <p className="muted" style={{ marginTop: 6 }}>
                  Try a name, a place, or a thing you told {agentName}.
                </p>
              </div>
            ) : (
              <>
                {pinned.length > 0 ? (
                  <>
                    <div className="sec" style={{ margin: '4px 8px 6px' }}>
                      <span className="eyebrow">PINNED</span>
                      <span className="sec-line">Always on your agent's mind</span>
                    </div>
                    {pinned.map(renderRow)}
                  </>
                ) : null}

                {sectioned
                  ? groups.map((group) => (
                      <section key={group.kind}>
                        <div className="sec" style={{ margin: '16px 8px 6px' }}>
                          <span className="eyebrow">
                            {group.label.toUpperCase()} · {group.rows.length.toLocaleString('en')}
                          </span>
                          <span className="sec-line">{group.line}</span>
                        </div>
                        {group.rows.slice(0, SECTION_ROWS).map(renderRow)}
                        {group.rows.length > SECTION_ROWS ? (
                          <div className="mem-more">
                            <Button variant="text" size="sm" onClick={() => setFilter(group.kind as MemoryKindFilter)}>
                              Show all {group.rows.length.toLocaleString('en')} {group.label.toLowerCase()}
                            </Button>
                          </div>
                        ) : null}
                      </section>
                    )).concat(
                      closed.length > 0
                        ? [
                            <section key="closed">
                              <div className="sec" style={{ margin: '16px 8px 6px' }}>
                                <span className="eyebrow">CLOSED · {closed.length.toLocaleString('en')}</span>
                                <span className="sec-line">Done and ticked off. Kept, searchable, no longer brought up</span>
                              </div>
                              {closed.slice(0, SECTION_ROWS).map(renderRow)}
                              {closed.length > SECTION_ROWS ? (
                                <div className="mem-more">
                                  <Button variant="text" size="sm" onClick={() => setInput('is:closed')}>
                                    Show all {closed.length.toLocaleString('en')} closed
                                  </Button>
                                </div>
                              ) : null}
                            </section>,
                          ]
                        : [],
                    )
                  : rest.length > 0 ? (
                      <>
                        <div className="sec" style={{ margin: '16px 8px 6px' }}>
                          <span className="eyebrow">
                            {filter === 'all' ? 'MATCHES' : (MEMORY_TYPES.find((type) => type.kind === filter)?.label ?? kindLabel(filter)).toUpperCase()} · {rest.length.toLocaleString('en')}
                          </span>
                          <span className="sec-line">Newest first</span>
                        </div>
                        {rest.slice(0, shown).map(renderRow)}
                        {rest.length > shown ? (
                          <div className="mem-more">
                            <Button variant="text" size="sm" onClick={() => setShown(shown + LIST_STEP)}>
                              Show {Math.min(LIST_STEP, rest.length - shown)} more
                            </Button>
                          </div>
                        ) : null}
                      </>
                    ) : null}
              </>
            )}
          </div>

          {selected ? (
            <div className="detail">
              <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                <span className="mi2 pri" style={{ width: 56, height: 56 }}>
                  <Icon name={KIND_ICONS[selected.kind]} size={26} />
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span className="eyebrow">{kindLabel(selected.kind).toUpperCase()}</span>
                  <h2 className="h2">{selected.title}</h2>
                  {versionLine(versions[0]) === '' ? null : (
                    <button type="button" className="mem-ver" onClick={() => setHistoryOf(selected)}>
                      <Icon name="clock" size={14} />
                      {versionLine(versions[0])}
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="ib tonal"
                  aria-label="Delete page"
                  onClick={() => remove(selected)}
                >
                  <Icon name="trash" size={20} />
                </button>
              </div>

              {selected.status === 'closed' ? (
                <div className="mem-closed" role="status">
                  <Icon name="check" size={18} />
                  <span>
                    <b>Closed{selected.closedAt ? ` ${timeAgo(selected.closedAt)}` : ''}.</b> Done and ticked off. Agents can still find it, but it no longer comes up on its own.
                  </span>
                </div>
              ) : null}

              <div className="mem-body">
                <Markdown text={selected.body} onWikiLink={openLink} />
              </div>

              {aliasList.length > 0 ? (
                <div>
                  <span className="eyebrow mute">ALSO CALLED</span>
                  <div className="mem-chips" style={{ marginTop: 8 }}>
                    {aliasList.map((alias) => (
                      <span className="chip" key={alias}>
                        {alias}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {topicList.length > 0 ? (
                <div className="mem-chips">
                  {topicList.map((topic) => (
                    <span className="chip" key={topic}>
                      {topic}
                    </span>
                  ))}
                </div>
              ) : null}

              <div>
                <span className="eyebrow mute">HOW THEY CONNECT</span>
                <div style={{ marginTop: 8 }}>
                  <LinkGraph memory={selected} links={links} onSelect={selectMemory} />
                </div>
              </div>

              <div>
                <span className="eyebrow mute">LINKED PAGES</span>
                <div className="mem-chips" style={{ marginTop: 8 }}>
                  {links.length === 0 ? (
                    <p className="small muted">No links yet. Write [[a page name]] to connect this one.</p>
                  ) : (
                    links.map((link) => (
                      <button
                        key={link.id}
                        type="button"
                        className="chip"
                        onClick={() => selectMemory(link.id)}
                      >
                        <Icon name={KIND_ICONS[link.kind]} size={16} />
                        {link.title}
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="say" style={{ background: 'var(--s-mid)', color: 'var(--on-bg)' }}>
                <Mascot id={settings?.mascot ?? 'scout'} size={40} />
                <p>
                  Edit this page and {agentName} uses your version from now on, on every device.
                </p>
              </div>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <Button onClick={() => setEditing(selected)}>
                  <Icon name="edit" size={18} />
                  Edit page
                </Button>
                <Button
                  variant="tonal"
                  onClick={() => {
                    void agent.data.upsert('memory', { ...selected, pinned: !selected.pinned }).catch((cause: unknown) => {
                      toast(cause instanceof Error ? cause.message : 'Could not change that page.')
                    })
                  }}
                >
                  {selected.pinned ? 'Unpin' : 'Pin it'}
                </Button>
                <Button
                  variant="tonal"
                  onClick={() => {
                    const closing = selected.status !== 'closed'
                    void agent.data
                      .upsert('memory', { id: selected.id, status: closing ? 'closed' : 'open', closedAt: closing ? Date.now() : null })
                      .then(() => toast(closing ? 'Closed. It stays searchable and stops coming up.' : 'Open again.'))
                      .catch((cause: unknown) => {
                        toast(cause instanceof Error ? cause.message : 'Could not change that page.')
                      })
                  }}
                >
                  <Icon name={selected.status === 'closed' ? 'sync' : 'check'} size={18} />
                  {selected.status === 'closed' ? 'Open again' : 'Close it'}
                </Button>
                <Button variant="text" onClick={() => setHistoryOf(selected)}>
                  <Icon name="clock" size={18} />
                  History
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {editing !== null ? (
        <MemoryDialog memory={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      {creating ? <CreatePageDialog name={creating} onClose={() => setCreating(null)} /> : null}
      {historyOf !== null ? (
        <MemoryHistoryDialog memory={memories.find((memory) => memory.id === historyOf.id) ?? historyOf} onClose={() => setHistoryOf(null)} />
      ) : null}
    </div>
  )
}
