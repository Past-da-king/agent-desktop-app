/**
 * A tool step that ran something on this computer: a shell command, a program, or a file read or write.
 *
 * In the chat it is one line: what kind, a monospace snippet of the exact command (cut with an ellipsis), how it
 * ended and how long it took. Clicking the line opens it in place: the exact command as the agent wrote it, the
 * folder, the exit code and time, then everything it printed with stderr marked, long output folded to its first
 * and last lines behind "Show all", and a copy button for the command and for each output.
 */
import { useEffect, useId, useRef, useState } from 'react'

import { foldLines, formatMs, runTag, snippetOf, statusText, type RunRecord } from '../../shared/run-record'
import { Icon, type IconName } from '../ui/Icon'
import { toast } from '../state/useToast'

/** Copy text to the clipboard: the async API first, then the old textarea way (some focus states refuse it). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

function CopyButton({ text, what }: { text: string; what: string }): JSX.Element {
  const [done, setDone] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )
  return (
    <button
      type="button"
      className="run-copy"
      aria-label={`Copy ${what}`}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) {
            toast(`Could not copy the ${what}.`)
            return
          }
          setDone(true)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setDone(false), 1600)
        })
      }}
    >
      <Icon name={done ? 'check' : 'copy'} size={16} />
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

/** One stream of output: all of it when short; first and last lines with "Show all" when long. */
function Output({ title, text, tone, what }: { title: string; text: string; tone?: 'err'; what: string }): JSX.Element {
  const [all, setAll] = useState(false)
  const folded = foldLines(text)
  return (
    <div className={`run-sec${tone === 'err' ? ' err' : ''}`}>
      <div className="run-sec-h">
        <span className="eyebrow mute">{title}</span>
        {text !== '' ? <CopyButton text={text} what={what} /> : null}
      </div>
      {text === '' ? (
        <div className="run-none">No output</div>
      ) : folded === null || all ? (
        <>
          <pre className="run-pre out">{text}</pre>
          {folded !== null ? (
            <button type="button" className="run-more" onClick={() => setAll(false)}>
              Show less
            </button>
          ) : null}
        </>
      ) : (
        <div className="run-fold">
          <pre className="run-pre out head">{folded.head}</pre>
          <button type="button" className="run-more" onClick={() => setAll(true)}>
            Show all {folded.total} lines ({folded.hidden} hidden)
          </button>
          <pre className="run-pre out tail">{folded.tail}</pre>
        </div>
      )}
    </div>
  )
}

const ICONS: Record<RunRecord['kind'], IconName> = { shell: 'term', code: 'code', file: 'doc' }

function inputTitle(run: RunRecord): string {
  if (run.kind === 'shell') return 'Command'
  if (run.kind === 'code') return run.label === 'python' ? 'Python program' : run.label === 'javascript' ? 'JavaScript program' : 'Program'
  return run.label === 'Find' || run.label === 'List' ? 'Folder' : 'File'
}

function outputTitle(run: RunRecord): string {
  if (run.kind !== 'file') return run.merged === true ? 'Output and errors' : 'Output'
  switch (run.label) {
    case 'Read':
      return 'What it read'
    case 'Write':
      return 'What it wrote'
    case 'List':
      return 'What is in it'
    case 'Find':
      return 'What it found'
    default:
      return 'Result'
  }
}

/** A run whose row stopped "running" without its record finishing (the app closed mid-run). */
function settled(run: RunRecord, status: string): RunRecord {
  if (run.state !== 'running' || status === 'running') return run
  return { ...run, state: 'stopped', note: run.note ?? 'Interrupted before it finished.' }
}

export function RunDetail({ run, id }: { run: RunRecord; id: string }): JSX.Element {
  const facts = [
    run.kind === 'shell' && run.label !== '' && run.label !== 'Shell' ? run.label : '',
    run.exitCode !== null ? `exit ${run.exitCode}` : '',
    run.state === 'running' ? 'still running' : run.ms === null ? '' : `ran in ${formatMs(run.ms)}`,
    run.waitedMs !== undefined ? `waited ${formatMs(run.waitedMs)} for you first` : '',
  ].filter((fact) => fact !== '')
  return (
    <div className="run-body" id={id}>
      <div className="run-sec">
        <div className="run-sec-h">
          <span className="eyebrow mute">{inputTitle(run)}</span>
          <CopyButton text={run.input} what={run.kind === 'file' ? 'path' : run.kind === 'code' ? 'program' : 'command'} />
        </div>
        <pre className="run-pre cmd">{run.input === '' ? ' ' : run.input}</pre>
        <div className="run-facts">
          {run.cwd !== undefined ? (
            <span>
              In <code>{run.cwd}</code>
            </span>
          ) : null}
          {run.target !== undefined ? (
            <span>
              {run.label === 'Find' ? 'Looking for' : 'To'} <code>{run.target}</code>
            </span>
          ) : null}
          {facts.map((fact) => (
            <span key={fact}>{fact}</span>
          ))}
        </div>
      </div>
      {run.note !== undefined ? <div className={`run-note ${run.state}`}>{run.note}</div> : null}
      {run.state === 'running' || run.state === 'declined' ? null : (
        <>
          <Output title={outputTitle(run)} text={run.stdout} what="output" />
          {run.stderr !== '' ? <Output title={run.kind === 'file' ? 'Problem' : 'Errors (stderr)'} text={run.stderr} tone="err" what="errors" /> : null}
        </>
      )}
      {run.trimmed ? (
        <div className="run-trim">Output trimmed: it was very long, so the first and last parts are kept and the middle is left out.</div>
      ) : null}
    </div>
  )
}

/** The chat line for one run, opening to its full record. */
export function RunStep({ run: raw, status, by }: { run: RunRecord; status: string; by?: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const run = settled(raw, status)
  const running = run.state === 'running'
  const snippet = snippetOf(run.input) || '(empty)'
  const time = running ? '' : formatMs(run.ms)
  const tone = run.state === 'ok' ? 'ok' : run.state === 'failed' ? 'bad' : running ? 'live' : run.state === 'timeout' ? 'warn' : 'mute'
  return (
    <div className={`run${open ? ' open' : ''}`}>
      <button
        type="button"
        className="run-row"
        aria-expanded={open}
        aria-controls={bodyId}
        title={by === undefined ? undefined : `By ${by}`}
        onClick={() => setOpen((value) => !value)}
      >
        <i className={`run-ic ${tone}`}>
          <span className={running ? 'spin' : ''}>
            <Icon name={running ? 'sync' : ICONS[run.kind]} size={16} />
          </span>
        </i>
        <span className="tool-tag">{runTag(run)}</span>
        <code className="run-snip">{snippet}</code>
        <span className={`run-st ${tone}`}>{statusText(run)}</span>
        {time !== '' ? <span className="run-ms">{time}</span> : null}
        <span className="run-chev">
          <Icon name={open ? 'chevd' : 'chev'} size={16} />
        </span>
      </button>
      {open ? <RunDetail run={run} id={bodyId} /> : null}
    </div>
  )
}
