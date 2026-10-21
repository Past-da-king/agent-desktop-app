import type { MemoryImportPreview, MemoryImportResult, MemoryKind } from '@agent/core'
import { useState } from 'react'

import { agent } from '../bridge'
import { MEMORY_TYPES } from '../lib/memory'
import { useUi } from '../state/useUi'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Icon } from '../ui/Icon'
import { SectionHeader } from '../ui/SectionHeader'
import { Switch } from '../ui/Switch'

type Step =
  | { at: 'choose' }
  | { at: 'preview'; file: { path: string; name: string }; preview: MemoryImportPreview }
  | { at: 'importing'; file: { path: string; name: string }; preview: MemoryImportPreview }
  | { at: 'done'; result: MemoryImportResult }

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

export function ImportDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const navigate = useUi((state) => state.navigate)
  const [step, setStep] = useState<Step>({ at: 'choose' })
  const [includeAll, setIncludeAll] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const preview = async (file: { path: string; name: string }, all: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const result = await agent.memory.previewImport(file.path, all)
      if (!result.ok) {
        setError(result.message)
        setStep({ at: 'choose' })
      } else {
        setStep({ at: 'preview', file, preview: result })
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
    setStep({ at: 'importing', file: step.file, preview: step.preview })
    try {
      const result = await agent.memory.runImport(step.file.path, includeAll)
      if (!result.ok) {
        setError(result.message)
        setStep({ at: 'preview', file: step.file, preview: step.preview })
        return
      }
      setStep({ at: 'done', result })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The import stopped.')
      setStep({ at: 'preview', file: step.file, preview: step.preview })
    }
  }

  const shown = step.at === 'preview' || step.at === 'importing' ? step.preview : step.at === 'done' ? step.result : null
  const writing = shown === null ? 0 : Object.values(shown.byKind).reduce((sum, count) => sum + (count ?? 0), 0)

  return (
    <Dialog label="Import a memory bank" onClose={onClose} labelledBy="import-title" className="import-dialog">
      <div>
        <span className="eyebrow">MEMORY</span>
        <h2 className="h2" id="import-title" style={{ marginTop: 6 }}>
          {step.at === 'done' ? 'Your memory is in' : 'Bring in a memory bank'}
        </h2>
        <p className="lead" style={{ marginTop: 8 }}>
          {step.at === 'done'
            ? `${step.result.message} It took ${(step.result.ms / 1000).toFixed(1)} seconds.`
            : 'Choose a JSON export of memories. People become people, how-tos stay how-tos, decisions stay decisions, and references and facts become facts. Keys, passwords and tokens are taken out on the way in.'}
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

      {shown !== null ? (
        <div className="import-sum">
          {step.at === 'preview' || step.at === 'importing' ? (
            <div className="import-file">
              <Icon name="folder" size={16} />
              <span>{step.file.name}</span>
              <span className="muted">from {shown.source}</span>
            </div>
          ) : null}
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
            <Button onClick={() => void run()} disabled={step.at !== 'preview' || writing === 0 || busy}>
              {step.at === 'importing' ? 'Importing...' : writing > 0 ? `Import ${n(writing)}` : 'Import'}
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
            <span>Bring in memories from another agent, from a JSON export</span>
          </div>
          <Button variant="tonal" size="sm" onClick={() => setImporting(true)}>
            Import
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
