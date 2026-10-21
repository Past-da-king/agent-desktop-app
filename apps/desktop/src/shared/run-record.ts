/**
 * What the agent actually ran: the exact command, code or file path, where, how it ended, how long it took, and
 * what came back. The main process stores one on each activity row (`meta.run`) for shell_run, run_code and the
 * file tools; the chat draws it as a one-line snippet that opens to the full record.
 *
 * Pure TypeScript, shared by the main process and the renderer, so it is unit tested directly.
 */

/** shell, code and file runs; `tool` is any other tool call (browser, memory, helpers): its input and what came back. */
export type RunKind = 'shell' | 'code' | 'file' | 'tool'

/** running while it works; ok and failed by exit code; the rest say why it never finished. */
export type RunState = 'running' | 'ok' | 'failed' | 'timeout' | 'stopped' | 'declined'

export interface RunRecord {
  kind: RunKind
  /** The command line, the whole program, or the file path, exactly as the agent wrote it (secrets redacted). */
  input: string
  /** A short word for what kind of run: "PowerShell 7", "python", "Read", "Write". */
  label: string
  /** The folder a command ran in. */
  cwd?: string
  /** For a file write: the folder or file it went to, when that is not the input itself. */
  target?: string
  /** What came back on standard output (or the file text read or written). */
  stdout: string
  /** What came back on standard error. */
  stderr: string
  exitCode: number | null
  /** Milliseconds from start to finish; null while it runs. */
  ms: number | null
  state: RunState
  /** True when the input or the output was longer than the cap and the middle was left out. */
  trimmed: boolean
  /** Listed rows carry only the head of long output; the full row has the rest (shared/light-row.ts). */
  more?: boolean
  /** One plain line when it did not run normally ("Timed out after 60 seconds"). */
  note?: string
  /** True when stdout and stderr came back as one stream (Claude Code's own shell), so stdout holds both. */
  merged?: boolean
  /** How long it waited for the person's approval before it ran (not counted in ms), when that is known. */
  waitedMs?: number
}

/** The most the record keeps of any one stream: the first and last halves of this, the middle cut. */
export const RUN_STREAM_CAP = 24_000
/** Other tool calls are many and chatty (page snapshots), so each keeps less. */
export const TOOL_STREAM_CAP = 8_000

const KINDS = new Set<RunKind>(['shell', 'code', 'file', 'tool'])
const STATES = new Set<RunState>(['running', 'ok', 'failed', 'timeout', 'stopped', 'declined'])

/** The run on an activity row's meta, or null when the row has none (older rows, other tools). */
export function runFromMeta(meta: Record<string, unknown>): RunRecord | null {
  const raw = meta['run']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const kind = r['kind']
  const state = r['state']
  if (typeof kind !== 'string' || !KINDS.has(kind as RunKind)) return null
  if (typeof state !== 'string' || !STATES.has(state as RunState)) return null
  const text = (key: string): string => (typeof r[key] === 'string' ? (r[key] as string) : '')
  const num = (key: string): number | null =>
    typeof r[key] === 'number' && Number.isFinite(r[key]) ? (r[key] as number) : null
  const record: RunRecord = {
    kind: kind as RunKind,
    input: text('input'),
    label: text('label'),
    stdout: text('stdout'),
    stderr: text('stderr'),
    exitCode: num('exitCode'),
    ms: num('ms'),
    state: state as RunState,
    trimmed: r['trimmed'] === true,
    ...(r['more'] === true ? { more: true } : {}),
  }
  if (text('cwd') !== '') record.cwd = text('cwd')
  if (text('target') !== '') record.target = text('target')
  if (text('note') !== '') record.note = text('note')
  if (r['merged'] === true) record.merged = true
  const waited = num('waitedMs')
  if (waited !== null && waited > 0) record.waitedMs = waited
  return record
}

/**
 * Keep a long text's start and end, which is where commands print what matters (what they did, then how it
 * ended), and say how much of the middle is gone.
 */
export function capText(text: string, cap = RUN_STREAM_CAP): { text: string; trimmed: boolean } {
  if (text.length <= cap) return { text, trimmed: false }
  const half = Math.floor(cap / 2)
  const head = text.slice(0, half)
  const tail = text.slice(text.length - half)
  const gone = text.length - head.length - tail.length
  return { text: `${head}\n[output trimmed: ${gone.toLocaleString('en-US')} characters left out here]\n${tail}`, trimmed: true }
}

/** "120 ms", "4.2 s", "38 s", "2 min 5 s". */
export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)} s`
  if (seconds < 60) return `${Math.round(seconds)} s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** The input as one line for the chat row: the first non-empty line, runs of spaces folded, more lines marked. */
export function snippetOf(input: string): string {
  const lines = input.split(/\r?\n/).map((line) => line.trim())
  const first = lines.find((line) => line !== '') ?? ''
  const more = lines.filter((line) => line !== '').length > 1
  const flat = first.replace(/\s+/g, ' ')
  return more ? `${flat} ...` : flat
}

/** How the row says the run ended: "ok", "failed, exit 1", "timed out". */
export function statusText(run: RunRecord): string {
  switch (run.state) {
    case 'running':
      return 'running'
    case 'ok':
      return 'ok'
    case 'failed':
      return run.exitCode === null ? 'failed' : `failed, exit ${run.exitCode}`
    case 'timeout':
      return 'timed out'
    case 'stopped':
      return 'stopped'
    case 'declined':
      return 'not run'
  }
}

/** What a run's kind is called on its tag. */
export function runTag(run: RunRecord): string {
  if (run.kind === 'shell') return 'Shell'
  if (run.kind === 'code') return 'Code'
  if (run.kind === 'tool') return run.label === '' ? 'Tool' : run.label
  return run.label === '' ? 'File' : run.label
}

export interface Folded {
  head: string
  tail: string
  /** How many lines sit between head and tail. */
  hidden: number
  total: number
}

/** Long output shows its first and last lines with the middle behind "Show all". Null when it is short enough. */
export function foldLines(text: string, keep = 6, threshold = 16): Folded | null {
  const lines = text.replace(/\n+$/, '').split('\n')
  if (lines.length <= threshold) return null
  return {
    head: lines.slice(0, keep).join('\n'),
    tail: lines.slice(lines.length - keep).join('\n'),
    hidden: lines.length - keep * 2,
    total: lines.length,
  }
}
