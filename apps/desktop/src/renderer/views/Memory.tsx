import type { MemoryKind, MemoryRow } from '@agent/core'
import { Fragment, useState } from 'react'

import { agent } from '../bridge'
import { kindLabel, short, timeAgo } from '../lib/format'
import { useEntity, useEntityLoaded } from '../state/useData'
import { useSettings } from '../state/useSettings'
import { useUi, type MemoryFilter } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Field } from '../ui/Field'
import { Icon, type IconName } from '../ui/Icon'
import { Mascot } from '../ui/Mascot'
import { Skeleton } from '../ui/Skeleton'

const KIND_ORDER: MemoryKind[] = ['person', 'fact', 'preference', 'decision', 'how-to', 'event', 'skill']

const KIND_ICONS: Record<MemoryKind, IconName> = {
  person: 'person',
  fact: 'building',
  preference: 'heart',
  decision: 'bolt',
  'how-to': 'clock',
  event: 'cal',
  skill: 'bolt',
}

const LINK = /\[\[([^\]]+)\]\]/g

function linkedNames(body: string): string[] {
  const names: string[] = []
  for (const match of body.matchAll(LINK)) {
    const name = match[1]?.trim()
    if (name && !names.includes(name)) names.push(name)
  }
  return names
}

function linkTargets(memory: MemoryRow, all: MemoryRow[]): MemoryRow[] {
  return linkedNames(memory.body)
    .map((name) => all.find((item) => item.title.toLowerCase() === name.toLowerCase()))
    .filter((item): item is MemoryRow => item !== undefined)
}

function plainBody(body: string): string {
  return body.replace(/\[\[([^\]]+)\]\]/g, '$1')
}

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
      topics: memory?.topics ?? '',
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
      <div className="field">
        <label htmlFor="memory-kind">Kind</label>
        <select
          id="memory-kind"
          className="input"
          value={kind}
          onChange={(event) => setKind(event.target.value as MemoryKind)}
          style={{ paddingRight: 18 }}
        >
          {KIND_ORDER.map((item) => (
            <option key={item} value={item}>
              {kindLabel(item)}
            </option>
          ))}
        </select>
      </div>
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

function DeleteDialog({ memory, onClose }: { memory: MemoryRow; onClose: () => void }): JSX.Element {
  const selectMemory = useUi((state) => state.selectMemory)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog label="Delete page" onClose={onClose} labelledBy="delete-memory-title">
      <div>
        <span className="eyebrow">DELETE PAGE</span>
        <h2 className="h2" id="delete-memory-title" style={{ marginTop: 6 }}>
          Delete {memory.title}?
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          This removes the page from this computer and from sync. It cannot be undone.
        </p>
      </div>
      <div className="dialog-actions">
        <Button variant="text" onClick={onClose}>
          Keep it
        </Button>
        <Button
          variant="line"
          style={{ color: 'var(--err)', borderColor: 'var(--err)' }}
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void agent.data
              .remove('memory', memory.id)
              .then(() => {
                selectMemory(null)
                onClose()
              })
              .catch(() => setBusy(false))
          }}
        >
          {busy ? 'Deleting...' : 'Delete page'}
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
  const [editing, setEditing] = useState<MemoryRow | 'new' | null>(null)
  const [deleting, setDeleting] = useState<MemoryRow | null>(null)

  const agentName = settings?.agentName.trim() || 'your agent'
  const kinds = KIND_ORDER.filter((kind) => memories.some((memory) => memory.kind === kind))
  const q = query.trim().toLowerCase()
  const filtered = memories
    .filter((memory) => filter === 'all' || memory.kind === filter)
    .filter((memory) => q === '' || `${memory.title} ${memory.body} ${memory.topics}`.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const pinned = filtered.filter((memory) => memory.pinned)
  const rest = filtered.filter((memory) => !memory.pinned)
  const selected = filtered.find((memory) => memory.id === selectedId) ?? filtered[0] ?? null
  const links = selected ? linkTargets(selected, memories) : []
  const nameToMemory = new Map(memories.map((memory) => [memory.title.toLowerCase(), memory]))

  const bodyNodes = (memory: MemoryRow): JSX.Element => {
    const parts = memory.body.split(/(\[\[[^\]]+\]\])/g)
    return (
      <p style={{ fontSize: 16, lineHeight: 1.65 }}>
        {parts.map((part, index) => {
          const match = /^\[\[([^\]]+)\]\]$/.exec(part)
          if (match) {
            const name = match[1] ?? ''
            const target = nameToMemory.get(name.toLowerCase())
            if (target) {
              return (
                <button
                  key={`${memory.id}-link-${index}`}
                  type="button"
                  className="linkish"
                  onClick={() => selectMemory(target.id)}
                >
                  {name}
                </button>
              )
            }
          }
          return <Fragment key={`${memory.id}-part-${index}`}>{part}</Fragment>
        })}
      </p>
    )
  }

  return (
    <div className="page">
      <div className="ph">
        <div>
          <span className="eyebrow">MEMORY</span>
          <h1 className="h1">
            {memories.length} {memories.length === 1 ? 'page' : 'pages'} your agent keeps about your world
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
        <div className="md">
          <div>
            <label className="search" htmlFor="memory-search">
              <Icon name="search" size={22} />
              <input
                id="memory-search"
                placeholder="Search people, places, anything"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
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
              {kinds.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className={`chip${filter === kind ? ' on' : ''}`}
                  onClick={() => setFilter(kind as MemoryFilter)}
                >
                  <Icon name={KIND_ICONS[kind]} size={16} />
                  {kindLabel(kind)}
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
                    {pinned.map((memory) => {
                      const count = linkedNames(memory.body).length
                      return (
                        <button
                          key={memory.id}
                          type="button"
                          className={`mrow${selected?.id === memory.id ? ' on' : ''}`}
                          onClick={() => selectMemory(memory.id)}
                        >
                          <span className="mi2 pri">
                            <Icon name={KIND_ICONS[memory.kind]} size={22} />
                          </span>
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <div className="mt">{memory.title}</div>
                            <div className="ms">{plainBody(memory.body)}</div>
                            <div className="mm">
                              {kindLabel(memory.kind)} · {count} links · {timeAgo(memory.updatedAt)}
                            </div>
                          </span>
                        </button>
                      )
                    })}
                  </>
                ) : null}

                {rest.length > 0 ? (
                  <>
                    <div className="sec" style={{ margin: '16px 8px 6px' }}>
                      <span className="eyebrow">EVERYTHING ELSE</span>
                      <span className="sec-line">Newest first</span>
                    </div>
                    {rest.map((memory) => {
                      const count = linkedNames(memory.body).length
                      return (
                        <button
                          key={memory.id}
                          type="button"
                          className={`mrow${selected?.id === memory.id ? ' on' : ''}`}
                          onClick={() => selectMemory(memory.id)}
                        >
                          <span className="mi2">
                            <Icon name={KIND_ICONS[memory.kind]} size={22} />
                          </span>
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <div className="mt">{memory.title}</div>
                            <div className="ms">{plainBody(memory.body)}</div>
                            <div className="mm">
                              {kindLabel(memory.kind)} · {count} links · {timeAgo(memory.updatedAt)}
                            </div>
                          </span>
                        </button>
                      )
                    })}
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
                </div>
                <button
                  type="button"
                  className="ib tonal"
                  aria-label="Delete page"
                  onClick={() => setDeleting(selected)}
                >
                  <Icon name="trash" size={20} />
                </button>
              </div>

              {bodyNodes(selected)}

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
                <Button onClick={() => setEditing(selected)}>Edit page</Button>
                <Button
                  variant="tonal"
                  onClick={() => {
                    void agent.data.upsert('memory', { ...selected, pinned: !selected.pinned })
                  }}
                >
                  {selected.pinned ? 'Unpin' : 'Pin it'}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {editing !== null ? (
        <MemoryDialog memory={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      {deleting ? <DeleteDialog memory={deleting} onClose={() => setDeleting(null)} /> : null}
    </div>
  )
}
