import type { MemoryRow, MemoryVersion } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { kindLabel } from '../lib/format'
import { toast } from '../state/useToast'
import { Pill } from '../ui/bits'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { Markdown } from '../ui/Markdown'

const FIELD_LABELS: Record<string, string> = {
  created: 'Written',
  deleted: 'Deleted',
  title: 'Title',
  body: 'Text',
  kind: 'Kind',
  topics: 'Topics',
  status: 'Open or closed',
  aliases: 'Other names',
  pinned: 'Pin',
}

/** A page's kept versions, newest first, read again whenever the page changes. Empty while loading or when it has none. */
export interface MemoryHistoryState {
  versions: MemoryVersion[]
  /** Why the history could not be read; empty when the last read worked. */
  error: string
  loading: boolean
  retry: () => void
}

/** A page's versions, with the failure kept apart from "no versions yet" so the dialog can say which it is. */
export function useMemoryHistoryState(memoryId: string | null, changedAt: number): MemoryHistoryState {
  const [versions, setVersions] = useState<MemoryVersion[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(memoryId !== null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (memoryId === null) {
      setVersions([])
      setError('')
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    void agent.memory
      .history(memoryId)
      .then((list) => {
        if (!live) return
        setVersions(list)
        setError('')
      })
      .catch((cause: unknown) => {
        if (!live) return
        setVersions([])
        setError(historyError(cause))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [memoryId, changedAt, attempt])
  return { versions, error, loading, retry: () => setAttempt((n) => n + 1) }
}

/** The line shown when the history cannot be read. Never empty, so a failure can not pass for "no changes yet". */
export function historyError(cause: unknown): string {
  const why = cause instanceof Error ? cause.message.trim() : ''
  return why === '' ? 'The history could not be read.' : `The history could not be read: ${why}`
}

export function useMemoryHistory(memoryId: string | null, changedAt: number): MemoryVersion[] {
  return useMemoryHistoryState(memoryId, changedAt).versions
}

export function whenLabel(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** "Version 3, changed by agent, 19 Oct, 17:42": the line that says a page really was updated, and by whom. */
export function versionLine(latest: MemoryVersion | undefined): string {
  if (latest === undefined) return ''
  const who = latest.by === 'earlier' ? 'before history was kept' : `by ${latest.by}`
  const when = new Date(latest.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return `Version ${latest.n}, ${latest.n === 1 ? 'written' : 'changed'} ${who}, ${when}`
}

function VersionEntry({
  version,
  newest,
  onRestore,
}: {
  version: MemoryVersion
  newest: boolean
  onRestore: (n: number) => void
}): JSX.Element {
  const [open, setOpen] = useState(newest)
  return (
    <li className={`mh-v${newest ? ' mh-now' : ''}`}>
      <span className="mh-dot" aria-hidden="true" />
      <div className="mh-card">
        <div className="mh-top">
          <b>Version {version.n}</b>
          {newest ? <Pill tone="pri">Now</Pill> : null}
          {version.status === 'closed' && !version.deleted ? <Pill tone="ok">Closed</Pill> : null}
          <span className="mh-when">{whenLabel(version.at)}</span>
        </div>
        <div className="mh-who">
          {version.by === 'earlier' ? 'As it was before history was kept' : `By ${version.by}`}
          {version.reason === '' ? null : <span className="mh-why">: {version.reason}</span>}
        </div>
        <div className="mh-changed" aria-label="What changed">
          {version.changed.map((field) => (
            <span key={field} className={`mh-field${field === 'deleted' ? ' del' : ''}`}>
              {FIELD_LABELS[field] ?? field}
            </span>
          ))}
        </div>
        {version.deleted ? null : (
          <>
            <button type="button" className="mh-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
              <Icon name={open ? 'chevd' : 'chev'} size={14} />
              {open ? 'Hide what it said' : 'Show what it said'}
            </button>
            {open ? (
              <div className="mh-said">
                <div className="mh-said-t">
                  {version.title}
                  <span className="muted"> · {kindLabel(version.kind)}</span>
                </div>
                <Markdown text={version.body} />
                {version.aliases !== '' ? <div className="small muted">Also called: {version.aliases}</div> : null}
                {version.topics !== '' ? <div className="small muted">Topics: {version.topics}</div> : null}
                {newest ? null : (
                  <div>
                    <Button variant="tonal" size="sm" onClick={() => onRestore(version.n)}>
                      <Icon name="sync" size={16} />
                      Bring this version back
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </li>
  )
}

/**
 * How one memory page got to where it is: every version, newest first, who made it, why, what changed and what it
 * said. Bringing an old version back adds a new version, so the history never loses anything.
 */
export function MemoryHistoryDialog({ memory, onClose }: { memory: MemoryRow; onClose: () => void }): JSX.Element {
  const { versions, error, loading, retry } = useMemoryHistoryState(memory.id, memory.updatedAt)
  const restore = (n: number): void => {
    void agent.memory
      .restoreVersion(memory.id, n)
      .then((done) => toast(done ? `Version ${n} is back, as a new version.` : 'That version could not be brought back.'))
      .catch((cause: unknown) => {
        const why = cause instanceof Error ? cause.message.trim() : ''
        toast(why === '' ? 'That version could not be brought back.' : `That version could not be brought back: ${why}`)
      })
  }
  return (
    <Dialog label={`History of ${memory.title}`} onClose={onClose} labelledBy="memory-history-title" className="mh-dialog">
      <div>
        <span className="eyebrow">HISTORY</span>
        <h2 className="h2" id="memory-history-title" style={{ marginTop: 6 }}>
          {memory.title}
        </h2>
        <p className="lead" style={{ marginTop: 6 }}>
          Every change, newest first: who made it, why, and what the page said.
        </p>
      </div>
      {error !== '' ? (
        <div className="banner mh-failed" role="alert">
          <span>{error}</span>{' '}
          <button type="button" className="linkish" onClick={retry}>
            Try again
          </button>
        </div>
      ) : loading && versions.length === 0 ? (
        <p className="muted">Reading the history...</p>
      ) : versions.length === 0 ? (
        <p className="muted">No changes yet. The next edit, by you or an agent, starts the history.</p>
      ) : (
        <ol className="mh-list">
          {versions.map((version, index) => (
            <VersionEntry key={version.n} version={version} newest={index === 0} onRestore={restore} />
          ))}
        </ol>
      )}
      <div className="dialog-actions">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Dialog>
  )
}
