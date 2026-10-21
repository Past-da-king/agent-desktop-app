import type { MemoryImportPreview, MemoryImportResult, MemoryKind, MemoryTidyPlan, MemoryTidyProgress } from '@agent/core'
import { useEffect, useState } from 'react'

import { agent } from '../bridge'
import { MEMORY_TYPES } from '../lib/memory'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'

type FileRef = { path: string; name: string }

type Step =
  | { at: 'choose' }
  | { at: 'preview'; file: FileRef; preview: MemoryImportPreview; plan: MemoryTidyPlan | null }
  | { at: 'importing'; file: FileRef; preview: MemoryImportPreview; plan: MemoryTidyPlan | null }
  | { at: 'done'; result: MemoryImportResult }
  | { at: 'tidy'; file: FileRef | null; includeAll: boolean }

/** How the file comes in: tidied by the agent into a short memory, or every note copied as it is. */
type Mode = 'tidy' | 'copy'

function n(value: number): string {
  return value.toLocaleString('en')
}

/** The per-kind lines of a preview or result, in Memory's order. Exported for tests. */
export function kindLines(byKind: Partial<Record<MemoryKind, number>>): Array<{ kind: MemoryKind; label: string; count: number }> {
  return MEMORY_TYPES.filter((type) => (byKind[type.kind] ?? 0) > 0).map((type) => ({
    kind: type.kind,
    label: type.label,
    count: byKind[type.kind] ?? 0,
  }))
}

/** Rough time for a tidy import: about a minute a step on a fast, cheap model. */
export function tidyTime(steps: number): string {
  if (steps <= 1) return 'about a minute'
  if (steps < 60) return `about ${steps} minutes`
  const hours = Math.round((steps / 60) * 2) / 2
  return `about ${hours === 1 ? 'an hour' : `${hours} hours`}`
}

/** The tidy import, live: where it has got to, and what can be done about it now. Exported for tests. */
export function useTidy(): MemoryTidyProgress | null {
  const [progress, setProgress] = useState<MemoryTidyProgress | null>(null)
  useEffect(() => {
    let live = true
    void agent.memory
      .tidyState()
      .then((state) => {
        if (live) setProgress(state)
      })
      .catch(() => undefined)
    const off = agent.memory.onTidy((next) => {
      if (live) setProgress(next)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return progress
}

function TidyProgressView({ progress }: { progress: MemoryTidyProgress | null }): JSX.Element {
  const steps = progress?.steps ?? 0
  const done = progress?.done ?? 0
  const pct = steps === 0 ? 0 : Math.round((done / steps) * 100)
  return (
    <div className="tidy">
      <div className="tidy-top">
        <span className="tidy-pct">{pct}%</span>
        <span className="tidy-line">
          {progress === null
            ? 'Starting...'
            : progress.running && progress.project !== ''
              ? `Project ${progress.projectIndex} of ${progress.projects}: ${progress.project}`
              : progress.message}
        </span>
      </div>
      <div className="tidy-bar" role="progressbar" aria-label="Tidying the memory bank" aria-valuemin={0} aria-valuemax={steps} aria-valuenow={done}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="import-kinds">
        <div className="import-kind">
          <span className="import-n">
            {n(done)}
            <span className="tidy-of">/{n(steps)}</span>
          </span>
          <span>steps</span>
        </div>
        <div className="import-kind">
          <span className="import-n">{n(progress?.added ?? 0)}</span>
          <span>pages added</span>
        </div>
        <div className="import-kind">
          <span className="import-n">{n(progress?.updated ?? 0)}</span>
          <span>pages updated</span>
        </div>
      </div>
      {progress !== null && progress.errors.length > 0 ? (
        <div className="tidy-errs">
          <b>
            {n(progress.failed)} {progress.failed === 1 ? 'step' : 'steps'} failed
          </b>
          {progress.errors.slice(-3).map((error, index) => (
            <span key={index}>
              {error.project}: {error.error}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function ImportDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const navigate = useUi((state) => state.navigate)
  const tidy = useTidy()
  const [step, setStep] = useState<Step>({ at: 'choose' })
  const [mode, setMode] = useState<Mode>('tidy')
  const [includeAll, setIncludeAll] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [undone, setUndone] = useState<{ removed: number; restored: number } | null>(null)

  // The shared Dialog sits inside the scrolling Settings page: opened from far down (Memory is low on the page) or
  // grown by a new step, it could start above the window. Each step brings it fully into view.
  useEffect(() => {
    document.querySelector('.import-dialog')?.scrollIntoView({ block: 'nearest' })
  }, [step.at, mode])

  // A tidy import still going (or stopped half way) is shown as soon as the dialog opens.
  useEffect(() => {
    if (step.at === 'choose' && tidy !== null && undone === null && (tidy.running || (!tidy.finished && tidy.done > 0))) {
      setStep({ at: 'tidy', file: null, includeAll: false })
    }
  }, [tidy, step.at, undone])

  const preview = async (file: FileRef, all: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const [result, plan] = await Promise.all([agent.memory.previewImport(file.path, all), agent.memory.previewTidy(file.path, all).catch(() => null)])
      if (!result.ok) {
        setError(result.message)
        setStep({ at: 'choose' })
      } else {
        setStep({ at: 'preview', file, preview: result, plan: plan?.ok === true ? plan : null })
        if (plan?.ok !== true) setMode('copy')
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read that file.')
    } finally {
      setBusy(false)
    }
  }

  const choose = async (): Promise<void> => {
    try {
      const file = await agent.memory.pickImport()
      if (file !== null) await preview(file, includeAll)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not open the file picker.')
    }
  }

  const run = async (): Promise<void> => {
    if (step.at !== 'preview') return
    if (mode === 'tidy') {
      setError('')
      try {
        await agent.memory.startTidy(step.file.path, includeAll)
        setUndone(null)
        setStep({ at: 'tidy', file: step.file, includeAll })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The agent could not start tidying.')
      }
      return
    }
    setStep({ at: 'importing', file: step.file, preview: step.preview, plan: step.plan })
    try {
      const result = await agent.memory.runImport(step.file.path, includeAll)
      if (!result.ok) {
        setError(result.message)
        setStep({ at: 'preview', file: step.file, preview: step.preview, plan: step.plan })
        return
      }
      setStep({ at: 'done', result })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import stopped.')
      setStep({ at: 'preview', file: step.file, preview: step.preview, plan: step.plan })
    }
  }

  const resume = async (): Promise<void> => {
    if (step.at !== 'tidy') return
    setError('')
    if (step.file === null) {
      // After a restart the file has to be chosen again; the steps already done are skipped.
      try {
        const file = await agent.memory.pickImport()
        if (file === null) return
        await agent.memory.startTidy(file.path, step.includeAll)
        setStep({ at: 'tidy', file, includeAll: step.includeAll })
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'The agent could not carry on.')
      }
      return
    }
    try {
      await agent.memory.startTidy(step.file.path, step.includeAll)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The agent could not carry on.')
    }
  }

  const undo = async (): Promise<void> => {
    setBusy(true)
    try {
      setUndone(await agent.memory.undoTidy())
      setConfirmUndo(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not undo the import.')
    } finally {
      setBusy(false)
    }
  }

  const shown = step.at === 'preview' || step.at === 'importing' ? step.preview : step.at === 'done' ? step.result : null
  const writing = shown === null ? 0 : Object.values(shown.byKind).reduce((sum, count) => sum + (count ?? 0), 0)
  const plan = step.at === 'preview' || step.at === 'importing' ? step.plan : null
  const tidying = step.at === 'tidy'
  const running = tidy?.running === true
  const tidyDone = tidy?.finished === true && !running

  const heading =
    step.at === 'done'
      ? 'Your memory is in'
      : tidying
        ? undone !== null
          ? 'The import is undone'
          : running
            ? 'Your agent is tidying your memory'
            : tidyDone
              ? 'Your memory is tidied'
              : 'Tidying stopped'
        : 'Bring in a memory bank'
  const lead =
    step.at === 'done'
      ? `${step.result.message} It took ${(step.result.ms / 1000).toFixed(1)} seconds.`
      : tidying
        ? undone !== null
          ? `${n(undone.removed)} ${undone.removed === 1 ? 'page' : 'pages'} it added are gone and ${n(undone.restored)} it changed are back as they were.`
          : running
            ? 'It reads your notes project by project and writes one page per project, the decisions with their reasons, how-tos and people. It carries on if you close this window.'
            : tidyDone
              ? "Every page it wrote is in Memory, and each change is in Memory's change log."
              : 'What it already wrote stays. Carry on and it picks up at the next step.'
        : 'Choose a JSON export of memories. Keys, passwords and tokens are taken out on the way in.'

  return (
    <Dialog label="Import a memory bank" onClose={onClose} labelledBy="import-title" className="import-dialog">
      <div>
        <span className="eyebrow">MEMORY</span>
        <h2 className="h2" id="import-title" style={{ marginTop: 6 }}>
          {heading}
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          {lead}
        </p>
      </div>

      {step.at === 'choose' ? (
        <button type="button" className="import-pick" onClick={() => void choose()} disabled={busy}>
          <span className="mi2 pri" style={{ width: 44, height: 44 }}>
            <Icon name="folder" size={22} />
          </span>
          <span className="import-pick-t">
            <b>{busy ? 'Reading the file...' : 'Choose a file'}</b>
            <span>A .json memory export</span>
          </span>
        </button>
      ) : null}

      {step.at === 'preview' || step.at === 'importing' ? (
        <div className="import-file">
          <Icon name="folder" size={16} />
          <span>{step.file.name}</span>
          <span className="muted">from {step.preview.source}</span>
        </div>
      ) : null}

      {(step.at === 'preview' || step.at === 'importing') && plan !== null ? (
        <div className="import-modes" role="radiogroup" aria-label="How to bring it in">
          <button type="button" role="radio" aria-checked={mode === 'tidy'} className={`import-mode${mode === 'tidy' ? ' on' : ''}`} onClick={() => setMode('tidy')} disabled={step.at === 'importing'}>
            <span className="import-mode-h">
              <b>Tidy it with the agent</b>
              <span className="pill pri">Recommended</span>
            </span>
            <span>
              Your agent reads {n(plan.notes)} notes in {n(plan.projects)} {plan.projects === 1 ? 'project' : 'projects'} and writes a short memory: one page per project with where it stands, decisions with the why,
              how-tos and people. {n(plan.steps)} {plan.steps === 1 ? 'step' : 'steps'} on your model, {tidyTime(plan.steps)}, in the background.
            </span>
          </button>
          <button type="button" role="radio" aria-checked={mode === 'copy'} className={`import-mode${mode === 'copy' ? ' on' : ''}`} onClick={() => setMode('copy')} disabled={step.at === 'importing'}>
            <span className="import-mode-h">
              <b>Copy every note as it is</b>
            </span>
            <span>
              {n(writing)} notes come in one by one, in a few seconds, with no model. Repeats and old notes stay as they were written.
            </span>
          </button>
        </div>
      ) : null}

      {shown !== null && (mode === 'copy' || plan === null || step.at === 'done') ? (
        <div className="import-sum">
          <div className="import-kinds">
            {kindLines(shown.byKind).map((line) => (
              <div className="import-kind" key={line.kind}>
                <span className="import-n">{n(line.count)}</span>
                <span>{line.label}</span>
              </div>
            ))}
          </div>
          {step.at === 'done' ? (
            <p className="small muted">
              {n(step.result.added)} new, {n(step.result.updated)} updated, {n(step.result.unchanged)} already here
              {step.result.deletedHere > 0 ? `, ${n(step.result.deletedHere)} you deleted here left alone` : ''}
              {step.result.redacted > 0 ? `, ${n(step.result.redacted)} secrets taken out` : ''}. Importing the same file again
              changes nothing.
            </p>
          ) : (
            <p className="small muted">
              {n(writing)} of {n(shown.total)} will come in.
              {shown.skippedRetired + shown.skippedTransient > 0
                ? ` Left out: ${n(shown.skippedRetired)} retired and ${n(shown.skippedTransient)} short-lived notes (state and events).`
                : ''}
              {shown.invalid > 0 ? ` ${n(shown.invalid)} could not be read.` : ''}
            </p>
          )}
        </div>
      ) : null}

      {(step.at === 'preview' || step.at === 'importing') && plan !== null && mode === 'tidy' ? (
        <p className="small muted">
          Left out: {n(plan.retired)} retired notes and {n(plan.olderState)} older day-to-day notes that newer ones replace.
        </p>
      ) : null}

      {step.at === 'preview' || step.at === 'importing' ? (
        <div className="import-toggle">
          <div className="import-toggle-t">
            <b>Include retired and short-lived notes</b>
            <span>Old, replaced memories and day-to-day state. Usually best left out.</span>
          </div>
          <Switch
            on={includeAll}
            label="Include retired and short-lived notes"
            onToggle={(next) => {
              setIncludeAll(next)
              if (step.at === 'preview') void preview(step.file, next)
            }}
          />
        </div>
      ) : null}

      {tidying && undone === null ? <TidyProgressView progress={tidy} /> : null}

      {confirmUndo ? (
        <div className="tidy-confirm" role="alert">
          <b>Undo the whole import?</b>
          <span>
            The {n(tidy?.added ?? 0)} pages it added go, and the {n(tidy?.updated ?? 0)} pages it changed go back to how they were. Pages you made yourself stay.
          </span>
        </div>
      ) : null}

      {error !== '' ? (
        <p className="small" role="alert" style={{ color: 'var(--err)' }}>
          {error}
        </p>
      ) : null}

      <div className="dialog-actions">
        {step.at === 'done' ? (
          <>
            <Button variant="text" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={() => {
                onClose()
                navigate({ page: 'memory' })
              }}
            >
              Open Memory
            </Button>
          </>
        ) : tidying ? (
          confirmUndo ? (
            <>
              <Button variant="text" onClick={() => setConfirmUndo(false)} disabled={busy}>
                Keep it
              </Button>
              <Button className="danger" onClick={() => void undo()} disabled={busy}>
                {busy ? 'Undoing...' : 'Undo the import'}
              </Button>
            </>
          ) : undone !== null ? (
            <>
              <Button variant="text" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="tonal"
                onClick={() => {
                  setUndone(null)
                  setStep({ at: 'choose' })
                }}
              >
                Choose a file
              </Button>
            </>
          ) : running ? (
            <>
              <Button variant="text" onClick={() => void agent.memory.stopTidy()}>
                Stop
              </Button>
              <Button onClick={onClose}>Keep going in the background</Button>
            </>
          ) : (
            <>
              {tidy?.canUndo === true ? (
                <Button variant="text" onClick={() => setConfirmUndo(true)}>
                  Undo the import
                </Button>
              ) : null}
              {!tidyDone || (tidy?.failed ?? 0) > 0 ? (
                <Button variant="tonal" onClick={() => void resume()}>
                  {tidyDone ? 'Retry failed steps' : step.file === null ? 'Choose the file to carry on' : 'Carry on'}
                </Button>
              ) : null}
              <Button
                onClick={() => {
                  onClose()
                  navigate({ page: 'memory' })
                }}
              >
                Open Memory
              </Button>
            </>
          )
        ) : (
          <>
            <Button variant="text" onClick={onClose}>
              Cancel
            </Button>
            {step.at === 'choose' ? null : (
              <Button variant="tonal" onClick={() => setStep({ at: 'choose' })} disabled={step.at === 'importing'}>
                Another file
              </Button>
            )}
            <Button onClick={() => void run()} disabled={step.at !== 'preview' || busy || (mode === 'copy' ? writing === 0 : plan === null || plan.steps === 0)}>
              {step.at === 'importing'
                ? 'Importing...'
                : mode === 'tidy' && plan !== null
                  ? 'Start tidying'
                  : writing > 0
                    ? `Import ${n(writing)}`
                    : 'Import'}
            </Button>
          </>
        )}
      </div>
    </Dialog>
  )
}

/** Settings > Memory: import a bank. End of day runs as a built-in routine, so its time lives on Routines. */
export function MemorySettings(): JSX.Element {
  const [importing, setImporting] = useState(false)
  const navigate = useUi((state) => state.navigate)
  const tidy = useTidy()
  const tidyLine =
    tidy?.running === true ? `Your agent is tidying your memory bank: step ${n(tidy.done)} of ${n(tidy.steps)}` : tidy !== null && !tidy.finished && tidy.done > 0 ? `Tidying stopped at step ${n(tidy.done)} of ${n(tidy.steps)}` : ''

  return (
    <section>
      <SectionHeader eyebrow="MEMORY" line="What your agent remembers between chats" />
      <div className="card" style={{ padding: 10 }}>
        <div className="rowc">
          <div className="ri">
            <Icon name="memory" size={22} />
          </div>
          <div className="rt">
            <b>Import a memory bank</b>
            <span>{tidyLine === '' ? 'Bring in memories from another agent, from a JSON export' : tidyLine}</span>
          </div>
          <Button variant="tonal" size="sm" onClick={() => setImporting(true)}>
            {tidyLine === '' ? 'Import' : 'Open'}
          </Button>
        </div>
        <div className="rowc">
          <div className="ri">
            <Icon name="sync" size={22} />
          </div>
          <div className="rt">
            <b>End of day</b>
            <span>End of day runs as a routine. Change it or remove it in Routines.</span>
          </div>
          <Button variant="tonal" size="sm" onClick={() => navigate({ page: 'routines' })}>
            Open Routines
          </Button>
        </div>
      </div>
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </section>
  )
}
