/**
 * The run record on a chat activity row (`meta.run`): what the agent actually ran and what came back, for
 * shell_run, run_code and the file tools. Built when a call starts (the command, so the row shows it while it
 * works) and again when it ends (output, exit code, time). Every text is redacted and capped here, so nothing the
 * logs would hide reaches the chat, the database or a synced device.
 */
import type { JsonObject, ToolCallBlock } from '@agent/core'

import { capText, snippetOf, type RunKind, type RunRecord, type RunState } from '../../shared/run-record'
import { redactSecrets } from '../logger'
import { takeRun, type ToolRun } from '../tools/run-capture'

const FILE_LABELS: Record<string, string> = {
  files_read: 'Read',
  files_write: 'Write',
  files_list: 'List',
  files_find: 'Find',
  files_move: 'Move',
}

/** The tools whose calls carry a run record. */
export function hasRunRecord(tool: string): boolean {
  return tool === 'shell_run' || tool === 'run_code' || tool in FILE_LABELS
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function kindOf(tool: string): RunKind {
  return tool === 'shell_run' ? 'shell' : tool === 'run_code' ? 'code' : 'file'
}

/** What the call itself says it will run, before anything comes back. */
function inputOf(call: ToolCallBlock): { input: string; label: string; cwd?: string; target?: string } {
  const input = call.input
  switch (call.name) {
    case 'shell_run': {
      const cwd = text(input['cwd']).trim()
      const shell = text(input['shell']).trim()
      return { input: text(input['command']), label: shell === '' ? 'Shell' : shell, ...(cwd === '' ? {} : { cwd }) }
    }
    case 'run_code':
      return { input: text(input['code']), label: text(input['language']) || 'code' }
    case 'files_find':
      return { input: text(input['root']), label: 'Find', target: text(input['pattern']) || '*' }
    case 'files_move':
      return { input: text(input['from']), label: 'Move', target: text(input['to']) }
    default:
      return { input: text(input['path']), label: FILE_LABELS[call.name] ?? 'File' }
  }
}

function clean(value: string): { text: string; trimmed: boolean } {
  return capText(redactSecrets(value))
}

/** Redact and cap every text in a record. */
function finish(record: RunRecord): RunRecord {
  const input = clean(record.input)
  const stdout = clean(record.stdout)
  const stderr = clean(record.stderr)
  const out: RunRecord = {
    ...record,
    input: input.text,
    stdout: stdout.text,
    stderr: stderr.text,
    trimmed: record.trimmed || input.trimmed || stdout.trimmed || stderr.trimmed,
  }
  if (record.cwd !== undefined) out.cwd = redactSecrets(record.cwd)
  if (record.target !== undefined) out.target = redactSecrets(record.target)
  if (record.note !== undefined) out.note = redactSecrets(record.note).slice(0, 400)
  return out
}

/** The record while the call runs: what it is running, nothing back yet. Null for tools without one. */
export function runStarted(call: ToolCallBlock): RunRecord | null {
  if (!hasRunRecord(call.name)) return null
  const what = inputOf(call)
  return finish({
    kind: kindOf(call.name),
    ...what,
    stdout: '',
    stderr: '',
    exitCode: null,
    ms: null,
    state: 'running',
    trimmed: false,
  })
}

const DECLINED = /did not approve|turned off/i
const FILE_FAILED =
  /^(There is no|You did not approve|Pass a full path|Pass the|That path contains|Could not|That is too much)|is a folder\.|is a file\.|is not a folder\.|is a binary file/

/** The finished record: the tool's own when it kept one, else read from the input and the result text. */
export function runFinished(
  call: ToolCallBlock,
  result: string,
  isError: boolean,
  startedAt: number,
  now = Date.now(),
): RunRecord | null {
  if (!hasRunRecord(call.name)) return null
  const what = inputOf(call)
  const kind = kindOf(call.name)
  const recorded: ToolRun | undefined = takeRun(call.input as JsonObject)
  const elapsed = Math.max(0, now - startedAt)

  if (recorded !== undefined) {
    return finish({
      ...what,
      ...recorded,
      // The file tools and code do not know a folder for every call; keep the one the call named.
      ...(recorded.cwd === undefined && what.cwd !== undefined ? { cwd: what.cwd } : {}),
      ...(what.target === undefined ? {} : { target: what.target }),
      label: recorded.label === '' ? what.label : recorded.label,
      state: isError ? 'failed' : recorded.state,
    })
  }

  const firstLine = result.split('\n')[0] ?? ''
  if (isError) {
    return finish({ kind, ...what, stdout: '', stderr: result, exitCode: null, ms: elapsed, state: 'failed', trimmed: false, note: firstLine })
  }
  if (DECLINED.test(firstLine)) {
    return finish({ kind, ...what, stdout: '', stderr: '', exitCode: null, ms: 0, state: 'declined', trimmed: false, note: firstLine })
  }

  if (kind === 'file') {
    const failed = FILE_FAILED.test(firstLine)
    let stdout = result
    // A read starts with "## name (3 KB)"; the person wants the text that was read.
    if (call.name === 'files_read' && firstLine.startsWith('## ')) stdout = result.split('\n').slice(1).join('\n')
    // A write says only "Wrote N characters": what it wrote is the content it was given.
    if (call.name === 'files_write' && !failed) stdout = text(call.input['content'])
    const state: RunState = failed ? 'failed' : 'ok'
    return finish({
      kind,
      ...what,
      stdout: failed ? '' : stdout,
      stderr: failed ? result : '',
      exitCode: null,
      ms: elapsed,
      state,
      trimmed: false,
      ...(call.name === 'files_write' && !failed ? { note: firstLine } : {}),
    })
  }

  // A shell or code result from a path that kept no record (an older tool server): "Exit 1\n<output>".
  const exit = /^Exit (-?\d+)$/.exec(firstLine)
  if (exit !== null) {
    const code = Number(exit[1])
    const body = result.split('\n').slice(1).join('\n')
    return finish({ kind, ...what, stdout: body === '(no output)' ? '' : body, stderr: '', exitCode: code, ms: elapsed, state: code === 0 ? 'ok' : 'failed', trimmed: false })
  }
  const timedOut = /^Timed out/.test(firstLine)
  const stopped = /^Stopped/.test(firstLine)
  return finish({
    kind,
    ...what,
    stdout: result.split('\n').slice(1).join('\n'),
    stderr: '',
    exitCode: null,
    ms: elapsed,
    state: timedOut ? 'timeout' : stopped ? 'stopped' : 'failed',
    trimmed: false,
    note: firstLine,
  })
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts[parts.length - 1] ?? path
}

function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`
}

/** The activity row's words for a run, redacted: "Ran git status", "Read notes.md". Null for other tools. */
export function describeRun(call: ToolCallBlock): string | null {
  if (!hasRunRecord(call.name)) return null
  const what = inputOf(call)
  switch (call.name) {
    case 'shell_run': {
      const line = snippetOf(redactSecrets(what.input))
      return line === '' ? 'Ran a command' : `Ran ${clip(line, 80)}`
    }
    case 'run_code':
      return `Ran ${what.label === 'python' ? 'Python' : what.label === 'javascript' ? 'JavaScript' : 'some'} code`
    case 'files_read':
      return `Read ${baseName(what.input)}`
    case 'files_write':
      return `Wrote ${baseName(what.input)}`
    case 'files_list':
      return `Looked in ${baseName(what.input)}`
    case 'files_find':
      return `Searched ${baseName(what.input)} for ${clip(what.target ?? '*', 40)}`
    case 'files_move':
      return `Moved ${baseName(what.input)}`
    default:
      return null
  }
}
