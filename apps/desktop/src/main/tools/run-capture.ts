/**
 * How a tool hands the chat the full story of what it ran, beside the text the model reads.
 *
 * A tool records its run against the very input object it was called with. The loop (and the plan-mode tool
 * server) hands that same object to the activity row when the call finishes, so the record always lands on the
 * row for that call, even when several calls run at once. Nothing is kept once the row has taken it.
 */
import type { JsonObject } from '@agent/core'

import { RUN_STREAM_CAP, type RunKind, type RunState } from '../../shared/run-record'

/** What a tool knows about its own run. The row adds what is missing and redacts it before it is stored. */
export interface ToolRun {
  kind: RunKind
  input: string
  label: string
  cwd?: string
  stdout: string
  stderr: string
  exitCode: number | null
  ms: number
  state: RunState
  trimmed: boolean
  note?: string
}

const runs = new WeakMap<object, ToolRun>()

export function recordRun(input: JsonObject, run: ToolRun): void {
  runs.set(input, run)
}

/** The run a tool recorded for this call's input, once. */
export function takeRun(input: JsonObject): ToolRun | undefined {
  const run = runs.get(input)
  runs.delete(input)
  return run
}

/**
 * One output stream kept for the person: the first half of the cap as it arrives and a rolling last half, so a
 * long build log keeps both how it started and how it ended. Separate from what the model gets.
 */
export class StreamCapture {
  total = 0
  private head = ''
  private tail = ''
  private readonly half: number

  constructor(cap = RUN_STREAM_CAP) {
    this.half = Math.floor(cap / 2)
  }

  push(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    this.total += text.length
    if (this.head.length < this.half) {
      const room = this.half - this.head.length
      this.head += text.slice(0, room)
      const rest = text.slice(room)
      if (rest !== '') this.tail = rest.slice(-this.half)
      return
    }
    this.tail = (this.tail + text).slice(-this.half)
  }

  trimmed(): boolean {
    return this.total > this.head.length + this.tail.length
  }

  text(): string {
    if (!this.trimmed()) return this.head + this.tail
    const gone = this.total - this.head.length - this.tail.length
    return `${this.head}\n[output trimmed: ${gone.toLocaleString('en-US')} characters left out here]\n${this.tail}`
  }
}
