import type { UpkeepChange, UpkeepReport, UpkeepSummary } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { timeAgo } from '../lib/format'
import { toast } from '../state/useToast'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon, type IconName } from '../ui/Icon'
import { Markdown } from '../ui/Markdown'

const ACTION_LABEL: Record<UpkeepChange['action'], string> = {
  where: 'Compiled',
  filed: 'Filed',
  merged: 'Merged',
  rewritten: 'Rewritten',
  dropped: 'Dropped',
}

const ACTION_ICON: Record<UpkeepChange['action'], IconName> = {
  where: 'sync',
  filed: 'plus',
  merged: 'link',
  rewritten: 'edit',
  dropped: 'trash',
}

/** One line for the card: when it last ran and what changed. Exported for tests. */
export function upkeepLine(report: UpkeepReport | null, at: number): string {
  if (report === null || at === 0) return 'Not run yet. It runs at the end of each day, or now.'
  return `Last run ${timeAgo(at)}. ${report.message}`
}

function useUpkeep(): [UpkeepSummary | null, (next: UpkeepSummary) => void] {
  const [summary, setSummary] = useState<UpkeepSummary | null>(null)
  useEffect(() => {
    let live = true
    void agent.memory
      .upkeep()
      .then((value) => {
        if (live) setSummary(value)
      })
      .catch(() => undefined)
    const off = agent.memory.onUpkeep(() => {
      void agent.memory
        .upkeep()
        .then((value) => {
          if (live) setSummary(value)
        })
        .catch(() => undefined)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return [summary, setSummary]
}

function ReportDialog({ summary, onClose }: { summary: UpkeepSummary; onClose: () => void }): JSX.Element {
  const showMemories = useUi((state) => state.showMemories)
  const [undoing, setUndoing] = useState<string | null>(null)
  const [earlier, setEarlier] = useState<number | null>(null)
  const report = summary.report
  const changes = report?.changes ?? []
  const history = [...summary.history].reverse()

  const undo = (change: UpkeepChange): void => {
    setUndoing(change.id)
    void agent.memory
      .undoChange(change.id)
      .then((done) => toast(done ? `Put "${change.title}" back the way it was.` : 'That change was already undone.'))
      .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not undo that.'))
      .finally(() => setUndoing(null))
  }

  return (
    <Dialog label="What changed in memory" onClose={onClose} labelledBy="upkeep-title" className="upkeep-dialog">
      <div>
        <span className="eyebrow">END OF DAY</span>
        <h2 className="h2" id="upkeep-title" style={{ marginTop: 6 }}>
          What changed in memory
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          {report === null ? 'Nothing has run yet.' : report.message}
        </p>
      </div>

      {changes.length === 0 ? null : (
        <div className="upkeep-list">
          {changes.map((change) => (
            <div className={`upkeep-row${change.undone === true ? ' undone' : ''}`} key={change.id}>
              <span className="mi2" style={{ width: 36, height: 36 }}>
                <Icon name={ACTION_ICON[change.action]} size={18} />
              </span>
              <div className="upkeep-t">
                <b>{change.title}</b>
                <span>
                  {ACTION_LABEL[change.action]}: {change.reason}
                  {change.undone === true ? ' (undone)' : ''}
                </span>
              </div>
              {change.action === 'dropped' ? null : (
                <Button variant="text" size="sm" onClick={() => showMemories([change.memoryId])}>
                  Open
                </Button>
              )}
              <Button
                variant="tonal"
                size="sm"
                disabled={change.undone === true || undoing === change.id}
                onClick={() => undo(change)}
              >
                {undoing === change.id ? 'Undoing...' : 'Undo'}
              </Button>
            </div>
          ))}
        </div>
      )}

      {history.length === 0 ? null : (
        <div>
          <span className="eyebrow mute">EARLIER DAYS</span>
          <p className="small muted" style={{ marginTop: 4 }}>
            Each day's "Where we are" replaces the one before. The older ones are kept here.
          </p>
          <div className="mem-chips" style={{ marginTop: 10 }}>
            {history.slice(0, 14).map((entry, index) => (
              <button
                key={`${entry.day}-${index}`}
                type="button"
                className={`chip${earlier === index ? ' on' : ''}`}
                onClick={() => setEarlier(earlier === index ? null : index)}
              >
                {entry.day}
              </button>
            ))}
          </div>
          {earlier !== null && history[earlier] !== undefined ? (
            <div className="mem-body" style={{ marginTop: 12 }}>
              <Markdown text={history[earlier]?.body ?? ''} />
            </div>
          ) : null}
        </div>
      )}

      <div className="dialog-actions">
        <Button onClick={onClose}>Done</Button>
      </div>
    </Dialog>
  )
}

/**
 * The end-of-day memory pass in the Memory view: when it last ran and what changed, Run now, and the report with
 * Undo for each change.
 */
export function MemoryUpkeep(): JSX.Element {
  const [summary, setSummary] = useUpkeep()
  const [running, setRunning] = useState(false)
  const [open, setOpen] = useState(false)

  const runNow = (): void => {
    setRunning(true)
    void agent.memory
      .runDaily()
      .then(async (report) => {
        setSummary(await agent.memory.upkeep())
        if (!report.ok) toast(report.message)
        setOpen(true)
      })
      .catch((cause: unknown) => toast(cause instanceof Error ? cause.message : 'Could not tidy memory just now.'))
      .finally(() => setRunning(false))
  }

  const report = summary?.report ?? null
  return (
    <div className="card upkeep-card">
      <div className="upkeep-head">
        <span className="mi2" style={{ width: 40, height: 40 }}>
          <Icon name="sync" size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <span className="eyebrow">END OF DAY</span>
          <div className="small muted upkeep-line">{upkeepLine(report, summary?.lastRunAt ?? 0)}</div>
        </div>
      </div>
      <div className="upkeep-actions">
        <Button size="sm" onClick={runNow} disabled={running}>
          {running ? 'Tidying...' : 'Run now'}
        </Button>
        <Button variant="tonal" size="sm" disabled={report === null} onClick={() => setOpen(true)}>
          See changes
        </Button>
      </div>
      {open && summary !== null ? <ReportDialog summary={summary} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}
